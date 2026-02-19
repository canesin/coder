import { z } from "zod";
import { resolvePpcommitLlm } from "../../config.js";
import {
  computeGitWorktreeFingerprint,
  detectDefaultBranch,
  runHostTests,
  runPpcommitScoped,
  upsertIssueCompletionBlock,
} from "../../helpers.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import {
  artifactPaths,
  ensureBranch,
  maybeCheckpointWip,
  requireExitZero,
  resolveRepoRoot,
} from "./_shared.js";

export default defineMachine({
  name: "develop.quality_review",
  description:
    "Review implementation, run ppcommit hygiene, execute tests. Hard gates on ppcommit + tests.",
  inputSchema: z.object({
    testCmd: z.string().default(""),
    testConfigPath: z.string().default(""),
    allowNoTests: z.boolean().default(false),
    ppcommitPreset: z.enum(["strict", "relaxed", "minimal"]).default("strict"),
  }),

  async execute(input, ctx) {
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};

    if (!state.steps.implemented) {
      throw new Error(
        "Precondition failed: implementation not complete. Run develop.implementation first.",
      );
    }

    const repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath);
    ensureBranch(repoRoot, state.branch);
    const baseBranch = state.baseBranch || detectDefaultBranch(repoRoot);

    const { agentName: reviewerName, agent: reviewerAgent } =
      ctx.agentPool.getAgent("reviewer", { scope: "repo" });
    const { agentName: committerName, agent: committerAgent } =
      ctx.agentPool.getAgent("committer", { scope: "repo" });
    const paths = artifactPaths(ctx.artifactsDir);

    const runReviewerPass = async (agentName, agent, ppSection, label) => {
      const prompt = `You are reviewing uncommitted changes for commit readiness.
Read ${paths.issue} to understand what was originally requested.

## Checklist

### 1. Scope Conformance
- Does the change ONLY implement what ${paths.issue} requested?
- Are there any unrequested features added? (Remove them)
- Are there any unrelated refactors? (Revert them)
- Were more files modified than necessary? (Consolidate if possible)

### 2. Completeness
- Is the implementation fully complete? No stubs, no TODOs, no placeholders
- Are there test bypasses or skipped tests? (Fix them)
- Does it solve the problem directly without workarounds?

### 3. Code Quality
- Is this the SIMPLEST solution that works?
- Are there unnecessary abstractions? (Inline them)
- Are there wrapper functions that just call one thing? (Inline them)
- Are there interfaces/base classes with single implementations? (Remove them)
- Are there configuration options for single use cases? (Remove them)

### 4. Comment Hygiene
Look for and REMOVE these comment patterns:
- Tutorial-style: "First we...", "Now we...", "Step N:"
- Restating code: "// increment counter" above counter++
- Obvious descriptions: "// Constructor" above constructor
- Narration: "Here we define...", "This function..."
Keep only: non-obvious logic explanations, workaround refs, performance notes

### 5. Backwards-Compat Hacks
Look for and REMOVE these patterns:
- Variables renamed to start with \`_\` but not used
- Re-exports of removed items for compatibility
- \`// removed\` or \`// deprecated\` comments for deleted code
- Empty functions kept for interface compatibility
If something is unused, DELETE it completely.

### 6. Correctness
- Edge cases handled appropriately
- No off-by-one errors
- Uses industry-standard libraries where appropriate
- Error handling only for errors that can actually occur

## ppcommit (commit hygiene)
${ppSection}

Then run the repo's standard lint/format/test commands and fix any failures.

Hard constraints:
- Never bypass tests or reduce coverage/quality
- If a command fails, fix the underlying issue and re-run until it passes
- Remove ALL unnecessary code, comments, and abstractions`;

      const res = await agent.execute(prompt, {
        timeoutMs: 1000 * 60 * 90,
      });
      requireExitZero(agentName, label, res);
    };

    // Initial ppcommit check (scoped to files changed since base branch)
    // Dynamic preset from input overrides the static config preset
    const ppcommitLlm = resolvePpcommitLlm(ctx.config);
    const ppcommitConfig = {
      ...ctx.config.ppcommit,
      ...ppcommitLlm,
      ...(input.ppcommitPreset ? { preset: input.ppcommitPreset } : {}),
    };
    const ppBefore = await runPpcommitScoped(
      repoRoot,
      baseBranch,
      ppcommitConfig,
    );
    state.steps.ppcommitInitiallyClean = ppBefore.exitCode === 0;
    ctx.log({ event: "ppcommit_before", exitCode: ppBefore.exitCode });
    saveState(ctx.workspaceDir, state);

    // Reviewer pass
    if (!state.steps.reviewerCompleted) {
      ctx.log({ event: "step5_review" });
      const ppOutput = (ppBefore.stdout || ppBefore.stderr || "").trim();
      const ppSection =
        ppBefore.exitCode === 0
          ? "ppcommit passed (no issues). Focus on code review."
          : `ppcommit found issues — fix ALL of them:\n---\n${ppOutput}\n---\n\nCoder will re-run ppcommit and fail hard if anything remains.`;
      await runReviewerPass(
        reviewerName,
        reviewerAgent,
        ppSection,
        "review pass",
      );
      state.steps.reviewerCompleted = true;
      saveState(ctx.workspaceDir, state);
    }

    // Hard gate: ppcommit retry loop
    const maxPpcommitRetries = 2;
    let ppAfter = await runPpcommitScoped(repoRoot, baseBranch, ppcommitConfig);
    ctx.log({
      event: "ppcommit_after",
      attempt: 0,
      exitCode: ppAfter.exitCode,
    });
    for (
      let attempt = 1;
      attempt <= maxPpcommitRetries && ppAfter.exitCode !== 0;
      attempt++
    ) {
      const ppAfterOutput = (ppAfter.stdout || ppAfter.stderr || "").trim();
      ctx.log({ event: "ppcommit_retry", attempt, exitCode: ppAfter.exitCode });
      const retrySection = `ppcommit still failing after review pass. Fix ALL remaining ppcommit issues:\n---\n${ppAfterOutput}\n---`;
      await runReviewerPass(
        committerName,
        committerAgent,
        retrySection,
        "committer pass",
      );
      ppAfter = await runPpcommitScoped(repoRoot, baseBranch, ppcommitConfig);
      ctx.log({ event: "ppcommit_after", attempt, exitCode: ppAfter.exitCode });
    }
    if (ppAfter.exitCode !== 0) {
      throw new Error(
        `ppcommit still reports issues after ${committerName} pass:\n${ppAfter.stdout || ppAfter.stderr}`,
      );
    }
    state.steps.ppcommitClean = true;
    saveState(ctx.workspaceDir, state);

    // Hard gate: tests must pass
    const testRes = await runHostTests(repoRoot, {
      testCmd: input.testCmd || ctx.config.test.command,
      testConfigPath: input.testConfigPath || "",
      allowNoTests: input.allowNoTests || ctx.config.test.allowNoTests,
    });
    if (testRes.exitCode !== 0) {
      throw new Error(
        `Tests failed after ${reviewerName} pass:\n${testRes.stdout}\n${testRes.stderr}`,
      );
    }
    state.steps.testsPassed = true;
    state.reviewedAt = new Date().toISOString();

    upsertIssueCompletionBlock(paths.issue, {
      ppcommitClean: true,
      testsPassed: true,
      note: "Review + ppcommit + tests completed. Ready to create PR.",
    });

    maybeCheckpointWip(
      repoRoot,
      state.branch,
      ctx.config.workflow.wip,
      ctx.log,
    );

    // Save fingerprint after all workflow-internal file modifications and WIP
    // commits are done, so pr_creation sees the same state.
    state.reviewFingerprint = computeGitWorktreeFingerprint(repoRoot);
    saveState(ctx.workspaceDir, state);
    return {
      status: "ok",
      data: {
        ppcommitStatus: "clean",
        testResults: {
          cmd: testRes.cmd,
          exitCode: testRes.exitCode,
          passed: testRes.exitCode === 0,
        },
      },
    };
  },
});
