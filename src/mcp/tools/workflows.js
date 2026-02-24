import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createActor } from "xstate";
import { z } from "zod";
import { AgentPool } from "../../agents/pool.js";
import { AgentRolesInputSchema, resolveConfig } from "../../config.js";
import { buildSecrets, DEFAULT_PASS_ENV } from "../../helpers.js";
import { ensureLogsDir, makeJsonlLogger } from "../../logging.js";
import { loadSteeringContext } from "../../steering.js";
import {
  createWorkflowLifecycleMachine,
  loadLoopState,
  loadWorkflowSnapshot,
  saveLoopState,
  saveWorkflowSnapshot,
  saveWorkflowTerminalState,
} from "../../state/workflow-state.js";
import { runDesignPipeline } from "../../workflows/design.workflow.js";
import { runDevelopLoop } from "../../workflows/develop.workflow.js";
import { runResearchPipeline } from "../../workflows/research.workflow.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

const HEARTBEAT_STALE_MS = 30_000;

/** @type {Map<string, { actor: ReturnType<typeof createActor>, workspace: string, sqlitePath: string }>} */
const workflowActors = new Map();
/** @type {Map<string, { cancelToken: { cancelled: boolean, paused: boolean }, agentPool?: import("../../agents/pool.js").AgentPool, workspace: string, promise: Promise, startedAt: string }>} */
export const activeRuns = new Map();

function workflowSqlitePath(workspaceDir) {
  const config = resolveConfig(workspaceDir);
  return path.resolve(workspaceDir, config.workflow.scratchpad.sqlitePath);
}

function startWorkflowActor({
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
    });
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "EPERM") return true;
    return false;
  }
}

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
  const isStale = shouldCheckStale && (heartbeatStale || pidStale);
  const staleReason = isStale
    ? pidStale
      ? "runner_process_not_alive"
      : "heartbeat_stale"
    : null;
  return {
    heartbeatAgeMs,
    runnerPid: runnerPid ?? null,
    runnerAlive,
    isStale,
    staleReason,
  };
}

function markRunTerminalOnDisk(workspaceDir, runId, workflow, status) {
  const diskState = loadLoopState(workspaceDir);
  if (diskState.runId !== runId) return false;
  if (!["running", "paused", "cancelling"].includes(diskState.status))
    return false;
  diskState.status = status;
  diskState.currentStage = null;
  diskState.currentStageStartedAt = null;
  diskState.activeAgent = null;
  diskState.runnerPid = null;
  diskState.lastHeartbeatAt = new Date().toISOString();
  diskState.completedAt = new Date().toISOString();
  saveLoopState(workspaceDir, diskState);

  const actorEntry = workflowActors.get(runId);
  if (actorEntry?.workspace === workspaceDir) {
    const at = diskState.completedAt;
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
    actorEntry.actor.stop();
    workflowActors.delete(runId);
  } else {
    let workflowState = status;
    if (status === "running" || status === "paused") workflowState = "failed";
    saveWorkflowTerminalState(workspaceDir, {
      runId,
      workflow,
      state: workflowState,
      context: {
        workflow,
        runId,
        workspace: workspaceDir,
        currentStage: null,
        activeAgent: null,
        completedAt: diskState.completedAt,
      },
      sqlitePath: workflowSqlitePath(workspaceDir),
    });
  }
  return true;
}

function readWorkflowStatus(workspaceDir) {
  const loopState = loadLoopState(workspaceDir);
  const { heartbeatAgeMs, runnerPid, runnerAlive, isStale, staleReason } =
    detectStaleness(loopState);

  const counts = {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    inProgress: 0,
  };
  for (const entry of loopState.issueQueue) {
    counts.total++;
    if (entry.status === "completed") counts.completed++;
    else if (entry.status === "failed") counts.failed++;
    else if (entry.status === "skipped") counts.skipped++;
    else if (entry.status === "in_progress") counts.inProgress++;
    else counts.pending++;
  }

  const issueQueue = loopState.issueQueue.map((e) => ({
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
  if (!existsSync(logPath)) return { events: [], nextSeq: 0, totalLines: 0 };

  const content = readFileSync(logPath, "utf8");
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

function readWorkflowMachineStatus(workspaceDir, runId, workflow) {
  if (runId) {
    const actorEntry = workflowActors.get(runId);
    if (actorEntry?.workspace === workspaceDir) {
      const snapshot = actorEntry.actor.getPersistedSnapshot();
      const saved = saveWorkflowSnapshot(workspaceDir, {
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

  const disk = loadWorkflowSnapshot(workspaceDir);
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

export function registerWorkflowTools(server, defaultWorkspace) {
  server.registerTool(
    "coder_workflow",
    {
      description:
        "Unified workflow control plane. Use this to start, inspect, and control " +
        "named workflows (workflow=develop|research|design).",
      inputSchema: {
        action: z
          .enum(["start", "status", "events", "cancel", "pause", "resume"])
          .describe("Workflow control action"),
        workflow: z
          .enum(["develop", "research", "design"])
          .default("develop")
          .describe("Workflow type"),
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
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
        localIssuesDir: z
          .string()
          .default("")
          .describe(
            "Develop start-only: path to local issues directory with manifest.json",
          ),
        destructiveReset: z
          .boolean()
          .default(false)
          .describe("Start-only: aggressively reset between issues"),
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
        const ws = resolveWorkspaceForMcp(params.workspace, defaultWorkspace);
        const { action, workflow } = params;

        if (action === "status") {
          const status = readWorkflowStatus(ws);
          const workflowMachine = readWorkflowMachineStatus(
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
          const currentStatus = readWorkflowStatus(ws);
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
          // Cancel any active in-memory runs for this workspace
          for (const [id, run] of activeRuns) {
            if (run.workspace !== ws) continue;
            const diskState = loadLoopState(ws);
            if (
              ["completed", "failed", "cancelled"].includes(diskState.status)
            ) {
              activeRuns.delete(id);
              workflowActors.delete(id);
              continue;
            }
            // Force-cancel the old run: set flag, kill agents, await exit
            run.cancelToken.cancelled = true;
            run.agentPool?.killAll().catch(() => {});
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
            markRunTerminalOnDisk(ws, id, workflow, "cancelled");
            activeRuns.delete(id);
            workflowActors.delete(id);
          }

          // Also check disk state — guards against restarts where activeRuns was cleared
          {
            const diskLoopState = loadLoopState(ws);
            if (
              diskLoopState.status === "running" ||
              diskLoopState.status === "paused"
            ) {
              // Mark stale or orphaned disk runs as failed so the new run can start
              markRunTerminalOnDisk(
                ws,
                diskLoopState.runId,
                workflow,
                "failed",
              );
            }
          }

          const nextRunId = randomUUID().slice(0, 8);
          const initialAgent = params.agentRoles?.issueSelector || "gemini";

          // Save initial loop state
          saveLoopState(ws, {
            version: 1,
            runId: nextRunId,
            goal: params.goal,
            status: "running",
            projectFilter: params.projectFilter || null,
            maxIssues: params.maxIssues || null,
            issueQueue: [],
            currentIndex: 0,
            currentStage: `${workflow}_starting`,
            currentStageStartedAt: new Date().toISOString(),
            activeAgent: initialAgent,
            lastHeartbeatAt: new Date().toISOString(),
            runnerPid: process.pid,
            startedAt: new Date().toISOString(),
            completedAt: null,
          });

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
          mkdirSync(path.join(ws, ".coder"), { recursive: true });
          mkdirSync(artifactsDir, { recursive: true });
          mkdirSync(scratchpadDir, { recursive: true });
          ensureLogsDir(ws);

          const log = makeJsonlLogger(ws, workflow, { runId: nextRunId });
          const secrets = buildSecrets(DEFAULT_PASS_ENV);
          const steeringContext = loadSteeringContext(ws);
          const agentPool = new AgentPool({
            config,
            workspaceDir: ws,
            verbose: config.verbose,
            steeringContext,
          });

          // Store run entry with agentPool so cancel can kill agents
          activeRuns.set(nextRunId, {
            cancelToken,
            agentPool,
            workspace: ws,
            promise: Promise.resolve(),
            startedAt: new Date().toISOString(),
          });

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
          const runPromise = (async () => {
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
                    localIssuesDir:
                      params.localIssuesDir || config.workflow.localIssuesDir,
                    ppcommitPreset: params.ppcommitPreset,
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
              } else {
                result = {
                  status: "failed",
                  error: `Unknown workflow: '${workflow}'.`,
                };
              }

              const finalStatus =
                result.status === "completed" ? "completed" : "failed";
              const at = new Date().toISOString();
              const actorEntry = workflowActors.get(nextRunId);
              if (actorEntry) {
                if (finalStatus === "completed")
                  actorEntry.actor.send({ type: "COMPLETE", at });
                else
                  actorEntry.actor.send({
                    type: "FAIL",
                    at,
                    error: result.error || "unknown",
                  });
                actorEntry.actor.stop();
                workflowActors.delete(nextRunId);
              }
              activeRuns.delete(nextRunId);
              await agentPool.killAll();
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
              markRunTerminalOnDisk(ws, nextRunId, workflow, "failed");
              activeRuns.delete(nextRunId);
              await agentPool.killAll();
            }
          })();

          activeRuns.get(nextRunId).promise = runPromise;

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
            run.agentPool?.killAll().catch(() => {});
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
          const cancelledOnDisk = markRunTerminalOnDisk(
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
