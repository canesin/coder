import { spawnSync } from "node:child_process";
import { z } from "zod";
import { discoverCodexSessionId } from "../../agents/codex-session-discovery.js";
import {
  clearAllSessionIdsAndDisable,
  loadState,
  saveState,
} from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import { makeClaudeSessionId } from "./_session.js";
import {
  artifactPaths,
  ensureBranch,
  maybeCheckpointWip,
  requireExitZero,
  resolveRepoRoot,
} from "./_shared.js";

/** Wall-clock and hang budgets for the programmer CLI during implementation (must stay aligned). @internal */
export function implementationAgentExecTimeouts(config) {
  const timeoutMs = config.workflow.timeouts.implementation;
  return { timeoutMs, hangTimeoutMs: timeoutMs };
}

export default defineMachine({
  name: "develop.implementation",
  description:
    "Implement feature based on PLAN.md and PLANREVIEW.md. Addresses critique, then codes the solution.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const state = await loadState(ctx.workspaceDir);
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
    await ensureBranch(repoRoot, state.branch, { signal: ctx.signal });

    ctx.log({ event: "step4_implement" });
    const { agentName: programmerName, agent: programmerAgent } =
      ctx.agentPool.getAgent("programmer", { scope: "repo" });

    const sessionKey = "implementationSessionId";
    const codexUsesSession =
      programmerName === "codex" &&
      programmerAgent.codexSessionSupported?.() === true;

    // Agent-change invalidation: clear session when programmer agent changes
    if (
      state.implementationAgentName &&
      state.implementationAgentName !== programmerName
    ) {
      delete state[sessionKey];
      state.implementationAgentName = programmerName;
      await saveState(ctx.workspaceDir, state);
    }

    const hadSessionBefore = !!state[sessionKey];
    if (!state.sessionsDisabled && !state[sessionKey]) {
      if (programmerName === "codex") {
        if (codexUsesSession) {
          state[sessionKey] = makeClaudeSessionId(ctx.workflowRunId);
          state.implementationAgentName = programmerName;
          await saveState(ctx.workspaceDir, state);
        }
      } else if (programmerName === "claude") {
        state[sessionKey] = makeClaudeSessionId(ctx.workflowRunId);
        state.implementationAgentName = programmerName;
        await saveState(ctx.workspaceDir, state);
      }
      // gemini: no session create path in this iteration
    }
    const sessionOrResumeId = state[sessionKey];
    const execOpts = implementationAgentExecTimeouts(ctx.config);
    const codexWithoutSession = programmerName === "codex" && !codexUsesSession;
    if (state.sessionsDisabled) {
      if (codexWithoutSession) execOpts.execWithJsonCapture = true;
    } else if (programmerName === "codex") {
      if (codexUsesSession) {
        if (hadSessionBefore) execOpts.resumeId = sessionOrResumeId;
        else execOpts.sessionId = sessionOrResumeId;
      } else {
        if (hadSessionBefore) execOpts.resumeId = sessionOrResumeId;
        else execOpts.execWithJsonCapture = true;
      }
    } else if (sessionOrResumeId) {
      if (hadSessionBefore) execOpts.resumeId = sessionOrResumeId;
      else execOpts.sessionId = sessionOrResumeId;
    }

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

    const difficulty = state.selected?.difficulty ?? 3;
    const useRedGreen = difficulty >= 3;

    const implPrompt = `${recoveryContext}Read ${paths.plan} and ${paths.critique}.

## Step 1: Address Critique
Update ${paths.plan} to resolve every finding in the critique —
Critical Issues, Over-Engineering Concerns, Data Structure Review,
Concerns, and Questions. For each Question: answer it only when the
repo or ISSUE.md gives you an explicit, verifiable answer. When you
can't:
- **Blocking question** (affects required behavior, acceptance
  criteria, or API/data-shape the implementation must match): STOP.
  Record the question under an \`## Open Questions (BLOCKING)\`
  section in ${paths.plan} and do NOT produce an implementation diff.
  Let the workflow surface the blocker.
- **Non-blocking question** (style, naming, minor polish): record
  the question and the working assumption under \`## Open Questions\`
  in ${paths.plan}, then proceed. Make the assumption obvious so
  reviewers can catch it.

If the critique says REJECT, revise significantly before proceeding.

## Step 2: Tests First
${
  useRedGreen
    ? `Difficulty ${difficulty} — use Red/Green TDD.

Write tests from the Testing Strategy in ${paths.issue} and
${paths.plan}, using the repo's existing framework and conventions.
Each test targets one specific requirement. Run them and confirm
they FAIL for the RIGHT reasons (missing functions, unimplemented
behavior, wrong return values — NOT syntax errors or broken setup).
If a test passes before implementation, rewrite it. Do not proceed
to Step 3 until RED is confirmed.`
    : `Write tests from the Testing Strategy in ${paths.issue} and
${paths.plan}, using the repo's existing framework and conventions.
Run them to confirm they fail for the right reasons (missing
implementation, not broken tests), then move on.`
}

Skip Step 2's failing-test-first requirement only for pure
config/docs/refactors with no new behavior. Step 3 still runs — on
the skip path, run the existing suite before and after to confirm
nothing regressed.

## Step 3: Implement
Make the Step 2 failing tests pass (or, on the skip path, keep the
existing suite green). Work incrementally — one piece at a time, run
tests, see progress. Do NOT weaken assertions, skip tests, reduce
coverage, or edit the Step 2 tests to make them green. Fix the
implementation instead.

## House Rules
- **Match the repo's style exactly.** Study similar code before
  writing. Copy naming, formatting, error handling, and comment
  density. No docstrings if the codebase has none; terse names if
  surrounding code is terse.
- **Minimum diff.** Only touch files in the plan. Delete code that
  becomes unused. Fewer lines beat "cleaner" abstractions.
- **No over-engineering.** No interfaces for one implementation, no
  config for one use case, no factories for simple objects, no
  wrappers around one call, no error handling for impossible paths,
  no debug logging that won't ship, no speculative optimizations
  (caches, memoization, custom data structures) without a benchmark.
  When in doubt, use brute force.
- **No tutorial comments.** Skip "First we...", "Step N:", and
  comments that restate code. Keep only non-obvious logic, workaround
  refs with ticket links, perf notes, and regex explanations.
- **Stay in scope.** If you notice something "should" be fixed or
  could be "cleaner", don't — it's not in the ticket.
- **Fix root causes.** Don't bypass tests. Use the repo's standard
  lint/format/test commands.`;

    async function captureCodexSessionId(runStartTimeMs, resultObj) {
      let sid = null;
      if (resultObj?.threadId) sid = resultObj.threadId;
      if (!sid) sid = await discoverCodexSessionId(repoRoot, runStartTimeMs);
      if (!sid) sid = null;
      state[sessionKey] = sid;
      await saveState(ctx.workspaceDir, state);
    }

    const runStartTimeMs = codexWithoutSession ? Date.now() : 0;
    let res;
    try {
      res = await programmerAgent.execute(implPrompt, execOpts);
    } catch (err) {
      if (
        (err.name === "CommandFatalStderrError" ||
          err.name === "CommandFatalStdoutError") &&
        err.category === "auth" &&
        (state[sessionKey] || execOpts.sessionId || execOpts.resumeId)
      ) {
        ctx.log({
          event: "session_auth_failed",
          sessionId: state[sessionKey],
        });
        clearAllSessionIdsAndDisable(state);
        await saveState(ctx.workspaceDir, state);
        // Fresh session loses prior planning context — acceptable per GH-89
        const retryRunStart = codexWithoutSession ? Date.now() : 0;
        try {
          res = await programmerAgent.execute(implPrompt, {
            ...implementationAgentExecTimeouts(ctx.config),
            ...(codexWithoutSession && { execWithJsonCapture: true }),
          });
          if (codexWithoutSession) {
            await captureCodexSessionId(retryRunStart, res);
          }
        } catch (retryErr) {
          if (codexWithoutSession) {
            const sid = await discoverCodexSessionId(repoRoot, retryRunStart);
            state[sessionKey] = sid ?? null;
            await saveState(ctx.workspaceDir, state);
          }
          throw retryErr;
        }
      } else {
        if (codexWithoutSession && !hadSessionBefore) {
          const sid = await discoverCodexSessionId(repoRoot, runStartTimeMs);
          state[sessionKey] = sid ?? null;
          await saveState(ctx.workspaceDir, state);
        }
        throw err;
      }
    }

    if (codexWithoutSession && !hadSessionBefore) {
      await captureCodexSessionId(runStartTimeMs, res);
    }
    requireExitZero(programmerName, "implementation failed", res);

    state.steps.implemented = true;
    await saveState(ctx.workspaceDir, state);

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
