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
  loadLoopState,
  loadWorkflowSnapshot,
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

/** @type {Map<string, { actor: ReturnType<typeof createActor>, workspace: string, sqlitePath: string }>} */
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
  actor.subscribe(() => {
    saveWorkflowSnapshot(workspaceDir, {
      runId,
      workflow,
      snapshot: actor.getPersistedSnapshot(),
      sqlitePath,
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
  workflowActors.set(runId, { actor, workspace: workspaceDir, sqlitePath });
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
 * Uses saveLoopState guardRunId so a newer run cannot be overwritten.
 * @returns {Promise<object|null>} the persisted state object, or null if skipped
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
 * Normal MCP launcher path after develop/research/design resolves without throw.
 * Persists loop-state, sends lifecycle actor terminal event, cleans up.
 */
export async function applyLauncherNormalCompletion({
  workspaceDir,
  runId,
  result,
  agentPool,
}) {
  const finalStatus =
    result.status === "completed"
      ? "completed"
      : result.status === "blocked"
        ? "blocked"
        : "failed";
  const at = new Date().toISOString();
  await persistTerminalLoopState(workspaceDir, runId, finalStatus);
  const actorEntry = workflowActors.get(runId);
  if (actorEntry) {
    if (finalStatus === "completed")
      actorEntry.actor.send({ type: "COMPLETE", at });
    else if (finalStatus === "blocked")
      actorEntry.actor.send({ type: "BLOCKED", at });
    else
      actorEntry.actor.send({
        type: "FAIL",
        at,
        error: result.error || "unknown",
      });
    actorEntry.actor.stop();
    workflowActors.delete(runId);
  }
  activeRuns.delete(runId);
  await agentPool.killAll();
}

async function markRunTerminalOnDisk(workspaceDir, runId, workflow, status) {
  const persisted = await persistTerminalLoopState(workspaceDir, runId, status);
  if (!persisted) return false;

  const actorEntry = workflowActors.get(runId);
  if (actorEntry?.workspace === workspaceDir) {
    const at = persisted.completedAt;
    if (status === "cancelled")
      actorEntry.actor.send({ type: "CANCELLED", at });
    else if (status === "failed")
      actorEntry.actor.send({
        type: "FAIL",
        at,
        error: "marked_terminal_on_disk",
      });
    else if (status === "completed")
      actorEntry.actor.send({ type: "COMPLETE", at });
    else if (status === "blocked")
      actorEntry.actor.send({ type: "BLOCKED", at });
    actorEntry.actor.stop();
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
  { filterRunId = "" } = {},
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
    return { events: [], nextSeq: 0, totalLines: 0 };
  }
  const allLines = content.split("\n").filter((l) => l.trim());
  const totalLines = allLines.length;
  const events = [];
  const start = afterSeq;
  const end = Math.min(start + limit, totalLines);
  for (let i = start; i < end; i++) {
    try {
      const parsed = JSON.parse(allLines[i]);
      if (filterRunId && parsed.runId && parsed.runId !== filterRunId) continue;
      events.push({ seq: i + 1, ...parsed });
    } catch {
      events.push({ seq: i + 1, raw: allLines[i] });
    }
  }
  return { events, nextSeq: end, totalLines };
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

export function registerWorkflowTools(server, resolveWorkspace) {
  server.registerTool(
    "coder_workflow",
    {
      description:
        "Unified workflow control plane. Use this to start, inspect, and control " +
        "named workflows (workflow=develop|research|design|spec-build).",
      inputSchema: {
        action: z
          .enum(["start", "status", "events", "cancel", "pause", "resume"])
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
        updateDoc: z
          .string()
          .default("")
          .describe(
            "Spec-build start-only: path to update document (use with existingSpecDir for update mode)",
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
          .describe("Events-only: max events to return"),
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
            { filterRunId: currentStatus.runId || "" },
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { action, workflow, log: `${workflow}.jsonl`, ...result },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "start") {
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
              const initialAgent = params.agentRoles?.issueSelector || "gemini";

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
            config,
            agentPool,
            log,
            cancelToken,
            secrets,
            artifactsDir,
            scratchpadDir,
            steeringContext,
          };

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
                    updateDoc: params.updateDoc,
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
