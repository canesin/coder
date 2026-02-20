import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActor } from "xstate";
import {
  createWorkflowLifecycleMachine,
  loadLoopState,
  loadState,
  loadWorkflowSnapshot,
  loopStatePathFor,
  saveLoopState,
  saveState,
  saveWorkflowSnapshot,
  saveWorkflowTerminalState,
  statePathFor,
} from "../src/state/workflow-state.js";

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-wf-state-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

test("statePathFor returns expected path", () => {
  assert.equal(statePathFor("/foo"), path.join("/foo", ".coder", "state.json"));
});

test("loopStatePathFor returns expected path", () => {
  assert.equal(
    loopStatePathFor("/foo"),
    path.join("/foo", ".coder", "loop-state.json"),
  );
});

test("loadState returns defaults for nonexistent workspace", async () => {
  const state = await loadState("/nonexistent-path-" + Date.now());
  assert.equal(state.selected, null);
  assert.equal(state.repoPath, null);
  assert.deepEqual(state.steps, {});
});

test("saveState + loadState round-trip", async () => {
  const ws = makeTmpDir();
  const state = {
    selected: { source: "github", id: "123", title: "Test issue" },
    selectedProject: null,
    linearProjects: null,
    repoPath: ".",
    baseBranch: "main",
    branch: "feat/test",
    questions: null,
    answers: null,
    steps: { wroteIssue: true },
    claudeSessionId: null,
    lastError: null,
    reviewFingerprint: null,
    reviewedAt: null,
    prUrl: null,
    prBranch: null,
    prBase: null,
    scratchpadPath: null,
    lastWipPushAt: null,
  };
  await saveState(ws, state);
  const loaded = await loadState(ws);
  assert.equal(loaded.selected.id, "123");
  assert.equal(loaded.repoPath, ".");
  assert.equal(loaded.steps.wroteIssue, true);
  rmSync(ws, { recursive: true, force: true });
});

test("loadLoopState returns defaults for nonexistent workspace", async () => {
  const state = await loadLoopState("/nonexistent-path-" + Date.now());
  assert.equal(state.status, "idle");
  assert.equal(state.runId, null);
  assert.deepEqual(state.issueQueue, []);
});

test("saveLoopState + loadLoopState round-trip", async () => {
  const ws = makeTmpDir();
  const state = {
    runId: "abc123",
    goal: "test goal",
    status: "running",
    projectFilter: null,
    maxIssues: 5,
    issueQueue: [],
    currentIndex: 0,
    currentStage: "listing_issues",
    currentStageStartedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    runnerPid: process.pid,
    activeAgent: "gemini",
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  await saveLoopState(ws, state);
  const loaded = await loadLoopState(ws);
  assert.equal(loaded.runId, "abc123");
  assert.equal(loaded.status, "running");
  assert.equal(loaded.goal, "test goal");
  rmSync(ws, { recursive: true, force: true });
});

test("createWorkflowLifecycleMachine transitions correctly", () => {
  const machine = createWorkflowLifecycleMachine();
  const actor = createActor(machine);
  actor.start();

  // Initially idle
  let snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "idle");

  // START -> running
  actor.send({
    type: "START",
    runId: "test-run",
    workspace: "/tmp",
    workflow: "develop",
    goal: "test",
    at: new Date().toISOString(),
  });
  snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "running");
  assert.equal(snapshot.context.runId, "test-run");

  // PAUSE -> paused
  actor.send({ type: "PAUSE", at: new Date().toISOString() });
  snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "paused");

  // RESUME -> running
  actor.send({ type: "RESUME", at: new Date().toISOString() });
  snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "running");

  // COMPLETE -> completed
  actor.send({ type: "COMPLETE", at: new Date().toISOString() });
  snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "completed");

  actor.stop();
});

test("createWorkflowLifecycleMachine handles cancel flow", () => {
  const machine = createWorkflowLifecycleMachine();
  const actor = createActor(machine);
  actor.start();

  actor.send({ type: "START", runId: "run2", at: new Date().toISOString() });
  actor.send({ type: "CANCEL", at: new Date().toISOString() });
  let snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "cancelling");

  actor.send({ type: "CANCELLED", at: new Date().toISOString() });
  snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "cancelled");

  actor.stop();
});

test("createWorkflowLifecycleMachine handles fail from running", () => {
  const machine = createWorkflowLifecycleMachine();
  const actor = createActor(machine);
  actor.start();

  actor.send({ type: "START", runId: "run3", at: new Date().toISOString() });
  actor.send({
    type: "FAIL",
    at: new Date().toISOString(),
    error: "test error",
  });
  const snapshot = actor.getSnapshot();
  assert.equal(snapshot.value, "failed");
  assert.equal(snapshot.context.error, "test error");

  actor.stop();
});

test("saveWorkflowSnapshot + loadWorkflowSnapshot round-trip", async () => {
  const ws = makeTmpDir();
  const machine = createWorkflowLifecycleMachine();
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START",
    runId: "snap-run",
    workflow: "develop",
    at: new Date().toISOString(),
  });

  await saveWorkflowSnapshot(ws, {
    runId: "snap-run",
    workflow: "develop",
    snapshot: actor.getPersistedSnapshot(),
  });

  const loaded = await loadWorkflowSnapshot(ws);
  assert.equal(loaded.runId, "snap-run");
  assert.equal(loaded.workflow, "develop");
  assert.equal(loaded.value, "running");

  actor.stop();
  rmSync(ws, { recursive: true, force: true });
});

test("saveWorkflowTerminalState persists terminal state", async () => {
  const ws = makeTmpDir();
  await saveWorkflowTerminalState(ws, {
    runId: "term-run",
    workflow: "research",
    state: "completed",
    context: { runId: "term-run", workflow: "research" },
  });

  const loaded = await loadWorkflowSnapshot(ws);
  assert.equal(loaded.runId, "term-run");
  assert.equal(loaded.value, "completed");
  assert.equal(loaded.workflow, "research");

  rmSync(ws, { recursive: true, force: true });
});
