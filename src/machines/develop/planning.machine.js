import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import { loadState, saveState } from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import {
  artifactPaths,
  ensureBranch,
  requireExitZero,
  resolveRepoRoot,
} from "./_shared.js";

export default defineMachine({
  name: "develop.planning",
  description:
    "Create PLAN.md: research codebase, evaluate approaches, write structured implementation plan.",
  inputSchema: z.object({
    priorCritique: z.string().optional().default(""),
  }),

  async execute(input, ctx) {
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};
    const paths = artifactPaths(ctx.artifactsDir);

    // Reconcile from artifacts
    if (existsSync(paths.issue)) state.steps.wroteIssue = true;
    if (!state.steps.wroteIssue) {
      throw new Error(
        "Precondition failed: ISSUE.md does not exist. Run develop.issue_draft first.",
      );
    }

    if (state.steps.wrotePlan && !input.priorCritique) {
      return { status: "ok", data: { planMd: "(cached)" } };
    }

    const repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath);
    ensureBranch(repoRoot, state.branch);

    ctx.log({ event: "step3a_create_plan" });
    const { agentName: plannerName, agent: plannerAgent } =
      ctx.agentPool.getAgent("planner", { scope: "repo" });

    const artifactFiles = [
      "ISSUE.md",
      "PLAN.md",
      "PLANREVIEW.md",
      ".coder/",
      ".gemini/",
    ];
    const isArtifact = (p) =>
      artifactFiles.some((a) =>
        a.endsWith("/") ? p.replace(/\\/g, "/").startsWith(a) : p === a,
      );

    const gitPorcelain = () => {
      const st = spawnSync("git", ["status", "--porcelain=v1", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (st.status !== 0)
        throw new Error("Failed to check git status during planning.");
      const tokens = (st.stdout || "").split("\0").filter(Boolean);
      const entries = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.length < 4) continue;
        const status = t.slice(0, 2);
        let filePath = t.slice(3);
        if ((status[0] === "R" || status[0] === "C") && i + 1 < tokens.length) {
          filePath = tokens[i + 1];
          i++;
        }
        entries.push({ status, path: filePath });
      }
      return entries;
    };

    const revertTrackedDirty = (dirtyEntries) => {
      const filePaths = dirtyEntries.map((e) => e.path);
      spawnSync("git", ["restore", "--staged", "--", ...filePaths], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      spawnSync("git", ["restore", "--", ...filePaths], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    };

    const cleanUntracked = (untrackedPaths) => {
      const chunkSize = 100;
      for (let i = 0; i < untrackedPaths.length; i += chunkSize) {
        const chunk = untrackedPaths.slice(i, i + chunkSize);
        spawnSync("git", ["clean", "-fd", "--", ...chunk], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
    };

    const pre = gitPorcelain();
    const preUntracked = new Set(
      pre.filter((e) => e.status === "??").map((e) => e.path),
    );

    // Session strategy: the first planning call creates a named session with --session-id.
    // All subsequent calls in this issue (REVISE rounds, implementation, fix, review) resume
    // with --resume so the agent retains full conversation context across the workflow.
    const creatingSession = !state.claudeSessionId;
    if (creatingSession) {
      state.claudeSessionId = randomUUID();
      saveState(ctx.workspaceDir, state);
    }

    // Full prompt used only when creating a fresh session.
    const planPrompt = `You are planning an implementation. Follow this structured approach:

## Phase 1: Research (MANDATORY)
Before writing any plan:
1. Read ${paths.issue} completely
2. Search the codebase to understand existing patterns, conventions, and architecture
3. For any external dependencies mentioned:
   - Verify they exist and are actively maintained
   - Read their actual documentation (not your training data)
   - Confirm the APIs you plan to use actually exist
4. Identify similar existing implementations in this codebase to use as templates

## Phase 2: Evaluate Approaches
Consider at least 2 different approaches. For each:
- Pros/cons
- Complexity
- Alignment with existing patterns

Select the simplest approach that solves the problem.

## Phase 3: Write Plan to ${paths.plan}

Structure:
1. **Summary**: One paragraph describing what will change
2. **Approach**: Which approach and why (reference existing patterns)
3. **Files to Modify**: List each file with specific changes
4. **Files to Create**: Only if absolutely necessary (prefer modifying existing files)
5. **Dependencies**: Any new dependencies with version and justification
6. **Testing Strategy**:
   - Reference the testing strategy from ISSUE.md if present
   - List existing test files that validate related behavior
   - Describe specific test cases to write (inputs, expected outputs, edge cases)
   - Specify the test command to run
7. **Out of Scope**: Explicitly list what this change does NOT include

## Complexity Budget
- Prefer modifying 1-3 files over touching many files
- Prefer using existing utilities over creating new abstractions
- Prefer inline code over new helper functions for one-time operations
- Prefer direct solutions over configurable/extensible patterns

## Anti-Patterns to AVOID
- Do NOT add abstractions "for future flexibility"
- Do NOT create wrapper classes/functions around simple operations
- Do NOT add configuration options that aren't requested
- Do NOT refactor unrelated code
- Do NOT add error handling for impossible scenarios

Constraints:
- Do NOT implement code yet
- Do NOT modify any tracked files (only write ${paths.plan})
- Do NOT invent APIs - verify they exist in actual documentation
- Do NOT ask questions; use repo conventions and ISSUE.md as ground truth`;

    // Allow one retry when the planner violates the no-source-edit constraint.
    // Retries resume the existing session so the agent has the violation as context.
    let constraintNote = "";

    for (let attempt = 0; attempt <= 1; attempt++) {
      // First call: full prompt to establish context. All subsequent calls (REVISE rounds,
      // constraint retries) are follow-up messages in the same resumed session.
      let prompt;
      if (creatingSession && attempt === 0) {
        prompt = planPrompt;
        if (input.priorCritique) {
          prompt +=
            `\n\n## Previous Review Critique (MUST ADDRESS)\n\n` +
            `Your previous plan was rejected. You MUST address ALL issues below before writing the revised plan:\n\n` +
            input.priorCritique;
        }
      } else if (constraintNote) {
        // Constraint retry: just the violation feedback as a follow-up
        prompt = constraintNote;
      } else {
        // REVISE round: resume session with focused follow-up instead of full prompt
        prompt =
          `Your previous plan was rejected by the reviewer. Revise ${paths.plan} addressing ALL of the following:\n\n` +
          input.priorCritique +
          `\n\nRemember: only write ${paths.plan}. Do not modify any source files.`;
      }

      const sessionOpts =
        creatingSession && attempt === 0
          ? { sessionId: state.claudeSessionId }
          : { resumeId: state.claudeSessionId };

      let res;
      try {
        try {
          res = await plannerAgent.execute(prompt, {
            ...sessionOpts,
            timeoutMs: ctx.config.workflow.timeouts.planning,
          });
        } catch (err) {
          if (err.name === "CommandAuthError" && sessionOpts.resumeId) {
            ctx.log({
              event: "session_resume_failed",
              sessionId: state.claudeSessionId,
            });
            state.claudeSessionId = randomUUID();
            saveState(ctx.workspaceDir, state);
            // Fresh session needs full planPrompt even during REVISE/constraint rounds
            const retryPrompt =
              prompt === planPrompt || prompt.startsWith(planPrompt)
                ? prompt
                : `${planPrompt}\n\n${prompt}`;
            res = await plannerAgent.execute(retryPrompt, {
              sessionId: state.claudeSessionId,
              timeoutMs: ctx.config.workflow.timeouts.planning,
            });
          } else {
            throw err;
          }
        }
        requireExitZero(plannerName, "plan generation failed", res);
      } catch (err) {
        state.claudeSessionId = null;
        saveState(ctx.workspaceDir, state);
        throw err;
      }

      const post = gitPorcelain();
      const postUntracked = post
        .filter((e) => e.status === "??")
        .map((e) => e.path);
      const newUntracked = postUntracked.filter(
        (p) => !preUntracked.has(p) && !isArtifact(p),
      );
      const trackedDirtyEntries = post.filter(
        (e) => e.status !== "??" && !isArtifact(e.path),
      );

      if (trackedDirtyEntries.length === 0) {
        // Clean run — remove any untracked scratch files and finish
        if (newUntracked.length > 0) {
          ctx.log({
            event: "plan_untracked_cleanup",
            count: newUntracked.length,
            paths: newUntracked.slice(0, 50),
          });
          cleanUntracked(newUntracked);
        }
        break;
      }

      // Planner modified tracked source files — revert and either retry or fail
      revertTrackedDirty(trackedDirtyEntries);
      if (newUntracked.length > 0) cleanUntracked(newUntracked);

      const listed = trackedDirtyEntries
        .map((e) => `  ${e.status} ${e.path}`)
        .join("\n");
      ctx.log({
        event: "plan_constraint_violation",
        attempt,
        reverted: trackedDirtyEntries.map((e) => e.path),
      });

      if (attempt === 1) {
        throw new Error(
          `Planning agent repeatedly violated constraint: must not modify source files.\n` +
            `Only ${paths.plan} should be written during planning.\n` +
            `Modified files (reverted):\n${listed}`,
        );
      }

      // Build follow-up message for the constraint retry (resumed in the same session)
      constraintNote =
        `CONSTRAINT VIOLATION: You modified source files during planning, which is forbidden.\n` +
        `Only ${paths.plan} may be written. All other files must remain unchanged.\n` +
        `Files you modified (they have been reverted — do not touch them again):\n` +
        `${listed}\n\n` +
        `Retry now: write ONLY ${paths.plan} and do not edit any source files.`;
    }

    if (!existsSync(paths.plan))
      throw new Error(`PLAN.md not found: ${paths.plan}`);
    state.steps.wrotePlan = true;
    saveState(ctx.workspaceDir, state);

    return { status: "ok", data: { planMd: "written" } };
  },
});
