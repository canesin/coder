import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeRuns,
  applyLauncherNormalCompletion,
  startWorkflowActor,
} from "../src/mcp/tools/workflows.js";
import {
  loadLoopState,
  loadWorkflowSnapshot,
  saveLoopState,
} from "../src/state/workflow-state.js";

function makeWs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-launcher-e2e-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function runLauncherNormalCompletionFixture(result) {
  const ws = makeWs();
  const runId = "e2eRun01";
  try {
    await saveLoopState(ws, {
      version: 1,
      runId,
      goal: "g",
      status: "running",
      projectFilter: null,
      maxIssues: null,
      issueQueue: [],
      currentIndex: 0,
      currentStage: "develop_starting",
      currentStageStartedAt: new Date().toISOString(),
      activeAgent: "gemini",
      lastHeartbeatAt: new Date().toISOString(),
      runnerPid: process.pid,
      startedAt: new Date().toISOString(),
      completedAt: null,
    });

    startWorkflowActor({
      workflow: "develop",
      workspaceDir: ws,
      runId,
      goal: "g",
      initialAgent: "gemini",
      currentStage: "develop_starting",
    });

    const mockPool = { killAll: async () => {} };
    activeRuns.set(runId, {
      cancelToken: { cancelled: false, paused: false },
      agentPool: mockPool,
      workspace: ws,
      promise: Promise.resolve(),
      startedAt: new Date().toISOString(),
    });

    await applyLauncherNormalCompletion({
      workspaceDir: ws,
      runId,
      result,
      agentPool: mockPool,
    });

    await sleep(40);
    const loop = await loadLoopState(ws);
    const snap = await loadWorkflowSnapshot(ws);
    return { loop, snap };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test("launcher normal path: completed aligns loop-state and workflow snapshot", async () => {
  const { loop, snap } = await runLauncherNormalCompletionFixture({
    status: "completed",
  });
  assert.equal(loop.status, "completed");
  assert.ok(loop.completedAt);
  assert.ok(snap);
  assert.equal(snap.value, "completed");
  assert.equal(snap.runId, "e2eRun01");
});

test("launcher normal path: failed aligns loop-state and workflow snapshot", async () => {
  const { loop, snap } = await runLauncherNormalCompletionFixture({
    status: "failed",
    error: "issue list blew up",
  });
  assert.equal(loop.status, "failed");
  assert.ok(snap);
  assert.equal(snap.value, "failed");
  assert.equal(snap.context?.error, "issue list blew up");
});

test("launcher normal path: blocked aligns loop-state and workflow snapshot", async () => {
  const { loop, snap } = await runLauncherNormalCompletionFixture({
    status: "blocked",
  });
  assert.equal(loop.status, "blocked");
  assert.ok(snap);
  assert.equal(snap.value, "blocked");
});
