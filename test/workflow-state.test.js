import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActor } from "xstate";
import {
  __setBeforeAtomicWriteJsonForTests,
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

function deferred() {
  /** @type {(value?: void | PromiseLike<void>) => void} */
  let resolve;
  /** @type {(reason?: unknown) => void} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeIssueState(id, title = `Issue ${id}`) {
  return {
    selected: { source: "github", id: String(id), title },
    selectedProject: null,
    linearProjects: null,
    repoPath: ".",
    baseBranch: "main",
    branch: null,
    questions: null,
    answers: null,
    steps: {},
    claudeSessionId: null,
    reviewerSessionId: null,
    lastError: null,
    reviewFingerprint: null,
    reviewedAt: null,
    prUrl: null,
    prBranch: null,
    prBase: null,
    scratchpadPath: null,
    lastWipPushAt: null,
  };
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

test("saveState + loadState round-trip with gitlab source", async () => {
  const ws = makeTmpDir();
  const state = {
    selected: { source: "gitlab", id: "42", title: "Add health endpoint" },
    selectedProject: null,
    linearProjects: null,
    repoPath: ".",
    baseBranch: "main",
    branch: "feat/add-health-endpoint_GL_42",
    questions: null,
    answers: null,
    steps: {},
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
  assert.equal(loaded.selected.source, "gitlab");
  assert.equal(loaded.selected.id, "42");
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

test("concurrent saveState calls serialize without errors", async () => {
  const ws = makeTmpDir();
  const writes = [];
  for (let i = 0; i < 5; i++) {
    writes.push(saveState(ws, makeIssueState(i)));
  }
  await Promise.all(writes);
  const loaded = await loadState(ws);
  assert.ok(loaded.selected);
  // Last write wins — id should be "4"
  assert.equal(loaded.selected.id, "4");
  rmSync(ws, { recursive: true, force: true });
});

test("concurrent saveState calls for different workspaces do not share a write chain", async () => {
  const ws1 = makeTmpDir();
  const ws2 = makeTmpDir();
  const startedAt = Date.now();
  const finishedAt = {};
  const bigState = makeIssueState("big", "x".repeat(128 * 1024 * 1024));

  const slowWrite = saveState(ws1, bigState).then(() => {
    finishedAt.big = Date.now() - startedAt;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const fastWrite = saveState(ws2, makeIssueState("small")).then(() => {
    finishedAt.small = Date.now() - startedAt;
  });

  await Promise.all([slowWrite, fastWrite]);

  assert.ok(finishedAt.small < finishedAt.big, `${JSON.stringify(finishedAt)}`);

  const [state1, state2] = await Promise.all([loadState(ws1), loadState(ws2)]);
  assert.equal(state1.selected?.id, "big");
  assert.equal(state2.selected?.id, "small");

  rmSync(ws1, { recursive: true, force: true });
  rmSync(ws2, { recursive: true, force: true });
});

test("concurrent saveWorkflowSnapshot calls serialize without errors", async () => {
  const ws = makeTmpDir();
  const machine = createWorkflowLifecycleMachine();
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START",
    runId: "concurrent-run",
    workflow: "develop",
    at: new Date().toISOString(),
  });

  const writes = [];
  for (let i = 0; i < 5; i++) {
    writes.push(
      saveWorkflowSnapshot(ws, {
        runId: `run-${i}`,
        workflow: "develop",
        snapshot: actor.getPersistedSnapshot(),
      }),
    );
  }
  await Promise.all(writes);
  const loaded = await loadWorkflowSnapshot(ws);
  assert.ok(loaded);
  // Last write wins
  assert.equal(loaded.runId, "run-4");

  actor.stop();
  rmSync(ws, { recursive: true, force: true });
});

test("cross-workspace concurrent writes are isolated", async (t) => {
  const wsA = makeTmpDir();
  const wsB = makeTmpDir();
  const wsAPath = statePathFor(wsA);
  const writeBlocked = deferred();
  const writeStarted = deferred();
  let wsBResolved = false;

  __setBeforeAtomicWriteJsonForTests(async (filePath) => {
    if (filePath !== wsAPath) return;
    writeStarted.resolve();
    await writeBlocked.promise;
  });
  t.after(() => __setBeforeAtomicWriteJsonForTests(null));

  const writeA = saveState(wsA, {
    selected: { source: "github", id: "A-0", title: "Issue A-0" },
    selectedProject: null,
    linearProjects: null,
    repoPath: ".",
    baseBranch: "main",
    branch: null,
    questions: null,
    answers: null,
    steps: {},
    claudeSessionId: null,
    lastError: null,
    reviewFingerprint: null,
    reviewedAt: null,
    prUrl: null,
    prBranch: null,
    prBase: null,
    scratchpadPath: null,
    lastWipPushAt: null,
  });
  await writeStarted.promise;

  const writeB = saveState(wsB, {
    selected: { source: "github", id: "B-0", title: "Issue B-0" },
    selectedProject: null,
    linearProjects: null,
    repoPath: ".",
    baseBranch: "main",
    branch: null,
    questions: null,
    answers: null,
    steps: {},
    claudeSessionId: null,
    lastError: null,
    reviewFingerprint: null,
    reviewedAt: null,
    prUrl: null,
    prBranch: null,
    prBase: null,
    scratchpadPath: null,
    lastWipPushAt: null,
  }).then(() => {
    wsBResolved = true;
  });

  await assert.doesNotReject(writeB);
  assert.equal(wsBResolved, true);

  writeBlocked.resolve();
  await assert.doesNotReject(writeA);

  const [stateA, stateB] = await Promise.all([loadState(wsA), loadState(wsB)]);
  assert.ok(stateA.selected);
  assert.ok(stateB.selected);
  assert.equal(stateA.selected.id, "A-0");
  assert.equal(stateB.selected.id, "B-0");

  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
});
