import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { resolvePpcommitLlm } from "../../config.js";
import {
  computeGitWorktreeFingerprint,
  detectDefaultBranch,
  runHostTests,
  runPpcommitScoped,
  stripAgentNoise,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read REVIEW_FINDINGS.md and extract the last VERDICT line.
 * Takes the last match to avoid false positives from prompt examples.
 */
export function parseReviewVerdict(filePath) {
  if (!existsSync(filePath)) return { verdict: null, findings: null };
  const content = readFileSync(filePath, "utf8");
  const matches = content.match(/^##\s+VERDICT:\s+(APPROVED|REVISE)\s*$/gm);
  if (!matches || matches.length === 0)
    return { verdict: null, findings: content };
  const last = matches[matches.length - 1];
  const verdict = last.replace(/^##\s+VERDICT:\s+/, "").trim();
  return { verdict, findings: content };
}

export function buildSpecDeltaPrompt(issuePath, planPath) {
  return `Compare ${issuePath} (original requirements) with ${planPath} (technical plan).

Write a concise "Spec Delta Summary" with these sections:

## Spec Delta Summary

### Additions
(New technical constraints or approaches introduced in the plan)

### Refinements
(Changes in approach from the original issue)

### Omissions
(Requirements deferred or removed in the plan)

Keep each section to 2-5 bullets max. Output only the summary, no other text.`;
}

export function buildReviewerPrompt(
  paths,
  ppSection,
  round,
  priorFindings,
  specDeltaSummary = "",
) {
  const roundContext =
    round === 1
      ? "This is the FIRST review pass. Evaluate the implementation from scratch."
      : `This is review round ${round}. The programmer has attempted to address your prior findings.

## Prior Findings
The following issues were raised in the previous round:
---
${priorFindings || "(no prior findings file found)"}
---

Verify whether each critical/major finding has been addressed. If the programmer's fix is adequate, mark it resolved. If not, explain what remains wrong.`;

  const deltaSection = specDeltaSummary
    ? `## Spec Delta Context\nThe following summary compares the original issue with the technical plan. Use it when evaluating Plan Adherence.\n\n${specDeltaSummary}\n`
    : "";

  const planAdherenceItem = specDeltaSummary
    ? `
### 7. Plan Adherence
- Does the implementation follow the technical structure defined in ${paths.plan}?
- Are there deviations from the agreed approach? Flag them by severity.
- If the spec delta identifies additions/omissions, verify they were addressed or intentionally skipped.
`
    : "";

  return `You are a code reviewer. Your role is to CRITIQUE only — do NOT modify any source code files.

Read ${paths.issue} to understand what was originally requested.
Read ${paths.plan} for the technical approach and constraints agreed upon.

${roundContext}

${deltaSection}
## Review Checklist

### 1. Scope Conformance
- Does the change implement what ${paths.issue} requested and conform to the approach in ${paths.plan}?
- Are there unrequested features? Flag them.
- Are there unrelated refactors? Flag them.

### 2. Completeness
- Is the implementation fully complete? No stubs, TODOs, placeholders?
- Are there test bypasses or skipped tests?

### 3. Code Quality
- Is this the SIMPLEST solution that works?
- Are there unnecessary abstractions, wrapper functions, or over-engineering?

### 4. Comment Hygiene
Flag these comment patterns:
- Tutorial-style: "First we...", "Now we...", "Step N:"
- Restating code: "// increment counter" above counter++
- Narration: "Here we define...", "This function..."

### 5. Backwards-Compat Hacks
Flag these patterns:
- Variables renamed to start with \`_\` but not used
- Re-exports of removed items for compatibility
- Empty functions kept for interface compatibility

### 6. Correctness
- Edge cases handled appropriately?
- Off-by-one errors?
- Error handling only for errors that can actually occur?
${planAdherenceItem}
## ppcommit (commit hygiene)
${ppSection}

## Output Format

Write your findings to ${paths.reviewFindings} with this structure:

\`\`\`markdown
# Review Findings — Round ${round}

## Finding 1
- **Severity**: critical | major | minor
- **File**: path/to/file.js
- **Lines**: 42-58
- **Issue**: Description of the problem
- **Suggestion**: How to fix it

## Finding 2
...

## VERDICT: APPROVED
\`\`\`

Use \`## VERDICT: APPROVED\` if there are no critical or major findings remaining.
Use \`## VERDICT: REVISE\` if critical or major findings need to be addressed.

IMPORTANT:
- Write findings to the file, do NOT modify source code
- The verdict line must be the LAST ## heading in the file
- Minor findings alone are NOT grounds for REVISE — only critical/major findings`;
}

function buildProgrammerFixPrompt(paths, round) {
  return `You have received code review feedback. Read ${paths.reviewFindings} for the findings from review round ${round}.

Address every **critical** and **major** finding. For **minor** findings: fix if trivial (< 5 lines), skip otherwise.

Rules:
- No new features beyond what ${paths.issue} requested
- No refactoring beyond what the review findings require
- Run the repo's standard lint/format commands after fixing
- Do NOT modify ${paths.reviewFindings} — the reviewer will re-check your work`;
}

function buildCommitterEscalationPrompt(paths, ppSection) {
  return `You are the final gatekeeper before a PR is created. The programmer and reviewer have already done 2 rounds each.

Read ${paths.issue} for the original scope.
Read ${paths.reviewFindings} for any remaining reviewer objections — you may DISMISS these if they are pedantic or stylistic.

Your focus is commit hygiene and test health, NOT writing new code:

1. Fix ppcommit issues:
${ppSection}

2. Run the repo's lint/format commands and fix any failures
3. Run tests and fix any failures — only minimal, targeted fixes (typos, imports, small adjustments)
4. Remove unnecessary comments, dead code, or leftover debug artifacts

Do NOT refactor, add features, or make substantial code changes. If something needs significant work, leave it — the PR description will note it.`;
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export default defineMachine({
  name: "develop.quality_review",
  description:
    "Review implementation via iterative reviewer-programmer loop, run ppcommit hygiene, execute tests.",
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

    const { agentName: programmerName, agent: programmerAgent } =
      ctx.agentPool.getAgent("programmer", { scope: "repo" });
    const { agentName: reviewerName, agent: reviewerAgent } =
      ctx.agentPool.getAgent("reviewer", { scope: "repo" });
    const { agentName: committerName, agent: committerAgent } =
      ctx.agentPool.getAgent("committer", { scope: "repo" });
    const paths = artifactPaths(ctx.artifactsDir);

    // -----------------------------------------------------------------------
    // Phase 1: ppcommit initial check
    // -----------------------------------------------------------------------
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

    const ppOutput = (ppBefore.stdout || ppBefore.stderr || "").trim();
    const ppSection =
      ppBefore.exitCode === 0
        ? "ppcommit passed (no issues). Focus on code review."
        : `ppcommit found issues — these should also be addressed:\n---\n${ppOutput}\n---`;

    // -----------------------------------------------------------------------
    // Phase 1b: Spec delta generation
    // -----------------------------------------------------------------------
    if (!state.specDeltaSummary && existsSync(paths.plan)) {
      ctx.log({ event: "spec_delta_start" });
      const deltaPrompt = buildSpecDeltaPrompt(paths.issue, paths.plan);
      const deltaRes = await reviewerAgent.execute(deltaPrompt, {
        timeoutMs: ctx.config.workflow.timeouts.reviewRound,
      });
      requireExitZero(reviewerName, "spec delta generation", deltaRes);
      state.specDeltaSummary = stripAgentNoise(deltaRes.stdout || "").trim();
      saveState(ctx.workspaceDir, state);
      ctx.log({ event: "spec_delta_done" });
    }

    // -----------------------------------------------------------------------
    // Phase 2: Iterative review loop (max 2 rounds)
    // -----------------------------------------------------------------------
    if (!state.steps.reviewerCompleted) {
      ctx.log({ event: "review_loop_start" });

      // Generate reviewer session ID for session continuity across rounds
      if (!state.reviewerSessionId) {
        state.reviewerSessionId = randomUUID();
        saveState(ctx.workspaceDir, state);
      }

      // Initialize review round tracking if not set (recovery-safe)
      if (state.steps.reviewRound === undefined) {
        state.steps.reviewRound = 0;
        state.steps.programmerFixedRound = 0;
        saveState(ctx.workspaceDir, state);
      }

      const maxRounds = 2;

      // Flow: R1 → fix1 → R2 → fix2 → committer
      // Programmer ALWAYS gets a fix pass after each REVISE.
      // Committer only enters after both fix attempts are exhausted.
      for (let round = 1; round <= maxRounds; round++) {
        if (ctx.cancelToken.cancelled) break;

        // Recovery: skip rounds we've already completed
        if (state.steps.reviewRound >= round) {
          // Check if programmer fix is still needed for this round
          if (
            state.steps.reviewVerdict === "REVISE" &&
            (state.steps.programmerFixedRound || 0) < round
          ) {
            // Resume from programmer fix
            ctx.log({ event: "review_recovery_programmer_fix", round });
          } else {
            // Round fully processed, skip
            ctx.log({ event: "review_recovery_skip_round", round });
            continue;
          }
        } else {
          // --- Reviewer critiques ---
          ctx.log({ event: "reviewer_critique", round, agent: reviewerName });

          const priorFindings =
            round > 1
              ? parseReviewVerdict(paths.reviewFindings).findings
              : null;

          const reviewPrompt = buildReviewerPrompt(
            paths,
            ppSection,
            round,
            priorFindings,
            state.specDeltaSummary || "",
          );

          // Round 1: new session; Round 2+: resume to retain review context
          const reviewSessionOpts =
            round === 1
              ? { sessionId: state.reviewerSessionId }
              : { resumeId: state.reviewerSessionId };

          let reviewRes;
          try {
            reviewRes = await reviewerAgent.execute(reviewPrompt, {
              ...reviewSessionOpts,
              timeoutMs: ctx.config.workflow.timeouts.reviewRound,
            });
          } catch (err) {
            if (err.name === "CommandAuthError" && reviewSessionOpts.resumeId) {
              ctx.log({
                event: "session_resume_failed",
                sessionId: state.reviewerSessionId,
              });
              state.reviewerSessionId = randomUUID();
              saveState(ctx.workspaceDir, state);
              // Fresh session loses prior review context — acceptable per GH-89
              reviewRes = await reviewerAgent.execute(reviewPrompt, {
                sessionId: state.reviewerSessionId,
                timeoutMs: ctx.config.workflow.timeouts.reviewRound,
              });
            } else {
              throw err;
            }
          }
          requireExitZero(reviewerName, `review round ${round}`, reviewRes);

          // Parse verdict from file
          const { verdict } = parseReviewVerdict(paths.reviewFindings);
          state.steps.reviewRound = round;
          state.steps.reviewVerdict = verdict || "REVISE";
          saveState(ctx.workspaceDir, state);

          if (!verdict) {
            ctx.log({
              event: "review_verdict_missing",
              round,
              note: "No verdict found in REVIEW_FINDINGS.md, treating as REVISE",
            });
          } else {
            ctx.log({ event: "review_verdict", round, verdict });
          }

          if (verdict === "APPROVED") {
            state.steps.reviewerCompleted = true;
            saveState(ctx.workspaceDir, state);
            break;
          }
        }

        // --- Programmer fixes (after every REVISE) ---
        // Recovery: skip if programmer already fixed this round
        if ((state.steps.programmerFixedRound || 0) >= round) {
          ctx.log({ event: "review_recovery_skip_fix", round });
          continue;
        }

        ctx.log({ event: "programmer_fix", round, agent: programmerName });

        const fixPrompt = buildProgrammerFixPrompt(paths, round);
        let fixRes;
        try {
          fixRes = await programmerAgent.execute(fixPrompt, {
            resumeId: state.claudeSessionId || undefined,
            timeoutMs: ctx.config.workflow.timeouts.programmerFix,
          });
        } catch (err) {
          if (err.name === "CommandAuthError" && state.claudeSessionId) {
            ctx.log({
              event: "session_resume_failed",
              sessionId: state.claudeSessionId,
            });
            state.claudeSessionId = null;
            saveState(ctx.workspaceDir, state);
            // Fresh session loses prior context — acceptable per GH-89
            fixRes = await programmerAgent.execute(fixPrompt, {
              timeoutMs: ctx.config.workflow.timeouts.programmerFix,
            });
          } else {
            throw err;
          }
        }
        requireExitZero(programmerName, `fix round ${round}`, fixRes);

        state.steps.programmerFixedRound = round;
        saveState(ctx.workspaceDir, state);

        // WIP checkpoint after programmer fix
        maybeCheckpointWip(
          repoRoot,
          state.branch,
          ctx.config.workflow.wip,
          ctx.log,
        );
      }

      // --- Committer escalation (both rounds exhausted, still REVISE) ---
      if (
        !state.steps.reviewerCompleted &&
        !ctx.cancelToken.cancelled &&
        state.steps.reviewVerdict === "REVISE"
      ) {
        ctx.log({
          event: "committer_escalation",
          agent: committerName,
        });

        const escalationPrompt = buildCommitterEscalationPrompt(
          paths,
          ppSection,
        );
        const escalationRes = await committerAgent.execute(escalationPrompt, {
          timeoutMs: ctx.config.workflow.timeouts.committerEscalation,
        });
        requireExitZero(committerName, "committer escalation", escalationRes);
      }

      // Mark review phase complete
      if (!state.steps.reviewerCompleted && !ctx.cancelToken.cancelled) {
        state.steps.reviewerCompleted = true;
        saveState(ctx.workspaceDir, state);
      }
    }

    // -----------------------------------------------------------------------
    // Phase 3: ppcommit hard gate + committer retry loop
    // -----------------------------------------------------------------------
    const maxPpcommitRetries = 2;
    let ppAfter = await runPpcommitScoped(repoRoot, baseBranch, ppcommitConfig);
    ctx.log({
      event: "ppcommit_after",
      attempt: 0,
      exitCode: ppAfter.exitCode,
    });

    const runCommitterPass = async (agent, agentName, retrySection, label) => {
      const prompt = `You are reviewing uncommitted changes for commit readiness.
Read ${paths.issue} to understand what was originally requested.

## ppcommit (commit hygiene)
${retrySection}

Then run the repo's standard lint/format/test commands and fix any failures.

Hard constraints:
- Never bypass tests or reduce coverage/quality
- If a command fails, fix the underlying issue and re-run until it passes
- Remove ALL unnecessary code, comments, and abstractions`;

      const res = await agent.execute(prompt, {
        timeoutMs: ctx.config.workflow.timeouts.finalGate,
      });
      requireExitZero(agentName, label, res);
    };

    for (
      let attempt = 1;
      attempt <= maxPpcommitRetries && ppAfter.exitCode !== 0;
      attempt++
    ) {
      const ppAfterOutput = (ppAfter.stdout || ppAfter.stderr || "").trim();
      ctx.log({ event: "ppcommit_retry", attempt, exitCode: ppAfter.exitCode });
      const retrySection = `ppcommit still failing after review pass. Fix ALL remaining ppcommit issues:\n---\n${ppAfterOutput}\n---`;
      await runCommitterPass(
        committerAgent,
        committerName,
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

    // -----------------------------------------------------------------------
    // Phase 4: test hard gate
    // -----------------------------------------------------------------------
    const testRes = await runHostTests(repoRoot, {
      testCmd: input.testCmd || ctx.config.test.command,
      testConfigPath: input.testConfigPath || "",
      allowNoTests: input.allowNoTests || ctx.config.test.allowNoTests,
    });
    if (testRes.exitCode !== 0) {
      throw new Error(
        `Tests failed after review:\n${testRes.stdout}\n${testRes.stderr}`,
      );
    }
    state.steps.testsPassed = true;
    state.reviewedAt = new Date().toISOString();

    upsertIssueCompletionBlock(paths.issue, {
      ppcommitClean: true,
      testsPassed: true,
      note: "Review + ppcommit + tests completed. Ready to create PR.",
    });

    // WIP checkpoint BEFORE fingerprint so pr_creation sees post-commit state
    maybeCheckpointWip(
      repoRoot,
      state.branch,
      ctx.config.workflow.wip,
      ctx.log,
    );

    state.reviewFingerprint = computeGitWorktreeFingerprint(repoRoot);
    saveState(ctx.workspaceDir, state);
    return {
      status: "ok",
      data: {
        ppcommitStatus: "clean",
        reviewRounds: state.steps.reviewRound || 0,
        reviewVerdict: state.steps.reviewVerdict || "APPROVED",
        testResults: {
          cmd: testRes.cmd,
          exitCode: testRes.exitCode,
          passed: testRes.exitCode === 0,
        },
      },
    };
  },
});
