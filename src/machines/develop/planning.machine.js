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
  inputSchema: z.object({}),

  async execute(_input, ctx) {
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

    if (state.steps.wrotePlan) {
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

    const pre = gitPorcelain();
    const preUntracked = new Set(
      pre.filter((e) => e.status === "??").map((e) => e.path),
    );

    // Generate session ID for reuse across steps (planning -> implementation -> fix)
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

    let res;
    try {
      res = await plannerAgent.execute(planPrompt, {
        sessionId: state.claudeSessionId || undefined,
        timeoutMs: 1000 * 60 * 40,
      });
      requireExitZero(plannerName, "plan generation failed", res);
    } catch (err) {
      if (state.claudeSessionId) {
        state.claudeSessionId = null;
        saveState(ctx.workspaceDir, state);
      }
      throw err;
    }

    // Hard gate: planner must not change tracked files
    const post = gitPorcelain();
    const postUntracked = post
      .filter((e) => e.status === "??")
      .map((e) => e.path);
    const newUntracked = postUntracked.filter(
      (p) => !preUntracked.has(p) && !isArtifact(p),
    );

    const trackedDirty = post
      .filter((e) => e.status !== "??" && !isArtifact(e.path))
      .map((e) => `${e.status} ${e.path}`);
    if (trackedDirty.length > 0) {
      throw new Error(
        `Planning step modified tracked files. Aborting.\n${trackedDirty.join("\n")}`,
      );
    }

    // Clean up new untracked files from planning exploration
    if (newUntracked.length > 0) {
      ctx.log({
        event: "plan_untracked_cleanup",
        count: newUntracked.length,
        paths: newUntracked.slice(0, 50),
      });
      const chunkSize = 100;
      for (let i = 0; i < newUntracked.length; i += chunkSize) {
        const chunk = newUntracked.slice(i, i + chunkSize);
        spawnSync("git", ["clean", "-fd", "--", ...chunk], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
    }

    if (!existsSync(paths.plan))
      throw new Error(`PLAN.md not found: ${paths.plan}`);
    state.steps.wrotePlan = true;
    saveState(ctx.workspaceDir, state);

    return { status: "ok", data: { planMd: "written" } };
  },
});
