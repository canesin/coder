import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { registerWorkflowTools } from "../src/mcp/tools/workflows.js";
import { saveLoopState } from "../src/state/workflow-state.js";
import { buildIssueBranchName } from "../src/worktrees.js";

function makeRepo() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-workflow-tools-"));
  const run = (args) => {
    const res = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${res.stderr || res.stdout}`,
      );
    }
  };
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  writeFileSync(path.join(ws, "README.md"), "hi\n", "utf8");
  run(["add", "README.md"]);
  run(["commit", "-m", "init"]);
  run(["branch", "-M", "main"]);
  return ws;
}

function makeWorkflowHandler(workspaceDir) {
  let handler = null;
  const server = {
    registerTool(name, _meta, fn) {
      if (name === "coder_workflow") handler = fn;
    },
  };
  registerWorkflowTools(server, workspaceDir);
  if (!handler) throw new Error("failed to register coder_workflow");
  return handler;
}

function parseToolResponse(result) {
  assert.equal(result.isError, undefined);
  const text = result.content?.[0]?.text || "{}";
  return JSON.parse(text);
}

test("coder_workflow status includes currentIssue summary fields", async () => {
  const ws = makeRepo();
  saveLoopState(ws, {
    runId: "abc123",
    goal: "resolve issues",
    status: "running",
    issueQueue: [
      {
        source: "github",
        id: "MODEX-001",
        title: "First",
        status: "in_progress",
        prUrl: null,
        error: null,
      },
      {
        source: "github",
        id: "MODEX-002",
        title: "Second",
        status: "pending",
        prUrl: null,
        error: null,
      },
    ],
    currentIndex: 0,
    currentStage: "issue:MODEX-001:develop.implementation",
    currentStageStartedAt: new Date(Date.now() - 1500).toISOString(),
    activeAgent: "claude",
    lastHeartbeatAt: new Date().toISOString(),
    runnerPid: process.pid,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  const handler = makeWorkflowHandler(ws);
  const payload = parseToolResponse(
    await handler({ action: "status", workflow: "develop" }),
  );

  assert.equal(payload.currentIssue.id, "MODEX-001");
  assert.equal(payload.currentIssue.index, 1);
  assert.equal(payload.issuesRemaining, 2);
  assert.equal(typeof payload.timeInCurrentStageMs, "number");
  assert.ok(payload.timeInCurrentStageMs >= 0);

  rmSync(ws, { recursive: true, force: true });
});

test("coder_workflow reset removes stale workflow state and issue branches", async () => {
  const ws = makeRepo();
  const issue = {
    source: "github",
    id: "MODEX-009",
    title: "Fix flaky retry",
    status: "failed",
  };
  const branch = buildIssueBranchName(issue);
  const mkBranch = spawnSync("git", ["branch", branch], {
    cwd: ws,
    encoding: "utf8",
  });
  if (mkBranch.status !== 0) {
    throw new Error(mkBranch.stderr || mkBranch.stdout);
  }

  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  writeFileSync(path.join(ws, ".coder", "state.json"), "{}\n", "utf8");
  writeFileSync(path.join(ws, ".coder", "workflow-state.json"), "{}\n", "utf8");
  writeFileSync(
    path.join(ws, ".coder", "artifacts", "ISSUE.md"),
    "# temp\n",
    "utf8",
  );

  saveLoopState(ws, {
    runId: "run-reset",
    goal: "test",
    status: "failed",
    issueQueue: [{ ...issue, branch, prUrl: null, error: "x" }],
    currentIndex: 0,
    currentStage: null,
    currentStageStartedAt: null,
    activeAgent: null,
    lastHeartbeatAt: null,
    runnerPid: null,
    startedAt: null,
    completedAt: null,
  });

  const handler = makeWorkflowHandler(ws);
  const payload = parseToolResponse(
    await handler({ action: "reset", workflow: "develop" }),
  );

  assert.equal(payload.status, "reset_completed");
  assert.ok(payload.branchesDeleted.includes(branch));
  assert.equal(existsSync(path.join(ws, ".coder", "loop-state.json")), false);
  assert.equal(existsSync(path.join(ws, ".coder", "state.json")), false);

  rmSync(ws, { recursive: true, force: true });
});
