import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planReviewMachine from "../src/machines/develop/plan-review.machine.js";
import planningMachine from "../src/machines/develop/planning.machine.js";
import { saveState } from "../src/state/workflow-state.js";

test("planning machine uses workspace scope for agent when repo_path is subdir", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "repo-path-artifact-"));
  try {
    // Workspace with api/ subdir as repo
    const apiDir = path.join(ws, "api");
    mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
    mkdirSync(apiDir, { recursive: true });
    execSync("git init -b main", { cwd: apiDir, stdio: "ignore" });
    execSync("git config user.email t@t.com", { cwd: apiDir, stdio: "ignore" });
    execSync("git config user.name T", { cwd: apiDir, stdio: "ignore" });
    writeFileSync(path.join(apiDir, "main.py"), "# api\n");
    execSync("git add main.py", { cwd: apiDir, stdio: "ignore" });
    execSync("git commit -m init", { cwd: apiDir, stdio: "ignore" });

    const artifactsDir = path.join(ws, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n\nFix API.");

    await saveState(ws, {
      selected: { source: "local", id: "A", title: "Issue A" },
      repoPath: "api",
      steps: { wroteIssue: true },
      branch: "main",
    });

    const getAgentCalls = [];
    const mockAgent = {
      execute: async () => {
        writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n\nDo it.");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const mockAgentPool = {
      getAgent: (role, opts) => {
        getAgentCalls.push({ role, scope: opts?.scope });
        return { agentName: "test", agent: mockAgent };
      },
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: mockAgentPool,
      log: () => {},
      config: { workflow: { timeouts: { planning: 60000 } } },
    };

    await planningMachine.run({}, ctx);

    assert.ok(
      getAgentCalls.some(
        (c) => c.role === "planner" && c.scope === "workspace",
      ),
      "planner must use scope workspace for artifact access when repo_path is subdir",
    );
    assert.ok(
      existsSync(path.join(artifactsDir, "PLAN.md")),
      "PLAN.md must exist at workspace-level artifacts",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("plan-review Gemini path uses workspaceDir as cwd for artifact access", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "repo-path-review-"));
  try {
    const apiDir = path.join(ws, "api");
    mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
    mkdirSync(apiDir, { recursive: true });
    execSync("git init -b main", { cwd: apiDir, stdio: "ignore" });
    execSync("git config user.email t@t.com", { cwd: apiDir, stdio: "ignore" });
    execSync("git config user.name T", { cwd: apiDir, stdio: "ignore" });
    execSync("git commit --allow-empty -m init", {
      cwd: apiDir,
      stdio: "ignore",
    });

    const artifactsDir = path.join(ws, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n\nDo it.");

    await saveState(ws, {
      selected: { source: "local", id: "A", title: "Issue A" },
      repoPath: "api",
      steps: { wroteIssue: true, wrotePlan: true },
      branch: "main",
    });

    let runPlanreviewCwd = null;
    const mockRunPlanreview = (cwd, _planPath, critiquePath) => {
      runPlanreviewCwd = cwd;
      writeFileSync(critiquePath, "## Verdict\nAPPROVED\n", "utf8");
      return 0;
    };

    const mockAgentPool = {
      getAgent: () => ({ agentName: "gemini", agent: null }),
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: mockAgentPool,
      log: () => {},
      config: { workflow: { timeouts: { planReview: 60000 } } },
      _runPlanreviewForTest: mockRunPlanreview,
    };

    await planReviewMachine.run({}, ctx);

    assert.equal(
      runPlanreviewCwd,
      ws,
      "Gemini runPlanreview must receive workspaceDir as cwd, not repoRoot",
    );
    assert.ok(
      existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
      "PLANREVIEW.md must exist at workspace-level artifacts",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
