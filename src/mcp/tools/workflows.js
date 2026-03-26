import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createActor } from "xstate";
import { z } from "zod";
import { AgentPool } from "../../agents/pool.js";
import { AgentRolesInputSchema, resolveConfig } from "../../config.js";
import { buildSecrets, isPidAlive, resolvePassEnv } from "../../helpers.js";
import { ensureLogsDir, makeJsonlLogger } from "../../logging.js";
import { withStartLock } from "../../state/start-lock.js";
import {
  createWorkflowLifecycleMachine,
  drainWriteChain,
  loadLoopState,
  loadWorkflowSnapshot,
  mutateLoopState,
  saveLoopState,
  saveWorkflowSnapshot,
  saveWorkflowTerminalState,
  TERMINAL_RUN_STATUSES,
  writeControlSignal,
} from "../../state/workflow-state.js";
import { loadSteeringContext } from "../../steering.js";
import { runDesignPipeline } from "../../workflows/design.workflow.js";
import { runDevelopLoop } from "../../workflows/develop.workflow.js";
import { runResearchPipeline } from "../../workflows/research.workflow.js";
import { runSpecBuildPipeline } from "../../workflows/spec-build.workflow.js";

const HEARTBEAT_STALE_MS = 900_000;

/** @type {Map<string, { actor: ReturnType<typeof createActor>, workspace: string, sqlitePath: string, workflow: string }>} */
const workflowActors = new Map();
/** @type {Map<string, { cancelToken: { cancelled: boolean, paused: boolean }, agentPool?: import("../../agents/pool.js").AgentPool, workspace: string, promise: Promise, startedAt: string }>} */
export const activeRuns = new Map();

function workflowSqlitePath(workspaceDir) {
  const config = resolveConfig(workspaceDir);
  return path.resolve(workspaceDir, config.workflow.scratchpad.sqlitePath);
}

export function startWorkflowActor({
  workflow = "develop",
  workspaceDir,
  runId,
  goal,
  initialAgent,
  currentStage = null,
}) {
  const sqlitePath = workflowSqlitePath(workspaceDir);
  const actor = createActor(createWorkflowLifecycleMachine());

  // Seed the state file with our runId (unguarded) so subsequent guarded
  // writes can match.  Queued into the write-chain before subscribe fires.
  saveWorkflowSnapshot(workspaceDir, {
    runId,
    workflow,
    snapshot: { value: currentStage || "idle", context: {} },
    sqlitePath,
  }).catch(() => {});

  actor.subscribe(() => {
    saveWorkflowSnapshot(workspaceDir, {
      runId,
      workflow,
      snapshot: actor.getPersistedSnapshot(),
      sqlitePath,
      guardRunId: runId,
    }).catch(() => {});
  });
  actor.start();
  actor.send({
    type: "START",
    runId,
    workspace: workspaceDir,
    workflow,
    goal,
    activeAgent: initialAgent,
    currentStage,
    at: new Date().toISOString(),
  });
  workflowActors.set(runId, {
    actor,
    workspace: workspaceDir,
    sqlitePath,
    workflow,
  });
  return actor;
}

function workflowStateName(snapshot) {
  if (!snapshot) return null;
  if (typeof snapshot.value === "string") return snapshot.value;
  try {
    return JSON.stringify(snapshot.value);
  } catch {
    return String(snapshot.value);
  }
}

const HEARTBEAT_TRULY_STUCK_MS = 1_800_000; // 30 minutes

function detectStaleness({ status, lastHeartbeatAt, runnerPid }) {
  const heartbeatTs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatTs)
    ? Math.max(0, Date.now() - heartbeatTs)
    : null;
  const runnerAlive = isPidAlive(runnerPid ?? null);
  const heartbeatStale =
    heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_MS;
  const shouldCheckStale =
    status === "running" || status === "paused" || status === "cancelling";
  const pidStale = shouldCheckStale && runnerAlive === false;

  // Trust PID over heartbeat: if the runner process is alive but heartbeat is
  // stale, don't mark as stale unless heartbeat exceeds the truly-stuck threshold
  const heartbeatTrulyStuck =
    heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_TRULY_STUCK_MS;
  const isStale =
    shouldCheckStale &&
    (pidStale || (heartbeatStale && (!runnerAlive || heartbeatTrulyStuck)));

  let staleReason = null;
  if (isStale) {
    if (pidStale) staleReason = "runner_process_not_alive";
    else if (heartbeatTrulyStuck) staleReason = "heartbeat_truly_stuck";
    else staleReason = "heartbeat_stale";
  } else if (shouldCheckStale && heartbeatStale && runnerAlive) {
    staleReason = "heartbeat_stale_runner_alive";
  }

  return {
    heartbeatAgeMs,
    runnerPid: runnerPid ?? null,
    runnerAlive,
    isStale,
    staleReason,
  };
}

/**
 * Persist terminal workflow status to loop-state.json (runner finished).
 * Does not notify the lifecycle actor — use when the launcher already sent COMPLETE/FAIL/BLOCKED.
 * Swallows errors so a disk failure cannot reclassify an already-successful workflow as failed.
 * Uses saveLoopState guardRunId so a newer run cannot be overwritten if this run lost a load/save race.
 * @returns {Promise<object|null>} the persisted state object, or null if skipped (guard), no-op, or error
 */
export async function persistTerminalLoopState(workspaceDir, runId, status) {
  try {
    const diskState = await loadLoopState(workspaceDir);
    if (diskState.runId !== runId) return null;
    if (!["running", "paused", "cancelling"].includes(diskState.status))
      return null;
    diskState.status = status;
    diskState.currentStage = null;
    diskState.currentStageStartedAt = null;
    diskState.activeAgent = null;
    diskState.runnerPid = null;
    diskState.lastHeartbeatAt = new Date().toISOString();
    diskState.completedAt = new Date().toISOString();
    const written = await saveLoopState(workspaceDir, diskState, {
      guardRunId: runId,
    });
    return written === true ? diskState : null;
  } catch (err) {
    process.stderr.write(
      `[coder] persistTerminalLoopState failed runId=${runId}: ${err?.message || err}\n`,
    );
    return null;
  }
}

/**
 * Align the in-memory lifecycle actor with loop-state.json after terminal persistence.
 * Only for develop: loop-state.json is the develop-loop snapshot; other workflows must
 * not be cleared from unrelated disk state (see applyLauncherNormalCompletion).
 *
 * @param {import("xstate").Actor} actor
 * @param {object} diskState - from loadLoopState after persistTerminalLoopState
 * @param {string} at - fallback ISO time for lastHeartbeatAt
 */
function syncDevelopLifecycleActorFromLoopState(actor, diskState, at) {
  actor.send({
    type: "SYNC",
    state: {
      currentStage: diskState.currentStage ?? null,
      activeAgent: diskState.activeAgent ?? null,
      lastHeartbeatAt: diskState.lastHeartbeatAt ?? at,
    },
  });
}

/**
 * Normal MCP launcher path after develop / research / design resolves without throw.
 * Persists loop-state (before activeRuns release), lifecycle actor terminal event, cleanup.
 * When no in-memory workflow actor exists, persists workflow-state.json via
 * `saveWorkflowTerminalState` (same idea as `markRunTerminalOnDisk` fallback).
 * Exported for integration tests; invoked from the background `runPromise` handler.
 *
 * @param {object} opts
 * @param {string} opts.workspaceDir
 * @param {string} opts.runId
 * @param {{ status: string, error?: string }} opts.result
 * @param {{ killAll: () => Promise<unknown> }} opts.agentPool
 * @param {string} [opts.workflow] - lifecycle / sqlite key (default `"develop"`)
 */
export async function applyLauncherNormalCompletion({
  workspaceDir,
  runId,
  result,
  agentPool,
  workflow = "develop",
}) {
  const finalStatus =
    result.status === "completed"
      ? "completed"
      : result.status === "blocked"
        ? "blocked"
        : result.status === "cancelled"
          ? "cancelled"
          : "failed";
  const at = new Date().toISOString();
  await persistTerminalLoopState(workspaceDir, runId, finalStatus);
  const diskState = await loadLoopState(workspaceDir);
  const actorEntry = workflowActors.get(runId);
  if (actorEntry) {
    // loop-state.json is the develop loop snapshot only. Syncing it into the lifecycle
    // actor is correct for develop; for research/design it would clear stage/agent from
    // unrelated or stale develop-loop disk state.
    if (workflow === "develop") {
      syncDevelopLifecycleActorFromLoopState(actorEntry.actor, diskState, at);
    }
    if (finalStatus === "completed")
      actorEntry.actor.send({ type: "COMPLETE", at });
    else if (finalStatus === "blocked")
      actorEntry.actor.send({ type: "BLOCKED", at });
    else if (finalStatus === "cancelled")
      actorEntry.actor.send({ type: "CANCELLED", at });
    else
      actorEntry.actor.send({
        type: "FAIL",
        at,
        error: result.error || "unknown",
      });
    actorEntry.actor.stop();
    await drainWriteChain(workspaceDir);
    workflowActors.delete(runId);
  } else {
    let workflowState = finalStatus;
    if (workflowState === "running" || workflowState === "paused")
      workflowState = "failed";
    const context = {
      workflow,
      runId,
      workspace: workspaceDir,
      currentStage: null,
      activeAgent: null,
      completedAt: diskState.completedAt ?? at,
    };
    if (finalStatus === "failed") context.error = result.error || "unknown";
    await saveWorkflowTerminalState(workspaceDir, {
      runId,
      workflow,
      state: workflowState,
      context,
      sqlitePath: workflowSqlitePath(workspaceDir),
      guardRunId: runId,
    });
  }
  activeRuns.delete(runId);
  await agentPool.killAll();
}

/**
 * Cancel in-memory runs for a workspace so a new start is not blocked after disk reconcile.
 * Prefer calling {@link markRunTerminalOnDisk} first (persist → SYNC → FAIL) when possible.
 * Any lifecycle actor still registered for this workspace afterward is terminalized here
 * (retry mark, or last-resort FAIL if disk persist cannot run).
 *
 * @param {string} [failError] - FAIL event message when a fallback path runs
 */
async function releaseActiveRunsForWorkspace(
  workspaceDir,
  failError = "reconciled_stale_run",
) {
  for (const [id, run] of [...activeRuns.entries()]) {
    if (run.workspace !== workspaceDir) continue;
    run.cancelToken.cancelled = true;
    try {
      await run.agentPool?.killAll();
    } catch {
      /* best-effort */
    }
    activeRuns.delete(id);
  }
  for (const [id, ae] of [...workflowActors.entries()]) {
    if (ae.workspace !== workspaceDir) continue;
    const wfName = ae.workflow ?? "develop";
    const ok = await markRunTerminalOnDisk(workspaceDir, id, wfName, "failed", {
      failError,
    });
    if (!ok) {
      const at = new Date().toISOString();
      ae.actor.send({ type: "FAIL", at, error: failError });
      ae.actor.stop();
      await drainWriteChain(workspaceDir);
      workflowActors.delete(id);
    }
  }
}

/**
 * @param {{ failError?: string }} [options] - For status === "failed", error text on the FAIL event (develop actor path only).
 */
async function markRunTerminalOnDisk(
  workspaceDir,
  runId,
  workflow,
  status,
  options = {},
) {
  const { failError = "marked_terminal_on_disk" } = options;
  const persisted = await persistTerminalLoopState(workspaceDir, runId, status);
  if (!persisted) return false;

  const actorEntry = workflowActors.get(runId);
  if (actorEntry?.workspace === workspaceDir) {
    const at = persisted.completedAt;
    if (workflow === "develop") {
      const diskState = await loadLoopState(workspaceDir);
      syncDevelopLifecycleActorFromLoopState(actorEntry.actor, diskState, at);
    }
    if (status === "cancelled")
      actorEntry.actor.send({ type: "CANCELLED", at });
    else if (status === "failed")
      actorEntry.actor.send({
        type: "FAIL",
        at,
        error: failError,
      });
    else if (status === "completed")
      actorEntry.actor.send({ type: "COMPLETE", at });
    else if (status === "blocked")
      actorEntry.actor.send({ type: "BLOCKED", at });
    actorEntry.actor.stop();
    await drainWriteChain(workspaceDir);
    workflowActors.delete(runId);
  } else {
    let workflowState = status;
    if (status === "running" || status === "paused") workflowState = "failed";
    await saveWorkflowTerminalState(workspaceDir, {
      runId,
      workflow,
      state: workflowState,
      context: {
        workflow,
        runId,
        workspace: workspaceDir,
        currentStage: null,
        activeAgent: null,
        completedAt: persisted.completedAt,
      },
      sqlitePath: workflowSqlitePath(workspaceDir),
      guardRunId: runId,
    });
  }
  return true;
}

/**
 * Transition orphaned stale runs to "failed" so they don't stay "running"
 * forever after a service restart. Mutates loopState in place when a
 * transition occurs.
 */
async function reapStaleRun(workspaceDir, loopState, isStale) {
  if (
    !isStale ||
    !loopState.runId ||
    loopState.status === "paused" ||
    activeRuns.has(loopState.runId)
  )
    return;
  const snapshot = await loadWorkflowSnapshot(workspaceDir);
  const wfName = snapshot?.workflow || "develop";
  await markRunTerminalOnDisk(workspaceDir, loopState.runId, wfName, "failed");
  const updated = await loadLoopState(workspaceDir);
  Object.assign(loopState, updated);
}

export async function readWorkflowStatus(workspaceDir) {
  const loopState = await loadLoopState(workspaceDir);
  let { heartbeatAgeMs, runnerPid, runnerAlive, isStale, staleReason } =
    detectStaleness(loopState);

  // Capture pre-merge stage before auto-transition (which clears currentStage).
  const originalStage = loopState.currentStage;

  await reapStaleRun(workspaceDir, loopState, isStale);
  // Re-read staleness after potential reap (loopState mutated in place)
  ({ heartbeatAgeMs, runnerPid, runnerAlive, isStale, staleReason } =
    detectStaleness(loopState));

  // Status contract: when currentStage is develop_starting, we are pre-merge.
  // Suppress stale failed/skipped entries so status shows a fresh retryable view.
  // Scoped to develop only; other workflows may have different semantics.
  // Use originalStage so auto-transition doesn't break the pre-merge filter.
  const isPreMerge = originalStage === "develop_starting";
  const queueForStatus = isPreMerge
    ? loopState.issueQueue.filter(
        (e) => e.status !== "failed" && e.status !== "skipped",
      )
    : loopState.issueQueue;

  const counts = {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    inProgress: 0,
  };
  for (const entry of queueForStatus) {
    counts.total++;
    if (entry.status === "completed") counts.completed++;
    else if (entry.status === "failed") counts.failed++;
    else if (entry.status === "skipped") counts.skipped++;
    else if (entry.status === "in_progress") counts.inProgress++;
    else counts.pending++;
  }

  const issueQueue = queueForStatus.map((e) => ({
    source: e.source,
    id: e.id,
    title: e.title,
    status: e.status,
    prUrl: e.prUrl || null,
    error: e.error || null,
  }));

  let agentActivity = null;
  const activityPath = path.join(workspaceDir, ".coder", "activity.json");
  if (existsSync(activityPath)) {
    try {
      agentActivity = JSON.parse(readFileSync(activityPath, "utf8"));
    } catch {
      /* best-effort */
    }
  }

  let mcpHealth = null;
  const healthPath = path.join(workspaceDir, ".coder", "mcp-health.json");
  if (existsSync(healthPath)) {
    try {
      mcpHealth = JSON.parse(readFileSync(healthPath, "utf8"));
    } catch {
      /* best-effort */
    }
  }

  return {
    runId: loopState.runId || null,
    runStatus: isStale ? "stale" : loopState.status,
    rawRunStatus: loopState.status,
    isStale,
    staleReason,
    goal: loopState.goal,
    counts,
    currentStage: loopState.currentStage || null,
    activeAgent: loopState.activeAgent || null,
    lastHeartbeatAt: loopState.lastHeartbeatAt || null,
    heartbeatAgeMs,
    runnerPid,
    runnerAlive,
    issueQueue,
    agentActivity,
    mcpHealth,
  };
}

function readWorkflowEvents(
  workspaceDir,
  workflowName,
  afterSeq = 0,
  limit = 50,
  { filterRunId = "", allRuns = false } = {},
) {
  const logPath = path.join(
    workspaceDir,
    ".coder",
    "logs",
    `${workflowName}.jsonl`,
  );
  let content;
  try {
    content = readFileSync(logPath, "utf8");
  } catch {
    return {
      events: [],
      nextSeq: 0,
      totalLines: 0,
      filteredByRunId: null,
    };
  }
  const allLines = content.split("\n").filter((l) => l.trim());
  const totalLines = allLines.length;
  const events = [];
  const effectiveFilter = allRuns ? "" : filterRunId;
  const start = afterSeq;
  const end = Math.min(start + limit, totalLines);
  for (let i = start; i < end; i++) {
    try {
      const parsed = JSON.parse(allLines[i]);
      if (effectiveFilter && parsed.runId && parsed.runId !== effectiveFilter)
        continue;
      events.push({ seq: i + 1, ...parsed });
    } catch {
      events.push({ seq: i + 1, raw: allLines[i] });
    }
  }
  return {
    events,
    nextSeq: end,
    totalLines,
    filteredByRunId: effectiveFilter || null,
  };
}

async function readWorkflowMachineStatus(workspaceDir, runId, workflow) {
  if (runId) {
    const actorEntry = workflowActors.get(runId);
    if (actorEntry?.workspace === workspaceDir) {
      const snapshot = actorEntry.actor.getPersistedSnapshot();
      const saved = await saveWorkflowSnapshot(workspaceDir, {
        runId,
        workflow,
        snapshot,
        sqlitePath: actorEntry.sqlitePath,
      });
      return {
        source: "memory",
        state: workflowStateName(snapshot),
        value: snapshot.value,
        context: snapshot.context,
        updatedAt: saved?.updatedAt || null,
      };
    }
  }

  const disk = await loadWorkflowSnapshot(workspaceDir);
  if (!disk) {
    return {
      source: "none",
      state: null,
      value: null,
      context: null,
      updatedAt: null,
    };
  }
  if (runId && disk.runId && disk.runId !== runId) {
    return {
      source: "none",
      state: null,
      value: null,
      context: null,
      updatedAt: null,
    };
  }
  if (workflow && disk.workflow && disk.workflow !== workflow) {
    return {
      source: "none",
      state: null,
      value: null,
      context: null,
      updatedAt: null,
    };
  }
  return {
    source: "disk",
    state:
      typeof disk.value === "string"
        ? disk.value
        : (() => {
            try {
              return JSON.stringify(disk.value);
            } catch {
              return String(disk.value);
            }
          })(),
    value: disk.value ?? null,
    context: disk.context ?? null,
    updatedAt: disk.updatedAt || null,
  };
}

let _reaperInterval = null;

/**
 * Reap orphaned runs from a previous server process on startup.
 * In HTTP mode resolveWorkspace() requires an explicit workspace param,
 * so this is a no-op there — orphaned HTTP runs are reaped lazily on
 * the next status/start request for that workspace.
 */
async function reapOrphanedRunsOnStartup(resolveWorkspace) {
  let ws;
  try {
    ws = resolveWorkspace();
  } catch {
    // HTTP mode (WORKSPACE_REQUIRED) or no default workspace — skip.
    return;
  }
  try {
    const loopState = await loadLoopState(ws);
    if (!loopState.runId) return;
    const { isStale } = detectStaleness(loopState);
    if (isStale) {
      await reapStaleRun(ws, loopState, isStale);
    }
  } catch {
    /* best effort — workspace may not have loop-state yet */
  }
}

export function registerWorkflowTools(server, resolveWorkspace) {
  // Background watchdog: periodically check active runs for staleness.
  // reapStaleRun() skips runs in the activeRuns map (they're "managed"),
  // so the watchdog must evict stale entries first to allow reaping.
  if (!_reaperInterval) {
    _reaperInterval = setInterval(async () => {
      for (const [runId, entry] of activeRuns) {
        try {
          const loopState = await loadLoopState(entry.workspace);
          const { isStale } = detectStaleness(loopState);
          if (isStale) {
            // Force-cancel the stale in-memory entry so reapStaleRun proceeds.
            entry.cancelToken.cancelled = true;
            if (entry.agentPool) {
              await entry.agentPool.killAll().catch(() => {});
            }
            // Evict from activeRuns first so the workspace is unblocked,
            // then give the promise a bounded window to settle. If the
            // runner is stuck in JS after agent kill, we don't block forever.
            activeRuns.delete(runId);
            if (entry.promise) {
              const SETTLE_TIMEOUT_MS = 10_000;
              await Promise.race([
                entry.promise.catch(() => {}),
                new Promise((r) => setTimeout(r, SETTLE_TIMEOUT_MS)),
              ]);
            }
            await reapStaleRun(entry.workspace, loopState, isStale);
          }
        } catch {
          /* best effort */
        }
      }
    }, 60_000);
    _reaperInterval.unref();
  }

  // Reap any orphaned runs left by a previous server process.
  reapOrphanedRunsOnStartup(resolveWorkspace);

  server.registerTool(
    "coder_workflow",
    {
      description:
        "Unified workflow control plane. Use this to start, inspect, and control " +
        "named workflows (workflow=develop|research|design|spec-build). Includes reconcile for stale " +
        "loop-state cleanup when status reports isStale.",
      inputSchema: {
        action: z
          .enum([
            "start",
            "status",
            "events",
            "cancel",
            "pause",
            "resume",
            "reconcile",
          ])
          .describe("Workflow control action"),
        workflow: z
          .enum(["develop", "research", "design", "spec-build"])
          .default("develop")
          .describe("Workflow type"),
        workspace: z
          .string()
          .optional()
          .describe(
            "Workspace directory — ALWAYS pass your project root path. Required in HTTP mode.",
          ),
        runId: z
          .string()
          .optional()
          .describe("Run ID for cancel/pause/resume actions"),
        goal: z
          .string()
          .default("resolve all assigned issues")
          .describe("Start-only: high-level goal"),
        projectFilter: z
          .string()
          .optional()
          .describe("Start-only: optional project/team filter"),
        maxIssues: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Start-only: max issues to process"),
        allowNoTests: z
          .boolean()
          .default(false)
          .describe("Start-only: proceed even if no tests detected"),
        testCmd: z
          .string()
          .default("")
          .describe("Start-only: explicit test command"),
        testConfigPath: z
          .string()
          .default("")
          .describe("Start-only: path to test config JSON"),
        issueSource: z
          .enum(["github", "linear", "gitlab", "local"])
          .optional()
          .describe(
            "Develop start-only: issue source override (github | linear | gitlab | local); defaults to config.workflow.issueSource",
          ),
        localIssuesDir: z
          .string()
          .default("")
          .describe(
            "Develop start-only: path to local issues directory with manifest.json",
          ),
        issueIds: z
          .array(z.string())
          .optional()
          .describe(
            'Develop start-only: force specific issue IDs, skipping AI selection (e.g. ["#84", "#82"] for GitHub)',
          ),
        destructiveReset: z
          .boolean()
          .default(false)
          .describe("Start-only: aggressively reset between issues"),
        forceRestart: z
          .boolean()
          .default(false)
          .describe(
            "Start-only: allow starting when a run is already in progress (cancels it). Without this, start is rejected to prevent accidental restarts.",
          ),
        ppcommitPreset: z
          .enum(["strict", "relaxed", "minimal"])
          .default("strict")
          .describe(
            "Develop start-only: ppcommit strictness preset (strict|relaxed|minimal)",
          ),
        strictMcpStartup: z
          .boolean()
          .default(false)
          .describe("Start-only: fail on MCP startup failures"),
        agentRoles: AgentRolesInputSchema.optional().describe(
          "Start-only: per-step agent selection overrides",
        ),
        // Research-specific
        repoPath: z
          .string()
          .default(".")
          .describe("Research start-only: repo subfolder for pointer analysis"),
        pointers: z
          .string()
          .default("")
          .describe("Research start-only: free-form idea pointers"),
        clarifications: z
          .string()
          .default("")
          .describe("Research start-only: extra constraints"),
        iterations: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(2)
          .describe(
            "Research start-only: draft/review refinement iterations (1-5)",
          ),
        webResearch: z
          .boolean()
          .default(true)
          .describe(
            "Research start-only: mine GitHub/Show HN references for grounding",
          ),
        validateIdeas: z
          .boolean()
          .default(true)
          .describe(
            "Research start-only: validate ideas via bug repro and/or PoC",
          ),
        validationMode: z
          .enum(["auto", "bug_repro", "poc"])
          .default("auto")
          .describe("Research start-only: preferred validation style"),
        // Design-specific
        designIntent: z
          .string()
          .default("")
          .describe("Design start-only: design intent description"),
        // Spec-build-specific
        existingSpecDir: z
          .string()
          .default("")
          .describe(
            "Spec-build start-only: path to existing spec directory to ingest",
          ),
        researchRunId: z
          .string()
          .default("")
          .describe(
            "Spec-build start-only: research run ID whose output to synthesize",
          ),
        // Events pagination
        afterSeq: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Events-only: return events after this sequence"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Events-only: max log lines to scan (seq is line-based)"),
        allRuns: z
          .boolean()
          .default(false)
          .describe(
            "Events-only: include lines from all runIds. When false, lines from other runs are skipped but still count toward the line window — use true for full history or debugging.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        let resolvedWorkspace = params.workspace;
        if (
          !resolvedWorkspace &&
          params.runId &&
          ["cancel", "pause", "resume"].includes(params.action)
        ) {
          const run = activeRuns.get(params.runId);
          if (run?.workspace) resolvedWorkspace = run.workspace;
        }
        const ws = resolveWorkspace(resolvedWorkspace);
        const { action, workflow } = params;

        if (action === "status") {
          const status = await readWorkflowStatus(ws);
          const workflowMachine = await readWorkflowMachineStatus(
            ws,
            status.runId,
            workflow,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { action, workflow, ...status, workflowMachine },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "events") {
          const currentStatus = await readWorkflowStatus(ws);
          const result = readWorkflowEvents(
            ws,
            workflow,
            params.afterSeq,
            params.limit,
            {
              filterRunId: currentStatus.runId || "",
              allRuns: params.allRuns === true,
            },
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    action,
                    workflow,
                    log: `${workflow}.jsonl`,
                    eventsNote:
                      "seq is the 1-based line index in the jsonl file; with run filtering, some pages may contain fewer events than limit.",
                    ...result,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "reconcile") {
          const st = await readWorkflowStatus(ws);
          if (!st.isStale) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow,
                    reconciled: false,
                    reason: "not_stale",
                    runId: st.runId ?? null,
                    staleReason: st.staleReason ?? null,
                    hint: "Status tooling only marks stale runs (dead runner PID or heartbeat truly stuck).",
                  }),
                },
              ],
            };
          }
          const loop = await loadLoopState(ws);
          if (!loop.runId) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow,
                    reconciled: false,
                    reason: "no_loop_run_id",
                  }),
                },
              ],
            };
          }
          const snapshot = await loadWorkflowSnapshot(ws);
          const wfName = snapshot?.workflow ?? workflow ?? "develop";
          const written = await markRunTerminalOnDisk(
            ws,
            loop.runId,
            wfName,
            "failed",
            { failError: "reconciled_stale_run" },
          );
          await releaseActiveRunsForWorkspace(ws, "reconciled_stale_run");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow,
                  reconciled: written,
                  activeRunsReleased: true,
                  reason: written
                    ? "marked_failed_on_disk"
                    : "persist_rejected_or_already_terminal",
                  runId: loop.runId,
                  hint: written
                    ? "In-memory runs for this workspace were cancelled; you can start again without forceRestart."
                    : "Loop state was not updated (guard or already terminal); in-memory runs were still released.",
                }),
              },
            ],
          };
        }

        if (action === "start") {
          // Guard: reject start if a run is already in progress, unless forceRestart
          const hasActiveRun = [...activeRuns.values()].some(
            (r) => r.workspace === ws,
          );
          const diskLoopState = await loadLoopState(ws);
          const diskRunInProgress =
            diskLoopState.status === "running" ||
            diskLoopState.status === "paused";
          if (
            (hasActiveRun || diskRunInProgress) &&
            params.forceRestart !== true
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow,
                    status: "blocked",
                    reason: "run_already_in_progress",
                    runId: diskLoopState.runId || null,
                    hint: "Use action: 'status' to monitor. To replace the running workflow, pass forceRestart: true.",
                  }),
                },
              ],
            };
          }

          let startContext;
          try {
            startContext = await withStartLock(ws, async () => {
              // Phase 1: Clean zombie in-memory entries (already terminal on disk)
              for (const [id, run] of activeRuns) {
                if (run.workspace !== ws) continue;
                const ds = await loadLoopState(ws);
                if (TERMINAL_RUN_STATUSES.includes(ds.status)) {
                  activeRuns.delete(id);
                  workflowActors.delete(id);
                }
              }

              // Phase 2: Assess whether a run is genuinely active
              const hasActiveInMemory = [...activeRuns.values()].some(
                (r) => r.workspace === ws,
              );
              const diskLoopState = await loadLoopState(ws);
              const diskActive =
                diskLoopState.status === "running" ||
                diskLoopState.status === "paused";

              // For disk-only runs (no in-memory representation), use staleness
              // detection to distinguish orphaned runs from genuinely active ones
              // owned by another process.
              let diskIsOrphan = false;
              if (diskActive && !hasActiveInMemory) {
                const staleness = detectStaleness(diskLoopState);
                diskIsOrphan = staleness.isStale;
              }

              const genuinelyActive =
                hasActiveInMemory || (diskActive && !diskIsOrphan);

              // Phase 3: Guard — block if active and not force-restarting
              if (genuinelyActive && params.forceRestart !== true) {
                return {
                  action,
                  workflow,
                  status: "blocked",
                  reason: "run_already_in_progress",
                  runId: diskLoopState.runId || null,
                  hint: "Use action: 'status' to monitor. To replace the running workflow, pass forceRestart: true.",
                };
              }

              // Phase 4: Clean up proven-orphan disk runs
              if (diskActive && diskIsOrphan) {
                await markRunTerminalOnDisk(
                  ws,
                  diskLoopState.runId,
                  workflow,
                  "failed",
                );
              }

              // Phase 5: Force-cancel in-memory runs (only reached when
              // forceRestart is true or no active runs remain)
              for (const [id, run] of activeRuns) {
                if (run.workspace !== ws) continue;
                run.cancelToken.cancelled = true;
                try {
                  await run.agentPool?.killAll();
                } catch {
                  /* ESRCH expected */
                }
                const actorEntry = workflowActors.get(id);
                if (actorEntry?.workspace === ws) {
                  actorEntry.actor.send({
                    type: "CANCEL",
                    at: new Date().toISOString(),
                  });
                }
                await Promise.race([
                  run.promise,
                  new Promise((r) => setTimeout(r, 10_000)),
                ]);
                await markRunTerminalOnDisk(ws, id, workflow, "cancelled");
                activeRuns.delete(id);
                workflowActors.delete(id);
              }

              // Phase 6: Handle forceRestart for disk-only active runs (genuine
              // but force-replaced — signal cancel then mark failed)
              {
                const postCleanup = await loadLoopState(ws);
                if (
                  postCleanup.status === "running" ||
                  postCleanup.status === "paused"
                ) {
                  // Write file-based cancel signal so the other process picks it
                  // up via pollControlSignal() and stops modifying the workspace.
                  await writeControlSignal(ws, {
                    action: "cancel",
                    runId: postCleanup.runId,
                  });
                  // Wait up to 10 s for the other process to actually exit.
                  // pollControlSignal deletes control.json on read, but the
                  // runner may still be mid-step, so also check the PID.
                  const oldPid = postCleanup.runnerPid;
                  for (let i = 0; i < 20; i++) {
                    if (!isPidAlive(oldPid)) break;
                    await new Promise((r) => setTimeout(r, 500));
                  }
                  await markRunTerminalOnDisk(
                    ws,
                    postCleanup.runId,
                    workflow,
                    "failed",
                  );
                }
              }

              const nextRunId = randomUUID().slice(0, 8);
              const configForAgent = resolveConfig(
                ws,
                params.agentRoles
                  ? { workflow: { agentRoles: params.agentRoles } }
                  : {},
              );
              const initialAgent =
                params.agentRoles?.issueSelector ||
                configForAgent.workflow?.agentRoles?.issueSelector ||
                "gemini";

              // Preserve prior issueQueue so runDevelopLoop can merge terminal statuses
              const priorLoopState = await loadLoopState(ws);

              // Save initial loop state
              await saveLoopState(ws, {
                version: 1,
                runId: nextRunId,
                goal: params.goal,
                status: "running",
                projectFilter: params.projectFilter || null,
                maxIssues: params.maxIssues || null,
                issueQueue: priorLoopState.issueQueue || [],
                currentIndex: 0,
                currentStage: `${workflow}_starting`,
                currentStageStartedAt: new Date().toISOString(),
                activeAgent: initialAgent,
                lastHeartbeatAt: new Date().toISOString(),
                runnerPid: process.pid,
                startedAt: new Date().toISOString(),
                completedAt: null,
              });

              return { nextRunId, initialAgent };
            });
          } catch (err) {
            if (err?.code === "WORKFLOW_START_LOCK_BUSY") {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      action,
                      workflow,
                      status: "blocked",
                      reason: "workflow_start_lock_busy",
                    }),
                  },
                ],
              };
            }
            throw err;
          }
          // Guard returned a blocked response instead of start context
          if (startContext?.status === "blocked") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(startContext),
                },
              ],
            };
          }

          const { nextRunId, initialAgent } = startContext;

          startWorkflowActor({
            workflow,
            workspaceDir: ws,
            runId: nextRunId,
            goal: params.goal,
            initialAgent,
            currentStage: `${workflow}_starting`,
          });

          const cancelToken = { cancelled: false, paused: false };

          // Build workflow context — agentRoles must be nested under workflow
          const overrides = {};
          if (params.agentRoles) {
            overrides.workflow = { agentRoles: params.agentRoles };
          }
          const config = resolveConfig(ws, overrides);
          const artifactsDir = path.join(ws, ".coder", "artifacts");
          const scratchpadDir = path.join(ws, ".coder", "scratchpad");
          await mkdir(path.join(ws, ".coder"), { recursive: true });
          await mkdir(artifactsDir, { recursive: true });
          await mkdir(scratchpadDir, { recursive: true });
          ensureLogsDir(ws);

          const log = makeJsonlLogger(ws, workflow, { runId: nextRunId });
          const secrets = buildSecrets(resolvePassEnv(config));
          const steeringContext = loadSteeringContext(ws);
          const agentPool = new AgentPool({
            config,
            workspaceDir: ws,
            verbose: config.verbose,
            steeringContext,
            runId: nextRunId,
          });

          const runStartedAt = new Date().toISOString();

          const workflowCtx = {
            workspaceDir: ws,
            repoPath: params.repoPath || ".",
            runId: nextRunId,
            config,
            agentPool,
            log,
            cancelToken,
            secrets,
            artifactsDir,
            scratchpadDir,
            steeringContext,
            onWorkflowStage: (payload) => {
              const at = new Date().toISOString();
              const actorEntry = workflowActors.get(nextRunId);
              if (actorEntry?.actor) {
                /** @type {{ type: string, stage: string, at: string, activeAgent?: string | null }} */
                const ev = {
                  type: "STAGE",
                  stage: payload.stage,
                  at,
                };
                if ("activeAgent" in payload) {
                  ev.activeAgent = payload.activeAgent;
                }
                actorEntry.actor.send(ev);
              }
              if (workflow === "develop") {
                mutateLoopState(
                  ws,
                  (ls) => {
                    if (ls.runId !== nextRunId) return null;
                    const next = {
                      ...ls,
                      currentStage: payload.stage,
                      lastHeartbeatAt: at,
                    };
                    if ("activeAgent" in payload) {
                      next.activeAgent = payload.activeAgent;
                    }
                    return next;
                  },
                  { guardRunId: nextRunId },
                ).catch((err) => {
                  log({ event: "stage_state_write_error", error: err.message });
                });
              }
            },
          };

          if (workflow === "develop") {
            workflowCtx.syncLifecycleActorFromDisk = async () => {
              const ls = await loadLoopState(ws);
              const entry = workflowActors.get(nextRunId);
              if (!entry || entry.workspace !== ws || ls.runId !== nextRunId)
                return;
              entry.actor.send({
                type: "SYNC",
                state: {
                  currentStage: ls.currentStage ?? null,
                  activeAgent: ls.activeAgent ?? null,
                  lastHeartbeatAt: ls.lastHeartbeatAt ?? null,
                },
              });
            };
          }

          // Fire and forget — run in background
          const runPromise = Promise.resolve().then(async () => {
            try {
              let result;
              if (workflow === "develop") {
                result = await runDevelopLoop(
                  {
                    goal: params.goal,
                    projectFilter: params.projectFilter,
                    maxIssues: params.maxIssues || 10,
                    destructiveReset: params.destructiveReset,
                    testCmd: params.testCmd,
                    testConfigPath: params.testConfigPath,
                    allowNoTests: params.allowNoTests,
                    issueSource:
                      params.issueSource || config.workflow.issueSource,
                    localIssuesDir:
                      params.localIssuesDir || config.workflow.localIssuesDir,
                    ppcommitPreset: params.ppcommitPreset,
                    issueIds: params.issueIds || [],
                  },
                  workflowCtx,
                );
              } else if (workflow === "research") {
                result = await runResearchPipeline(
                  {
                    pointers: params.pointers,
                    repoPath: params.repoPath,
                    clarifications: params.clarifications,
                    maxIssues: params.maxIssues || 6,
                    iterations: params.iterations,
                    webResearch: params.webResearch,
                    validateIdeas: params.validateIdeas,
                    validationMode: params.validationMode,
                  },
                  workflowCtx,
                );
              } else if (workflow === "design") {
                result = await runDesignPipeline(
                  {
                    intent: params.designIntent || params.pointers || "",
                    screenshotPaths: [],
                    projectName: "",
                    style: params.clarifications || "",
                  },
                  workflowCtx,
                );
              } else if (workflow === "spec-build") {
                result = await runSpecBuildPipeline(
                  {
                    repoPath: params.repoPath,
                    existingSpecDir: params.existingSpecDir,
                    researchRunId: params.researchRunId,
                  },
                  workflowCtx,
                );
              } else {
                result = {
                  status: "failed",
                  error: `Unknown workflow: '${workflow}'.`,
                };
              }

              await applyLauncherNormalCompletion({
                workspaceDir: ws,
                runId: nextRunId,
                result,
                agentPool,
                workflow,
              });
            } catch (err) {
              const at = new Date().toISOString();
              const actorEntry = workflowActors.get(nextRunId);
              if (actorEntry) {
                actorEntry.actor.send({
                  type: "FAIL",
                  at,
                  error: err.message,
                });
                actorEntry.actor.stop();
                await drainWriteChain(ws);
                workflowActors.delete(nextRunId);
              }
              await markRunTerminalOnDisk(ws, nextRunId, workflow, "failed");
              activeRuns.delete(nextRunId);
              await agentPool.killAll();
            }
          });

          // Store run entry with real promise so cancel can await it
          activeRuns.set(nextRunId, {
            cancelToken,
            agentPool,
            workspace: ws,
            promise: runPromise,
            startedAt: runStartedAt,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow,
                  runId: nextRunId,
                  status: "started",
                }),
              },
            ],
          };
        }

        // cancel/pause/resume require runId
        if (!params.runId) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `runId is required for action=${action}`,
                }),
              },
            ],
            isError: true,
          };
        }

        const { runId } = params;

        if (action === "cancel") {
          const run = activeRuns.get(runId);
          if (run) {
            run.cancelToken.cancelled = true;
            try {
              await run.agentPool?.killAll();
            } catch {}
            const actorEntry = workflowActors.get(runId);
            if (actorEntry?.workspace === ws) {
              actorEntry.actor.send({
                type: "CANCEL",
                at: new Date().toISOString(),
              });
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow,
                    runId,
                    status: "cancel_requested",
                  }),
                },
              ],
            };
          }
          const cancelledOnDisk = await markRunTerminalOnDisk(
            ws,
            runId,
            workflow,
            "cancelled",
          );
          if (cancelledOnDisk) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow,
                    runId,
                    status: "cancelled_offline",
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `No active run found: ${runId}`,
                }),
              },
            ],
            isError: true,
          };
        }

        const run = activeRuns.get(runId);
        if (!run) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `No active run found: ${runId}`,
                }),
              },
            ],
            isError: true,
          };
        }

        if (action === "pause") {
          run.cancelToken.paused = true;
          const actorEntry = workflowActors.get(runId);
          if (actorEntry?.workspace === ws) {
            actorEntry.actor.send({
              type: "PAUSE",
              at: new Date().toISOString(),
            });
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow,
                  runId,
                  status: "pause_requested",
                }),
              },
            ],
          };
        }

        if (action === "resume") {
          run.cancelToken.paused = false;
          const actorEntry = workflowActors.get(runId);
          if (actorEntry?.workspace === ws) {
            actorEntry.actor.send({
              type: "RESUME",
              at: new Date().toISOString(),
            });
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow,
                  runId,
                  status: "resumed",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Unknown action: ${action}` }),
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: err.message }) },
          ],
          isError: true,
        };
      }
    },
  );
}
