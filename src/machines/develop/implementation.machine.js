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
Update ${paths.plan} to address any Critical Issues or Over-Engineering Concerns from the critique.
If critique says REJECT, revise the plan significantly before proceeding.
${
  useRedGreen
    ? `
## Step 2: RED — Write Failing Tests First
This is a difficulty ${difficulty} issue. Use Red/Green TDD.

Before writing ANY implementation code:
1. Read the Testing Strategy from ${paths.issue} and the Testing section from ${paths.plan}
2. Write test files/cases that capture the expected behavior described in the issue
   - Each test should target one specific requirement
   - Use the repo's existing test framework and conventions
3. **Run the test suite and confirm the new tests FAIL**
   - Verify they fail for the RIGHT reasons: missing functions, unimplemented behavior, wrong return values
   - NOT for syntax errors, import failures in the test itself, or broken test setup
   - If a test passes before implementation, it is not testing new behavior — rewrite it
4. Do NOT proceed to Step 3 until you have confirmed RED (failing tests)

## Step 3: GREEN — Implement to Pass Tests
Implement the feature following the plan. Your goal: make every failing test from Step 2 pass.
- Work incrementally — implement one piece, run tests, see progress
- Do NOT weaken assertions, skip tests, or reduce coverage to get green
- Do NOT modify the tests you wrote in Step 2 to make them pass (fix the implementation, not the tests)
- When all tests pass, you are done with this step`
    : `
## Step 2: Write Tests
Before writing implementation code:
1. Read the Testing Strategy from ${paths.issue} and the Testing section from ${paths.plan}
2. Write tests that capture the expected behavior described in the issue
3. Run the test suite to confirm the new tests fail for the right reasons (missing implementation, not broken tests)
4. Only then proceed to Step 3

## Step 3: Implement
Implement the feature following the plan. Make the failing tests pass without shortcuts — do not weaken assertions, skip tests, or reduce coverage to get green.`
}

Skip Steps 2-3 test phases ONLY when the change is purely non-behavioral (config files, documentation, pure refactors with no new behavior). For refactors, verify existing tests still pass before and after.

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
- Performance optimizations (caches, memoization, custom data structures,
  fancy algorithms) without a benchmark proving the naive version is too
  slow — you can't guess where bottlenecks are, so measure before tuning

### Scope Discipline
- If you notice something that "should" be fixed but isn't in the issue, DON'T fix it
- If you think of a "nice to have" feature, DON'T add it
- If code could be "cleaner" with a refactor, DON'T refactor unless required
- When in doubt, use brute force. If it turns out to be slow, a measurement
  will tell you — and only then is it time to optimize.

### Code Quality
- Fix root causes, no hacks
- Do not bypass tests
- Use the repo's normal commands (lint, format, test)`;

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
