import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assign, setup } from "xstate";
import { z } from "zod";
import {
  runSqliteAsyncIgnoreErrors,
  sqlEscape,
  sqliteAvailable,
} from "../sqlite.js";

const WORKFLOW_STATE_SCHEMA_VERSION = 2;

/** @type {Map<string, Promise<void>>} */
const _writeChains = new Map();
/** @type {Map<string, Promise<void>>} */
const _sqliteWriteChains = new Map();
/** @type {null | ((filePath: string, data: unknown) => Promise<void> | void)} */
let _beforeAtomicWriteJsonForTests = null;

function getWriteChain(key) {
  return _writeChains.get(key) || Promise.resolve();
}

function setWriteChain(key, promise) {
  _writeChains.set(key, promise);
  // Prune the entry once the chain settles to avoid unbounded Map growth
  promise.then(
    () => {
      if (_writeChains.get(key) === promise) _writeChains.delete(key);
    },
    () => {
      if (_writeChains.get(key) === promise) _writeChains.delete(key);
    },
  );
}

/**
 * Return the current write-chain promise for a workspace (resolves
 * immediately if no writes are pending).  Does NOT guarantee global
 * quiescence — new writes appended after this call are not covered.
 */
export function drainWriteChain(workspaceDir) {
  return getWriteChain(workspaceDir);
}

/** Synchronous check: true when a write-chain entry exists for `key`. */
export function hasWriteChain(key) {
  return _writeChains.has(key);
}

function nowIso() {
  return new Date().toISOString();
}

async function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  let op = "mkdir";
  try {
    await mkdir(dir, { recursive: true });
    op = "write";
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    op = "rename";
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {}
    const code = err.code ? ` (${err.code})` : "";
    throw new Error(
      `Failed to write state ${filePath} [${op}]${code}: ${err.message}`,
    );
  }
}

async function writeJson(filePath, data) {
  await _beforeAtomicWriteJsonForTests?.(filePath, data);
  await atomicWriteJson(filePath, data);
}

export function __setBeforeAtomicWriteJsonForTests(fn) {
  _beforeAtomicWriteJsonForTests = fn || null;
}

async function _persistSnapshotToSqliteInner(sqlitePath, payload) {
  await mkdir(path.dirname(sqlitePath), { recursive: true });
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
  await runSqliteAsyncIgnoreErrors(sqlitePath, sql);
}

async function persistSnapshotToSqlite(sqlitePath, payload) {
  if (!sqlitePath || !sqliteAvailable()) return;
  const chain = (_sqliteWriteChains.get(sqlitePath) || Promise.resolve())
    .then(() => _persistSnapshotToSqliteInner(sqlitePath, payload))
    .catch(() => {});
  _sqliteWriteChains.set(sqlitePath, chain);
  // Prune the entry once the chain settles to avoid unbounded Map growth
  chain.then(() => {
    if (_sqliteWriteChains.get(sqlitePath) === chain)
      _sqliteWriteChains.delete(sqlitePath);
  });
  await chain;
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readGuardRunId(statePath, guardRunId) {
  if (!guardRunId) return false;
  if (!(await fileExists(statePath))) return false;
  try {
    const existing = JSON.parse(await readFile(statePath, "utf8"));
    if (existing.runId && existing.runId !== guardRunId) return true;
  } catch {}
  return false;
}

export function workflowStatePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "workflow-state.json");
}

export async function saveWorkflowSnapshot(
  workspaceDir,
  { runId, workflow = "develop", snapshot, sqlitePath = "", guardRunId = "" },
) {
  if (!runId || !snapshot) return null;
  const statePath = workflowStatePathFor(workspaceDir);
  const payload = {
    version: WORKFLOW_STATE_SCHEMA_VERSION,
    workflow,
    runId,
    value: snapshot.value,
    context: snapshot.context,
    updatedAt: nowIso(),
  };
  let writeErr;
  let guarded = false;
  const chain = getWriteChain(workspaceDir)
    .then(async () => {
      if (await readGuardRunId(statePath, guardRunId)) {
        guarded = true;
        return;
      }
      await writeJson(statePath, payload);
    })
    .catch((e) => {
      writeErr = e;
    });
  setWriteChain(workspaceDir, chain);
  await chain;
  if (guarded) return null;
  if (writeErr) throw writeErr;
  await persistSnapshotToSqlite(sqlitePath, payload);
  return payload;
}

export async function saveWorkflowTerminalState(
  workspaceDir,
  {
    runId,
    workflow = "develop",
    state,
    context = {},
    sqlitePath = "",
    guardRunId = "",
  },
) {
  if (!runId || !state) return null;
  const statePath = workflowStatePathFor(workspaceDir);
  const payload = {
    version: WORKFLOW_STATE_SCHEMA_VERSION,
    workflow,
    runId,
    value: state,
    context,
    updatedAt: nowIso(),
  };
  let writeErr;
  let guarded = false;
  const chain = getWriteChain(workspaceDir)
    .then(async () => {
      if (await readGuardRunId(statePath, guardRunId)) {
        guarded = true;
        return;
      }
      await writeJson(statePath, payload);
    })
    .catch((e) => {
      writeErr = e;
    });
  setWriteChain(workspaceDir, chain);
  await chain;
  if (guarded) return null;
  if (writeErr) throw writeErr;
  await persistSnapshotToSqlite(sqlitePath, payload);
  return payload;
}

export async function loadWorkflowSnapshot(workspaceDir) {
  const p = workflowStatePathFor(workspaceDir);
  if (!(await fileExists(p))) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (err) {
    console.error(`[coder] corrupt workflow state ${p}: ${err.message}`);
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
          BLOCKED: { target: "blocked", actions: "stampCompletedAt" },
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
          BLOCKED: { target: "blocked", actions: "stampCompletedAt" },
        },
      },
      cancelling: {
        on: {
          SYNC: { actions: "syncState" },
          COMPLETE: { target: "completed", actions: "stampCompletedAt" },
          FAIL: { target: "failed", actions: "markFailed" },
          CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },
          BLOCKED: { target: "blocked", actions: "stampCompletedAt" },
        },
      },
      completed: { type: "final" },
      failed: { type: "final" },
      cancelled: { type: "final" },
      blocked: { type: "final" },
    },
  });
}

// --- Loop state (for develop workflow's multi-issue loop) ---

/** Terminal run statuses — used for start-path cleanup, schema, and lifecycle. Keep synchronized. */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "blocked",
];

const LoopIssueResultSchema = z
  .object({
    source: z.enum(["github", "linear", "gitlab", "local"]),
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
    lastFailedRunId: z.string().nullable().default(null),
    deferredReason: z.string().nullable().optional(),
    rcaIssueUrl: z.string().nullable().optional(),
  })
  .passthrough();

const LoopStateSchema = z.object({
  runId: z.string().nullable().default(null),
  goal: z.string().default(""),
  status: z
    .enum([
      "idle",
      "running",
      "paused",
      "completed",
      "failed",
      "cancelled",
      "blocked",
    ])
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

export async function loadLoopState(workspaceDir) {
  const p = loopStatePathFor(workspaceDir);
  try {
    const raw = JSON.parse(await readFile(p, "utf8"));
    return LoopStateSchema.parse(raw);
  } catch {
    return LoopStateSchema.parse({});
  }
}

/**
 * @returns {Promise<boolean>} true if loop-state.json was written; false if guardRunId skipped the write (stale run)
 */
export async function saveLoopState(
  workspaceDir,
  loopState,
  { guardRunId = "" } = {},
) {
  const p = loopStatePathFor(workspaceDir);
  let writeErr;
  let guarded = false;
  const chain = getWriteChain(workspaceDir)
    .then(async () => {
      if (guardRunId) {
        try {
          const existing = JSON.parse(await readFile(p, "utf8"));
          if (existing.runId && existing.runId !== guardRunId) {
            guarded = true;
            return;
          }
        } catch {}
      }
      await writeJson(p, loopState);
    })
    .catch((e) => {
      writeErr = e;
    });
  setWriteChain(workspaceDir, chain);
  await chain;
  if (guarded) return false;
  if (writeErr) throw writeErr;
  return true;
}

// --- CLI control signals (file-based cancel/pause/resume) ---

export function controlSignalPath(workspaceDir) {
  return path.join(workspaceDir, ".coder", "control.json");
}

export async function writeControlSignal(workspaceDir, signal) {
  const p = controlSignalPath(workspaceDir);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ ...signal, ts: nowIso() }), "utf8");
}

/**
 * Poll for a file-based control signal and apply it to the cancelToken.
 * Returns the action name if a signal was consumed, otherwise null.
 */
export async function pollControlSignal(workspaceDir, cancelToken, runId) {
  const p = controlSignalPath(workspaceDir);
  if (!(await fileExists(p))) return null;
  try {
    const signal = JSON.parse(await readFile(p, "utf8"));
    if (signal.runId && signal.runId !== runId) return null;
    if (signal.action === "cancel") {
      cancelToken.cancelled = true;
      try {
        await unlink(p);
      } catch {}
      return "cancel";
    }
    if (signal.action === "pause") {
      cancelToken.paused = true;
      try {
        await unlink(p);
      } catch {}
      return "pause";
    }
    if (signal.action === "resume") {
      cancelToken.paused = false;
      try {
        await unlink(p);
      } catch {}
      return "resume";
    }
    return null;
  } catch {
    return null;
  }
}

// --- Per-issue state ---

const SelectedIssueSchema = z.object({
  source: z.enum(["github", "linear", "gitlab", "local"]),
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
    planningSessionId: z.string().nullable().default(null),
    implementationSessionId: z.string().nullable().default(null),
    programmerFixSessionId: z.string().nullable().default(null),
    planReviewSessionId: z.string().nullable().default(null),
    reviewerSessionId: z.string().nullable().default(null),
    sessionsDisabled: z.boolean().default(false),
    plannerAgentName: z.string().nullable().default(null),
    implementationAgentName: z.string().nullable().default(null),
    planReviewAgentName: z.string().nullable().default(null),
    programmerFixAgentName: z.string().nullable().default(null),
    reviewerAgentName: z.string().nullable().default(null),
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
  planningSessionId: null,
  implementationSessionId: null,
  programmerFixSessionId: null,
  planReviewSessionId: null,
  reviewerSessionId: null,
  sessionsDisabled: false,
  plannerAgentName: null,
  implementationAgentName: null,
  planReviewAgentName: null,
  programmerFixAgentName: null,
  reviewerAgentName: null,
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

export async function loadState(workspaceDir) {
  const p = statePathFor(workspaceDir);
  try {
    const raw = JSON.parse(await readFile(p, "utf8"));
    return IssueStateSchema.parse(raw);
  } catch {
    return { ...DEFAULT_ISSUE_STATE };
  }
}

/**
 * Load issue state from an arbitrary file path (e.g. backup state.json).
 * Returns null on parse/schema failure.
 *
 * @param {string} filePath - Absolute path to state JSON file
 * @returns {Promise<z.infer<typeof IssueStateSchema> | null>}
 */
export async function loadStateFromPath(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return IssueStateSchema.parse(raw);
  } catch {
    return null;
  }
}

export async function saveState(workspaceDir, state) {
  const p = statePathFor(workspaceDir);
  let writeErr;
  const chain = getWriteChain(workspaceDir)
    .then(() => writeJson(p, state))
    .catch((e) => {
      writeErr = e;
    });
  setWriteChain(workspaceDir, chain);
  await chain;
  if (writeErr) throw writeErr;
}

const SESSION_KEYS = [
  "planningSessionId",
  "planReviewSessionId",
  "implementationSessionId",
  "programmerFixSessionId",
  "reviewerSessionId",
];

/**
 * Clear all session IDs and set sessionsDisabled for the current issue.
 * Call on session auth/collision to poison-proof state for same-issue resume.
 * @param {object} state - Mutable issue state
 */
export function clearAllSessionIdsAndDisable(state) {
  state.sessionsDisabled = true;
  for (const key of SESSION_KEYS) {
    state[key] = null;
  }
}
