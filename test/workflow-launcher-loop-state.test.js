import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistTerminalLoopState } from "../src/mcp/tools/workflows.js";
import { loadLoopState, saveLoopState } from "../src/state/workflow-state.js";

function makeWs() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-launcher-loop-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

function baseLoop(runId, status = "running") {
  return {
    version: 1,
    runId,
    goal: "g",
    status,
    projectFilter: null,
    maxIssues: null,
    issueQueue: [],
    currentIndex: 0,
    currentStage: "develop_starting",
    currentStageStartedAt: new Date().toISOString(),
    activeAgent: "claude",
    lastHeartbeatAt: new Date().toISOString(),
    runnerPid: 999,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

test("persistTerminalLoopState: marks matching run terminal", async () => {
  const ws = makeWs();
  try {
    await saveLoopState(ws, baseLoop("run-a"));
    const ok = await persistTerminalLoopState(ws, "run-a", "completed");
    assert.equal(ok, true);
    const disk = await loadLoopState(ws);
    assert.equal(disk.status, "completed");
    assert.equal(disk.runId, "run-a");
    assert.equal(disk.currentStage, null);
    assert.equal(disk.runnerPid, null);
    assert.ok(disk.completedAt);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("persistTerminalLoopState: no-op when runId differs (newer run on disk)", async () => {
  const ws = makeWs();
  try {
    await saveLoopState(ws, baseLoop("run-b"));
    const ok = await persistTerminalLoopState(ws, "run-a", "completed");
    assert.equal(ok, false);
    const disk = await loadLoopState(ws);
    assert.equal(disk.runId, "run-b");
    assert.equal(disk.status, "running");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("persistTerminalLoopState: guardRunId prevents clobbering a newer run", async () => {
  const ws = makeWs();
  try {
    await saveLoopState(ws, baseLoop("run-a"));
    const stale = await loadLoopState(ws);
    await saveLoopState(ws, baseLoop("run-b"));
    stale.status = "completed";
    stale.completedAt = new Date().toISOString();
    stale.currentStage = null;
    stale.runnerPid = null;
    const written = await saveLoopState(ws, stale, { guardRunId: "run-a" });
    assert.equal(written, false);
    const disk = await loadLoopState(ws);
    assert.equal(disk.runId, "run-b");
    assert.equal(disk.status, "running");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("saveLoopState: returns true when write proceeds", async () => {
  const ws = makeWs();
  try {
    const written = await saveLoopState(ws, baseLoop("solo"));
    assert.equal(written, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
