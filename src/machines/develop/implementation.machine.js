import { spawnSync } from "node:child_process";
import { z } from "zod";
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
  name: "develop.implementation",
  description:
    "Implement feature based on PLAN.md and PLANREVIEW.md. Addresses critique, then codes the solution.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};
    const paths = artifactPaths(ctx.artifactsDir);

    if (!state.steps.wrotePlan || !state.steps.wroteCritique) {
      throw new Error(
        "Precondition failed: PLAN.md and PLANREVIEW.md must exist. Run develop.planning and develop.plan_review first.",
      );
    }

    if (state.steps.implemented) {
      return {
        status: "ok",
        data: { summary: "Implementation already completed (cached)." },
      };
    }

    const repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath);
    ensureBranch(repoRoot, state.branch);

    ctx.log({ event: "step4_implement" });
    const { agentName: programmerName, agent: programmerAgent } =
      ctx.agentPool.getAgent("programmer", { scope: "repo" });

    // Gather branch context for recovery
    const branchDiff = spawnSync("git", ["diff", "--stat", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const gitLog = spawnSync("git", ["log", "--oneline", "-5"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const uncommitted = (branchDiff.stdout || "").trim() || "(none)";
    const recentCommits = (gitLog.stdout || "").trim() || "(none)";

    const recoveryContext = `IMPORTANT — Check for existing work on this branch before starting.
Uncommitted changes:
${uncommitted}

Recent commits:
${recentCommits}

Build upon existing correct work. Do not duplicate or revert it.

`;

    const implPrompt = `${recoveryContext}Read ${paths.plan} and ${paths.critique}.

## Step 1: Address Critique
Update ${paths.plan} to address any Critical Issues or Over-Engineering Concerns from the critique.
If critique says REJECT, revise the plan significantly before proceeding.

## Step 2: Write Tests (TDD)
Before writing implementation code:
1. Read the Testing Strategy from ${paths.issue} and the Testing section from ${paths.plan}
2. Write failing tests that capture the expected behavior described in the issue
3. Run the test suite to confirm the new tests fail for the right reasons (missing implementation, not broken tests)
4. Only then proceed to Step 3

Skip this step ONLY when the change is purely non-behavioral (config files, documentation, pure refactors with no new behavior). For refactors, verify existing tests still pass before and after.

## Step 3: Implement
Implement the feature following the plan. Make the failing tests pass without shortcuts — do not weaken assertions, skip tests, or reduce coverage to get green.

## STRICT Requirements

### Match Existing Patterns
- Study similar code in this repo BEFORE writing
- Copy the EXACT style: naming, formatting, error handling, comments
- If the codebase doesn't have docstrings, don't add them
- If the codebase uses terse variable names, use terse names

### Minimize Changes
- Only modify files listed in the plan
- Only add code that directly implements the feature
- Delete any code that becomes unused
- Prefer fewer lines over "cleaner" abstractions

### NO Tutorial Comments
FORBIDDEN comment patterns:
- "First, we..." / "Now we..." / "Next, we..."
- "This function does X" (obvious from the code)
- "Step 1:", "Step 2:", etc.
- Comments explaining what the next line does
- Comments that restate the function name

ALLOWED comments:
- Non-obvious business logic explanations
- Workaround explanations with ticket/issue references
- Performance optimization explanations
- Regex explanations

### NO Over-Engineering
FORBIDDEN patterns:
- Creating interfaces/base classes for single implementations
- Adding configuration for single use cases
- Factory functions for simple object creation
- Wrapper functions that just call one other function
- Error handling for impossible code paths
- Logging for debugging that won't ship

### Scope Discipline
- If you notice something that "should" be fixed but isn't in the issue, DON'T fix it
- If you think of a "nice to have" feature, DON'T add it
- If code could be "cleaner" with a refactor, DON'T refactor unless required

### Code Quality
- Fix root causes, no hacks
- Do not bypass tests
- Use the repo's normal commands (lint, format, test)`;

    let res;
    try {
      res = await programmerAgent.execute(implPrompt, {
        resumeId: state.claudeSessionId || undefined,
        timeoutMs: ctx.config.workflow.timeouts.implementation,
      });
    } catch (err) {
      if (err.name === "CommandAuthError" && state.claudeSessionId) {
        ctx.log({
          event: "session_resume_failed",
          sessionId: state.claudeSessionId,
        });
        state.claudeSessionId = null;
        saveState(ctx.workspaceDir, state);
        // Fresh session loses prior planning context — acceptable per GH-89
        res = await programmerAgent.execute(implPrompt, {
          timeoutMs: ctx.config.workflow.timeouts.implementation,
        });
      } else {
        throw err;
      }
    }
    requireExitZero(programmerName, "implementation failed", res);

    state.steps.implemented = true;
    saveState(ctx.workspaceDir, state);

    const diffStat = spawnSync("git", ["diff", "--stat", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const summary =
      (diffStat.stdout || "").trim() ||
      "Implementation completed (no diff stat available).";

    maybeCheckpointWip(
      repoRoot,
      state.branch,
      ctx.config.workflow.wip,
      ctx.log,
    );
    return { status: "ok", data: { summary } };
  },
});
