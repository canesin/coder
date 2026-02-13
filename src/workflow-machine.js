import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assign, setup } from "xstate";
import { runSqliteIgnoreErrors, sqlEscape, sqliteAvailable } from "./sqlite.js";

const WORKFLOW_STATE_SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function persistSnapshotToSqlite(sqlitePath, payload) {
  if (!sqlitePath || !sqliteAvailable()) return;
  mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const valueJson = JSON.stringify(payload.value ?? null);
  const contextJson = JSON.stringify(payload.context ?? {});
  const sql = `
CREATE TABLE IF NOT EXISTS workflow_state_snapshots (
  workflow TEXT NOT NULL,
  run_id TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  context_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO workflow_state_snapshots (workflow, run_id, state_value, context_json, updated_at)
VALUES ('${sqlEscape(payload.workflow)}', '${sqlEscape(payload.runId)}', '${sqlEscape(valueJson)}', '${sqlEscape(contextJson)}', '${sqlEscape(payload.updatedAt)}')
ON CONFLICT(run_id) DO UPDATE SET
  workflow=excluded.workflow,
  state_value=excluded.state_value,
  context_json=excluded.context_json,
  updated_at=excluded.updated_at;
`;
  runSqliteIgnoreErrors(sqlitePath, sql);
}

export function workflowStatePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "workflow-state.json");
}

export function saveWorkflowSnapshot(
  workspaceDir,
  { runId, workflow = "auto", snapshot, sqlitePath = "" },
) {
  if (!runId || !snapshot) return null;
  const payload = {
    version: WORKFLOW_STATE_SCHEMA_VERSION,
    workflow,
    runId,
    value: snapshot.value,
    context: snapshot.context,
    updatedAt: nowIso(),
  };
  const statePath = workflowStatePathFor(workspaceDir);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  persistSnapshotToSqlite(sqlitePath, payload);
  return payload;
}

export function saveWorkflowTerminalState(
  workspaceDir,
  { runId, workflow = "auto", state, context = {}, sqlitePath = "" },
) {
  if (!runId || !state) return null;
  const payload = {
    version: WORKFLOW_STATE_SCHEMA_VERSION,
    workflow,
    runId,
    value: state,
    context,
    updatedAt: nowIso(),
  };
  const statePath = workflowStatePathFor(workspaceDir);
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  persistSnapshotToSqlite(sqlitePath, payload);
  return payload;
}

export function loadWorkflowSnapshot(workspaceDir) {
  const p = workflowStatePathFor(workspaceDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function createDevelopWorkflowMachine() {
  return setup({
    actions: {
      initRun: assign(({ event }) => ({
        runId: event.runId || null,
        workspace: event.workspace || null,
        goal: event.goal || "",
        activeAgent: event.activeAgent || null,
        currentStage: event.currentStage || "listing_issues",
        startedAt: event.at || nowIso(),
        lastHeartbeatAt: event.at || nowIso(),
        completedAt: null,
        pauseRequestedAt: null,
        cancelRequestedAt: null,
        error: null,
      })),
      recordHeartbeat: assign(({ event }) => ({
        lastHeartbeatAt: event.at || nowIso(),
      })),
      updateStage: assign(({ context, event }) => ({
        currentStage: event.stage || context.currentStage,
        activeAgent: event.activeAgent || context.activeAgent,
      })),
      syncLoopState: assign(({ context, event }) => {
        const ls = event.loopState;
        if (!ls || typeof ls !== "object") return {};
        return {
          currentStage: ls.currentStage || context.currentStage || null,
          activeAgent: ls.activeAgent || context.activeAgent || null,
          lastHeartbeatAt: ls.lastHeartbeatAt || context.lastHeartbeatAt,
        };
      }),
      markPaused: assign(({ event }) => ({
        pauseRequestedAt: event.at || nowIso(),
      })),
      markCancelRequested: assign(({ event }) => ({
        cancelRequestedAt: event.at || nowIso(),
      })),
      stampCompletedAt: assign(({ event }) => ({
        completedAt: event.at || nowIso(),
      })),
      markFailed: assign(({ event }) => ({
        error: event.error || "unknown_error",
        completedAt: event.at || nowIso(),
      })),
    },
  }).createMachine({
    id: "coderDevelopWorkflow",
    initial: "idle",
    context: {
      workflow: "develop",
      runId: null,
      workspace: null,
      goal: "",
      activeAgent: null,
      currentStage: null,
      startedAt: null,
      completedAt: null,
      lastHeartbeatAt: null,
      pauseRequestedAt: null,
      cancelRequestedAt: null,
      error: null,
    },
    states: {
      idle: {
        on: {
          START: { target: "running", actions: "initRun" },
        },
      },
      running: {
        on: {
          HEARTBEAT: { actions: "recordHeartbeat" },
          STAGE: { actions: "updateStage" },
          SYNC: { actions: "syncLoopState" },
          PAUSE: { target: "paused", actions: "markPaused" },
          CANCEL: { target: "cancelling", actions: "markCancelRequested" },
          COMPLETE: { target: "completed", actions: "stampCompletedAt" },
          FAIL: { target: "failed", actions: "markFailed" },
          CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },
        },
      },
      paused: {
        on: {
          SYNC: { actions: "syncLoopState" },
          RESUME: { target: "running" },
          CANCEL: { target: "cancelling", actions: "markCancelRequested" },
          COMPLETE: { target: "completed", actions: "stampCompletedAt" },
          FAIL: { target: "failed", actions: "markFailed" },
          CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },
        },
      },
      cancelling: {
        on: {
          SYNC: { actions: "syncLoopState" },
          COMPLETE: { target: "completed", actions: "stampCompletedAt" },
          FAIL: { target: "failed", actions: "markFailed" },
          CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },
        },
      },
      completed: { type: "final" },
      failed: { type: "final" },
      cancelled: { type: "final" },
    },
  });
}
