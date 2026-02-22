import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assign, setup } from "xstate";
import { z } from "zod";
import {
  runSqliteIgnoreErrors,
  sqlEscape,
  sqliteAvailable,
} from "../sqlite.js";

const WORKFLOW_STATE_SCHEMA_VERSION = 2;

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
  { runId, workflow = "develop", snapshot, sqlitePath = "" },
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
  { runId, workflow = "develop", state, context = {}, sqlitePath = "" },
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

/**
 * Creates the XState machine for workflow lifecycle (shared by all workflow types).
 * States: idle -> running -> paused/cancelling -> completed/failed/cancelled
 */
export function createWorkflowLifecycleMachine() {
  return setup({
    actions: {
      initRun: assign(({ event }) => ({
        runId: event.runId || null,
        workspace: event.workspace || null,
        workflow: event.workflow || "develop",
        goal: event.goal || "",
        activeAgent: event.activeAgent || null,
        currentStage: event.currentStage || null,
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
      syncState: assign(({ context, event }) => {
        const s = event.state;
        if (!s || typeof s !== "object") return {};
        return {
          currentStage: s.currentStage || context.currentStage || null,
          activeAgent: s.activeAgent || context.activeAgent || null,
          lastHeartbeatAt: s.lastHeartbeatAt || context.lastHeartbeatAt,
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
    id: "coderWorkflowLifecycle",
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
          SYNC: { actions: "syncState" },
          PAUSE: { target: "paused", actions: "markPaused" },
          CANCEL: { target: "cancelling", actions: "markCancelRequested" },
          COMPLETE: { target: "completed", actions: "stampCompletedAt" },
          FAIL: { target: "failed", actions: "markFailed" },
          CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },
        },
      },
      paused: {
        on: {
          SYNC: { actions: "syncState" },
          RESUME: { target: "running" },
          CANCEL: { target: "cancelling", actions: "markCancelRequested" },
          COMPLETE: { target: "completed", actions: "stampCompletedAt" },
          FAIL: { target: "failed", actions: "markFailed" },
          CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },
        },
      },
      cancelling: {
        on: {
          SYNC: { actions: "syncState" },
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

// --- Loop state (for develop workflow's multi-issue loop) ---

const LoopIssueResultSchema = z
  .object({
    source: z.enum(["github", "linear", "local"]),
    id: z.string().min(1),
    title: z.string(),
    repoPath: z.string().default(""),
    baseBranch: z.string().nullable().default(null),
    status: z.enum([
      "pending",
      "in_progress",
      "completed",
      "failed",
      "skipped",
      "deferred",
    ]),
    branch: z.string().nullable().default(null),
    prUrl: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    startedAt: z.string().nullable().default(null),
    completedAt: z.string().nullable().default(null),
    dependsOn: z.array(z.string()).default([]),
  })
  .passthrough();

const LoopStateSchema = z.object({
  runId: z.string().nullable().default(null),
  goal: z.string().default(""),
  status: z
    .enum(["idle", "running", "paused", "completed", "failed", "cancelled"])
    .default("idle"),
  projectFilter: z.string().nullable().default(null),
  maxIssues: z.number().int().nullable().default(null),
  issueQueue: z.array(LoopIssueResultSchema).default([]),
  currentIndex: z.number().int().default(0),
  currentStage: z.string().nullable().default(null),
  currentStageStartedAt: z.string().nullable().default(null),
  lastHeartbeatAt: z.string().nullable().default(null),
  runnerPid: z.number().int().nullable().default(null),
  activeAgent: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export function loopStatePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "loop-state.json");
}

export function loadLoopState(workspaceDir) {
  const p = loopStatePathFor(workspaceDir);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return LoopStateSchema.parse(raw);
  } catch {
    return LoopStateSchema.parse({});
  }
}

export function saveLoopState(workspaceDir, loopState) {
  const p = loopStatePathFor(workspaceDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(loopState, null, 2) + "\n");
}

// --- Per-issue state ---

const SelectedIssueSchema = z.object({
  source: z.enum(["github", "linear", "local"]),
  id: z.string().min(1),
  title: z.string().min(1),
  repo_path: z.string().default(""),
  difficulty: z.number().int().min(1).max(5).optional(),
  reason: z.string().default(""),
});

const StepsSchema = z
  .object({
    listedProjects: z.boolean().optional(),
    listedIssues: z.boolean().optional(),
    verifiedCleanRepo: z.boolean().optional(),
    wroteIssue: z.boolean().optional(),
    wrotePlan: z.boolean().optional(),
    wroteCritique: z.boolean().optional(),
    implemented: z.boolean().optional(),
    reviewerCompleted: z.boolean().optional(),
    reviewRound: z.number().int().min(0).optional(),
    reviewVerdict: z.enum(["APPROVED", "REVISE"]).optional(),
    programmerFixedRound: z.number().int().min(0).optional(),
    ppcommitInitiallyClean: z.boolean().optional(),
    ppcommitClean: z.boolean().optional(),
    testsPassed: z.boolean().optional(),
    prCreated: z.boolean().optional(),
  })
  .default({});

const LinearProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string().default(""),
});

const IssueStateSchema = z
  .object({
    selected: SelectedIssueSchema.nullable().default(null),
    selectedProject: LinearProjectSchema.nullable().default(null),
    linearProjects: z.array(LinearProjectSchema).nullable().default(null),
    repoPath: z.string().nullable().default(null),
    baseBranch: z.string().nullable().default(null),
    branch: z.string().nullable().default(null),
    questions: z.array(z.string()).nullable().default(null),
    answers: z.array(z.string()).nullable().default(null),
    issuesPayload: z.any().optional(),
    steps: StepsSchema,
    claudeSessionId: z.string().nullable().default(null),
    reviewerSessionId: z.string().nullable().default(null),
    lastError: z.string().nullable().default(null),
    reviewFingerprint: z.string().nullable().default(null),
    reviewedAt: z.string().nullable().default(null),
    prUrl: z.string().nullable().default(null),
    prBranch: z.string().nullable().default(null),
    prBase: z.string().nullable().default(null),
    scratchpadPath: z.string().nullable().default(null),
    lastWipPushAt: z.string().nullable().default(null),
  })
  .passthrough();

const DEFAULT_ISSUE_STATE = {
  selected: null,
  selectedProject: null,
  linearProjects: null,
  repoPath: null,
  baseBranch: null,
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

export function statePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "state.json");
}

export function loadState(workspaceDir) {
  const p = statePathFor(workspaceDir);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return IssueStateSchema.parse(raw);
  } catch {
    return { ...DEFAULT_ISSUE_STATE };
  }
}

export function saveState(workspaceDir, state) {
  const p = statePathFor(workspaceDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}
