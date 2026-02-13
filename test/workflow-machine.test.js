import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActor } from "xstate";
import { getShortestPaths } from "xstate/graph";
import {
  createDevelopWorkflowMachine,
  loadWorkflowSnapshot,
  saveWorkflowSnapshot,
  saveWorkflowTerminalState,
} from "../src/workflow-machine.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-workflow-machine-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

// Candidate events for graph traversal — one representative payload per event type
const traversalEvents = () => [
  {
    type: "START",
    runId: "r1",
    workspace: "/tmp/ws",
    goal: "goal",
    activeAgent: "gemini",
    currentStage: "listing_issues",
    at: "2026-01-01T00:00:00.000Z",
  },
  { type: "HEARTBEAT", at: "2026-01-01T00:01:00.000Z" },
  { type: "STAGE", stage: "implementing", activeAgent: "claude" },
  {
    type: "SYNC",
    loopState: {
      currentStage: "reviewing",
      activeAgent: "codex",
      lastHeartbeatAt: "2026-01-01T00:02:00.000Z",
    },
  },
  { type: "PAUSE", at: "2026-01-01T00:03:00.000Z" },
  { type: "RESUME" },
  { type: "CANCEL", at: "2026-01-01T00:04:00.000Z" },
  { type: "COMPLETE", at: "2026-01-01T00:05:00.000Z" },
  { type: "FAIL", error: "test_error", at: "2026-01-01T00:06:00.000Z" },
  { type: "CANCELLED", at: "2026-01-01T00:07:00.000Z" },
];

// Serialize by state value only so context permutations from HEARTBEAT/STAGE/SYNC
// don't explode the state space — we care about structural transitions
const serializeState = (s) => JSON.stringify(s.value);

// ─── Graph-based: reachability ─────────────────────────────────────────────

test("graph: all 7 states are reachable via shortest paths", () => {
  const machine = createDevelopWorkflowMachine();
  const paths = getShortestPaths(machine, {
    events: traversalEvents,
    serializeState,
  });
  const reachable = new Set(paths.map((p) => p.state.value));
  const expected = new Set([
    "idle",
    "running",
    "paused",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(reachable, expected);
});

// ─── Context invariants: verify assign actions on representative paths ──────

test("graph: completedAt is set when reaching completed via COMPLETE", () => {
  const machine = createDevelopWorkflowMachine();
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START",
    runId: "r1",
    workspace: "/tmp/ws",
    goal: "g",
    at: "2026-01-01T00:00:00.000Z",
  });
  actor.send({ type: "COMPLETE", at: "2026-01-01T01:00:00.000Z" });
  assert.equal(actor.getSnapshot().value, "completed");
  assert.equal(
    actor.getSnapshot().context.completedAt,
    "2026-01-01T01:00:00.000Z",
  );
  assert.equal(actor.getSnapshot().context.error, null);
  actor.stop();
});

test("graph: error and completedAt are set when reaching failed via FAIL", () => {
  const machine = createDevelopWorkflowMachine();
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START",
    runId: "r1",
    workspace: "/tmp/ws",
    goal: "g",
    at: "2026-01-01T00:00:00.000Z",
  });
  actor.send({ type: "FAIL", error: "boom", at: "2026-01-01T01:00:00.000Z" });
  assert.equal(actor.getSnapshot().value, "failed");
  assert.equal(actor.getSnapshot().context.error, "boom");
  assert.ok(actor.getSnapshot().context.completedAt);
  actor.stop();
});

test("graph: cancelRequestedAt is set through cancelling -> cancelled", () => {
  const machine = createDevelopWorkflowMachine();
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START",
    runId: "r1",
    workspace: "/tmp/ws",
    goal: "g",
    at: "2026-01-01T00:00:00.000Z",
  });
  actor.send({ type: "CANCEL", at: "2026-01-01T00:30:00.000Z" });
  assert.equal(actor.getSnapshot().value, "cancelling");
  assert.equal(
    actor.getSnapshot().context.cancelRequestedAt,
    "2026-01-01T00:30:00.000Z",
  );
  actor.send({ type: "CANCELLED", at: "2026-01-01T00:31:00.000Z" });
  assert.equal(actor.getSnapshot().value, "cancelled");
  assert.ok(actor.getSnapshot().context.completedAt);
  assert.equal(actor.getSnapshot().context.error, null);
  actor.stop();
});

// ─── Graph-based: terminal state immutability ──────────────────────────────

test("graph: terminal states are immutable — no event changes state or context", () => {
  const machine = createDevelopWorkflowMachine();
  const terminalStates = ["completed", "failed", "cancelled"];
  const paths = getShortestPaths(machine, {
    events: traversalEvents,
    serializeState,
  });
  const poisonEvents = [
    { type: "START", runId: "x", workspace: "/x", goal: "x" },
    { type: "HEARTBEAT", at: "2099-01-01T00:00:00Z" },
    { type: "FAIL", error: "injected" },
    { type: "COMPLETE", at: "2099-01-01T00:00:00Z" },
    { type: "CANCEL", at: "2099-01-01T00:00:00Z" },
    { type: "PAUSE", at: "2099-01-01T00:00:00Z" },
    { type: "RESUME" },
  ];

  for (const p of paths) {
    if (!terminalStates.includes(p.state.value)) continue;
    const actor = createActor(machine);
    actor.start();
    for (const step of p.steps) actor.send(step.event);
    const before = JSON.stringify(actor.getSnapshot().context);
    for (const evt of poisonEvents) actor.send(evt);
    const after = actor.getSnapshot();
    assert.equal(after.value, p.state.value, "state should not change");
    assert.equal(
      JSON.stringify(after.context),
      before,
      `context mutated in terminal ${p.state.value}`,
    );
    actor.stop();
  }
});

// ─── Targeted context mutation tests ───────────────────────────────────────

test("SYNC updates stage/agent/heartbeat from loopState", () => {
  const actor = createActor(createDevelopWorkflowMachine());
  actor.start();
  actor.send({
    type: "START",
    runId: "sync-01",
    workspace: "/tmp/ws",
    goal: "goal",
    at: "2026-01-01T00:00:00.000Z",
  });
  actor.send({
    type: "SYNC",
    loopState: {
      currentStage: "implementing",
      activeAgent: "claude",
      lastHeartbeatAt: "2026-01-01T00:03:00.000Z",
    },
  });
  assert.equal(actor.getSnapshot().value, "running");
  assert.equal(actor.getSnapshot().context.currentStage, "implementing");
  assert.equal(actor.getSnapshot().context.activeAgent, "claude");
  assert.equal(
    actor.getSnapshot().context.lastHeartbeatAt,
    "2026-01-01T00:03:00.000Z",
  );
  actor.stop();
});

test("HEARTBEAT updates lastHeartbeatAt without changing state", () => {
  const actor = createActor(createDevelopWorkflowMachine());
  actor.start();
  actor.send({
    type: "START",
    runId: "hb-01",
    workspace: "/tmp/ws",
    goal: "goal",
    at: "2026-01-01T00:00:00.000Z",
  });
  actor.send({ type: "HEARTBEAT", at: "2026-01-01T00:05:00.000Z" });
  assert.equal(actor.getSnapshot().value, "running");
  assert.equal(
    actor.getSnapshot().context.lastHeartbeatAt,
    "2026-01-01T00:05:00.000Z",
  );
  actor.stop();
});

test("SYNC with invalid loopState is a no-op on context", () => {
  const actor = createActor(createDevelopWorkflowMachine());
  actor.start();
  actor.send({
    type: "START",
    runId: "sync-noop",
    workspace: "/tmp/ws",
    goal: "goal",
    at: "2026-01-01T00:00:00.000Z",
  });
  const before = JSON.stringify(actor.getSnapshot().context);
  actor.send({ type: "SYNC", loopState: null });
  actor.send({ type: "SYNC", loopState: "garbage" });
  assert.equal(JSON.stringify(actor.getSnapshot().context), before);
  actor.stop();
});

test("STAGE updates currentStage and activeAgent", () => {
  const actor = createActor(createDevelopWorkflowMachine());
  actor.start();
  actor.send({
    type: "START",
    runId: "stage-01",
    workspace: "/tmp/ws",
    goal: "goal",
    at: "2026-01-01T00:00:00.000Z",
  });
  actor.send({ type: "STAGE", stage: "planning", activeAgent: "codex" });
  assert.equal(actor.getSnapshot().context.currentStage, "planning");
  assert.equal(actor.getSnapshot().context.activeAgent, "codex");
  actor.stop();
});

test("initRun resets transient fields and populates run metadata", () => {
  const actor = createActor(createDevelopWorkflowMachine());
  actor.start();
  actor.send({
    type: "START",
    runId: "init-01",
    workspace: "/tmp/ws",
    goal: "test goal",
    activeAgent: "gemini",
    currentStage: "listing_issues",
    at: "2026-01-01T00:00:00.000Z",
  });
  const ctx = actor.getSnapshot().context;
  assert.equal(ctx.runId, "init-01");
  assert.equal(ctx.workspace, "/tmp/ws");
  assert.equal(ctx.goal, "test goal");
  assert.equal(ctx.activeAgent, "gemini");
  assert.equal(ctx.currentStage, "listing_issues");
  assert.equal(ctx.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(ctx.completedAt, null);
  assert.equal(ctx.pauseRequestedAt, null);
  assert.equal(ctx.cancelRequestedAt, null);
  assert.equal(ctx.error, null);
  actor.stop();
});

// ─── Persistence tests ────────────────────────────────────────────────────

test("workflow snapshot persistence writes and loads disk state", () => {
  const ws = makeWorkspace();
  const actor = createActor(createDevelopWorkflowMachine());
  actor.start();
  actor.send({
    type: "START",
    runId: "deadbeef",
    workspace: ws,
    goal: "goal",
    activeAgent: "gemini",
    currentStage: "listing_issues",
    at: "2026-01-01T00:00:00.000Z",
  });
  const saved = saveWorkflowSnapshot(ws, {
    runId: "deadbeef",
    snapshot: actor.getPersistedSnapshot(),
    sqlitePath: path.join(ws, ".coder", "state.db"),
  });
  assert.equal(saved.runId, "deadbeef");
  assert.equal(saved.workflow, "auto");
  const loaded = loadWorkflowSnapshot(ws);
  assert.equal(loaded.runId, "deadbeef");
  assert.equal(loaded.value, "running");
  assert.equal(loaded.context.currentStage, "listing_issues");
  actor.stop();
});

test("loadWorkflowSnapshot returns null on non-existent file", () => {
  const ws = makeWorkspace();
  const loaded = loadWorkflowSnapshot(ws);
  assert.equal(loaded, null);
});

test("saveWorkflowTerminalState persists terminal value", () => {
  const ws = makeWorkspace();
  const saved = saveWorkflowTerminalState(ws, {
    runId: "cafebabe",
    state: "cancelled",
    context: { runId: "cafebabe", workflow: "develop" },
    sqlitePath: path.join(ws, ".coder", "state.db"),
  });
  assert.equal(saved.runId, "cafebabe");
  assert.equal(saved.value, "cancelled");

  const loaded = loadWorkflowSnapshot(ws);
  assert.equal(loaded.runId, "cafebabe");
  assert.equal(loaded.value, "cancelled");
});
