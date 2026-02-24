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
      // Un-stage first (handles A/staged entries), then restore worktree
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

    // Generate session ID for reuse across steps (planning -> implementation -> fix).
    // Note: --session-id creates a named session in Claude CLI. The session name stays
    // registered after the process exits, so reusing the same UUID on a subsequent call
    // fails with "Session ID already in use". Session IDs are therefore cleared whenever
    // a new planning call should start fresh (REVISE rounds, retries after constraint violations).
    if (!state.claudeSessionId) {
      state.claudeSessionId = randomUUID();
      saveState(ctx.workspaceDir, state);
    }

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

    const priorCritiqueSection = input.priorCritique
      ? `\n\n## Previous Review Critique (MUST ADDRESS)\n\nYour previous plan was rejected. You MUST address ALL issues below before writing the revised plan:\n\n${input.priorCritique}`
      : "";

    // Allow one retry when the planner violates the no-source-edit constraint.
    // On violation: revert dirty files, inject feedback into prompt, retry with a fresh session.
    let constraintNote = "";

    for (let attempt = 0; attempt <= 1; attempt++) {
      let res;
      try {
        res = await plannerAgent.execute(
          planPrompt + priorCritiqueSection + constraintNote,
          {
            sessionId: state.claudeSessionId || undefined,
            timeoutMs: ctx.config.workflow.timeouts.planning,
          },
        );
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
      // Also clean any new untracked files created during this failed attempt
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

      // Inject feedback and retry with a fresh session
      constraintNote =
        `\n\n## CONSTRAINT VIOLATION — YOUR PREVIOUS ATTEMPT FAILED\n\n` +
        `You modified source files during planning, which is forbidden.\n` +
        `Only ${paths.plan} may be written. All other files must remain unchanged.\n` +
        `Files you modified (they have been reverted — do not touch them again):\n` +
        `${listed}\n\n` +
        `Retry now: write ONLY ${paths.plan} and do not edit any source files.`;

      // Clear session ID — the previous session's name is still registered in Claude CLI
      // and cannot be reused with --session-id. A new UUID will be generated above.
      state.claudeSessionId = null;
      saveState(ctx.workspaceDir, state);
    }

    if (!existsSync(paths.plan))
      throw new Error(`PLAN.md not found: ${paths.plan}`);
    state.steps.wrotePlan = true;
    saveState(ctx.workspaceDir, state);

    return { status: "ok", data: { planMd: "written" } };
  },
});
