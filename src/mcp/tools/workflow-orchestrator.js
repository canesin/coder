import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createActor } from "xstate";
import { z } from "zod";
import { AgentRolesInputSchema, resolveConfig } from "../../config.js";
import { makeJsonlLogger } from "../../logging.js";
import { CoderOrchestrator } from "../../orchestrator.js";
import { loadLoopState, saveLoopState } from "../../state.js";
import {
  createDevelopWorkflowMachine,
  loadWorkflowSnapshot,
  saveWorkflowSnapshot,
  saveWorkflowTerminalState,
} from "../../workflow-machine.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

const AgentRolesInput = AgentRolesInputSchema;
const HEARTBEAT_STALE_MS = 30_000;
/** @type {Map<string, { actor: ReturnType<typeof createActor>, workspace: string, sqlitePath: string }>} */
const workflowActors = new Map();
/** @type {Map<string, { orchestrator: CoderOrchestrator, workspace: string, promise: Promise, startedAt: string }>} */
export const developRuns = new Map();
/** @type {Map<string, { orchestrator: CoderOrchestrator, workspace: string, promise: Promise, startedAt: string }>} */
export const researchRuns = new Map();

function researchStatePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "research-state.json");
}

function loadResearchState(workspaceDir) {
  const p = researchStatePathFor(workspaceDir);
  if (!existsSync(p)) {
    return {
      version: 1,
      workflow: "research",
      runId: null,
      status: "idle",
      goal: "",
      currentStage: null,
      activeAgent: null,
      lastHeartbeatAt: null,
      runnerPid: null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {
      version: 1,
      workflow: "research",
      runId: null,
      status: "idle",
      goal: "",
      currentStage: null,
      activeAgent: null,
      lastHeartbeatAt: null,
      runnerPid: null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
  }
}

function saveResearchState(workspaceDir, state) {
  const p = researchStatePathFor(workspaceDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

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
  currentStage = "listing_issues",
}) {
  const sqlitePath = workflowSqlitePath(workspaceDir);
  const actor = createActor(createDevelopWorkflowMachine());
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
  const shouldCheckStale = status === "running" || status === "paused";
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

function markRunTerminalOnDisk(workspaceDir, runId, status) {
  const diskState = loadLoopState(workspaceDir);
  if (diskState.runId !== runId) return false;
  if (!["running", "paused"].includes(diskState.status)) return false;
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
    if (status === "cancelled") {
      actorEntry.actor.send({ type: "CANCELLED", at: diskState.completedAt });
    } else if (status === "failed") {
      actorEntry.actor.send({
        type: "FAIL",
        at: diskState.completedAt,
        error: "marked_terminal_on_disk",
      });
    } else if (status === "completed") {
      actorEntry.actor.send({ type: "COMPLETE", at: diskState.completedAt });
    }
    actorEntry.actor.stop();
    workflowActors.delete(runId);
  } else {
    let workflowState = status;
    if (status === "running" || status === "paused") workflowState = "failed";
    saveWorkflowTerminalState(workspaceDir, {
      runId,
      workflow: "develop",
      state: workflowState,
      context: {
        workflow: "develop",
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

function readDevelopWorkflowStatus(workspaceDir) {
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
      events.push({ seq: i + 1, ...parsed });
    } catch {
      events.push({ seq: i + 1, raw: allLines[i] });
    }
  }
  return { events, nextSeq: end, totalLines };
}

function markResearchRunTerminalOnDisk(workspaceDir, runId, status) {
  const researchState = loadResearchState(workspaceDir);
  if (researchState.runId !== runId) return false;
  if (!["running", "paused"].includes(researchState.status)) return false;
  const completedAt = new Date().toISOString();
  const next = {
    ...researchState,
    status,
    currentStage: null,
    activeAgent: null,
    lastHeartbeatAt: completedAt,
    completedAt,
    runnerPid: null,
    error:
      status === "failed"
        ? researchState.error || "marked_terminal_on_disk"
        : researchState.error,
  };
  saveResearchState(workspaceDir, next);

  const actorEntry = workflowActors.get(runId);
  if (actorEntry?.workspace === workspaceDir) {
    if (status === "cancelled") {
      actorEntry.actor.send({ type: "CANCELLED", at: completedAt });
    } else if (status === "failed") {
      actorEntry.actor.send({
        type: "FAIL",
        at: completedAt,
        error: "marked_terminal_on_disk",
      });
    } else if (status === "completed") {
      actorEntry.actor.send({ type: "COMPLETE", at: completedAt });
    }
    actorEntry.actor.stop();
    workflowActors.delete(runId);
  } else {
    saveWorkflowTerminalState(workspaceDir, {
      runId,
      workflow: "research",
      state: status,
      context: {
        workflow: "research",
        runId,
        workspace: workspaceDir,
        currentStage: null,
        activeAgent: null,
        completedAt,
      },
      sqlitePath: workflowSqlitePath(workspaceDir),
    });
  }
  return true;
}

function readResearchWorkflowStatus(workspaceDir) {
  const state = loadResearchState(workspaceDir);
  const { heartbeatAgeMs, runnerPid, runnerAlive, isStale, staleReason } =
    detectStaleness(state);

  return {
    runId: state.runId || null,
    runStatus: isStale ? "stale" : state.status,
    rawRunStatus: state.status,
    isStale,
    staleReason,
    goal: state.goal || "",
    counts:
      state.result && Array.isArray(state.result.issues)
        ? {
            total: state.result.issues.length,
            completed:
              state.status === "completed" ? state.result.issues.length : 0,
            failed: state.status === "failed" ? 1 : 0,
            skipped: 0,
            pending: state.status === "running" ? 1 : 0,
            inProgress: state.status === "running" ? 1 : 0,
          }
        : {
            total: 0,
            completed: 0,
            failed: state.status === "failed" ? 1 : 0,
            skipped: 0,
            pending: state.status === "running" ? 1 : 0,
            inProgress: state.status === "running" ? 1 : 0,
          },
    currentStage: state.currentStage || null,
    activeAgent: state.activeAgent || null,
    lastHeartbeatAt: state.lastHeartbeatAt || null,
    heartbeatAgeMs,
    runnerPid,
    runnerAlive,
    result: state.result || null,
    error: state.error || null,
  };
}

function readWorkflowMachineStatus(
  workspaceDir,
  runId,
  workflow,
  loopState = null,
) {
  if (runId) {
    const actorEntry = workflowActors.get(runId);
    if (actorEntry?.workspace === workspaceDir) {
      if (loopState) actorEntry.actor.send({ type: "SYNC", loopState });
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

export function registerWorkflowOrchestratorTools(server, defaultWorkspace) {
  server.registerTool(
    "coder_workflow",
    {
      description:
        "Unified workflow control plane. Use this to start, inspect, and control " +
        "named workflows (workflow=develop|research).",
      inputSchema: {
        action: z
          .enum(["start", "status", "events", "cancel", "pause", "resume"])
          .describe("Workflow control action"),
        workflow: z
          .enum(["develop", "research"])
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
        destructiveReset: z
          .boolean()
          .default(false)
          .describe("Start-only: aggressively reset between issues"),
        strictMcpStartup: z
          .boolean()
          .default(false)
          .describe("Start-only: fail on MCP startup failures"),
        agentRoles: AgentRolesInput.optional().describe(
          "Start-only: per-step agent selection overrides",
        ),
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
    async ({
      action,
      workflow,
      workspace,
      runId,
      goal,
      projectFilter,
      maxIssues,
      allowNoTests,
      testCmd,
      testConfigPath,
      destructiveReset,
      strictMcpStartup,
      agentRoles,
      repoPath,
      pointers,
      clarifications,
      iterations,
      webResearch,
      validateIdeas,
      validationMode,
      afterSeq,
      limit,
    }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);

        const currentActiveRun = () => {
          for (const [id, run] of developRuns) {
            if (run.workspace !== ws) continue;
            const diskState = loadLoopState(ws);
            if (
              ["completed", "failed", "cancelled"].includes(diskState.status)
            ) {
              developRuns.delete(id);
              workflowActors.delete(id);
              continue;
            }
            return { runId: id, workflow: "develop" };
          }
          for (const [id, run] of researchRuns) {
            if (run.workspace !== ws) continue;
            const researchState = loadResearchState(ws);
            if (
              ["completed", "failed", "cancelled"].includes(
                researchState.status,
              )
            ) {
              researchRuns.delete(id);
              workflowActors.delete(id);
              continue;
            }
            return { runId: id, workflow: "research" };
          }
          return null;
        };

        if (action === "start") {
          const active = currentActiveRun();
          if (active) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: `Workspace already has active run: ${active.runId} (${active.workflow})`,
                  }),
                },
              ],
              isError: true,
            };
          }

          if (workflow === "develop") {
            const initialAgent = agentRoles?.issueSelector || "gemini";
            const nextRunId = randomUUID().slice(0, 8);
            saveLoopState(ws, {
              version: 1,
              runId: nextRunId,
              goal,
              status: "running",
              projectFilter: projectFilter || null,
              maxIssues: maxIssues || null,
              issueQueue: [],
              currentIndex: 0,
              currentStage: "listing_issues",
              currentStageStartedAt: new Date().toISOString(),
              activeAgent: initialAgent,
              lastHeartbeatAt: new Date().toISOString(),
              runnerPid: process.pid,
              startedAt: new Date().toISOString(),
              completedAt: null,
            });
            const actor = startWorkflowActor({
              workflow: "develop",
              workspaceDir: ws,
              runId: nextRunId,
              goal,
              initialAgent,
              currentStage: "listing_issues",
            });

            const orch = new CoderOrchestrator(ws, {
              allowNoTests,
              testCmd,
              testConfigPath,
              strictMcpStartup,
              agentRoles,
            });

            const promise = (async () => {
              try {
                const result = await orch.runAuto({
                  goal,
                  projectFilter: projectFilter || undefined,
                  maxIssues: maxIssues || undefined,
                  testCmd,
                  testConfigPath,
                  allowNoTests,
                  destructiveReset,
                  runId: nextRunId,
                });
                const at = new Date().toISOString();
                if (result?.status === "cancelled") {
                  actor.send({ type: "CANCELLED", at });
                } else if (result?.status === "completed") {
                  actor.send({ type: "COMPLETE", at });
                } else if (result?.status === "failed") {
                  actor.send({
                    type: "FAIL",
                    at,
                    error: "run_develop_failed_status",
                  });
                }
                return result;
              } catch (err) {
                actor.send({
                  type: "FAIL",
                  at: new Date().toISOString(),
                  error: err.message,
                });
                markRunTerminalOnDisk(ws, nextRunId, "failed");
                process.stderr.write(
                  `[coder_workflow] Run ${nextRunId} failed: ${err.message}\n`,
                );
                return {
                  status: "failed",
                  completed: 0,
                  failed: 0,
                  skipped: 0,
                  results: [],
                };
              } finally {
                const entry = workflowActors.get(nextRunId);
                if (entry) {
                  entry.actor.stop();
                  workflowActors.delete(nextRunId);
                }
                developRuns.delete(nextRunId);
              }
            })();

            developRuns.set(nextRunId, {
              orchestrator: orch,
              workspace: ws,
              promise,
              startedAt: new Date().toISOString(),
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow: "develop",
                    runId: nextRunId,
                    status: "started",
                  }),
                },
              ],
            };
          }

          const trimmedPointers = String(pointers || "").trim();
          if (!trimmedPointers) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error:
                      'pointers is required when workflow="research" and action="start"',
                  }),
                },
              ],
              isError: true,
            };
          }

          const initialAgent = agentRoles?.issueSelector || "gemini";
          const nextRunId = randomUUID().slice(0, 8);
          let researchState = {
            version: 1,
            workflow: "research",
            runId: nextRunId,
            status: "running",
            goal: goal || "research issue backlog from pointers",
            currentStage: "generate_issues_from_pointers",
            activeAgent: initialAgent,
            lastHeartbeatAt: new Date().toISOString(),
            runnerPid: process.pid,
            startedAt: new Date().toISOString(),
            completedAt: null,
            result: null,
            error: null,
          };
          saveResearchState(ws, researchState);
          const actor = startWorkflowActor({
            workflow: "research",
            workspaceDir: ws,
            runId: nextRunId,
            goal: researchState.goal,
            initialAgent,
            currentStage: researchState.currentStage,
          });
          actor.send({
            type: "STAGE",
            stage: researchState.currentStage,
            activeAgent: initialAgent,
          });

          const orch = new CoderOrchestrator(ws, {
            allowNoTests,
            testCmd,
            testConfigPath,
            strictMcpStartup,
            agentRoles,
          });
          const log = makeJsonlLogger(ws, "research");
          log({
            event: "research_start",
            runId: nextRunId,
            repoPath,
            iterations,
            maxIssues: maxIssues || 6,
            webResearch,
            validateIdeas,
            validationMode,
          });

          const heartbeat = setInterval(() => {
            if (!researchRuns.has(nextRunId)) return;
            const at = new Date().toISOString();
            actor.send({ type: "HEARTBEAT", at });
            researchState = {
              ...researchState,
              lastHeartbeatAt: at,
            };
            saveResearchState(ws, researchState);
          }, 2000);

          const promise = (async () => {
            try {
              const result = await orch.generateIssuesFromPointers({
                repoPath,
                pointers: trimmedPointers,
                clarifications,
                maxIssues: maxIssues || 6,
                iterations,
                webResearch,
                validateIdeas,
                validationMode,
              });
              const completedAt = new Date().toISOString();
              actor.send({ type: "COMPLETE", at: completedAt });
              researchState = {
                ...researchState,
                status: "completed",
                currentStage: null,
                activeAgent: null,
                lastHeartbeatAt: completedAt,
                completedAt,
                runnerPid: null,
                result,
              };
              saveResearchState(ws, researchState);
              log({
                event: "research_completed",
                runId: nextRunId,
                issues: Array.isArray(result?.issues)
                  ? result.issues.length
                  : 0,
                manifestPath: result?.manifestPath || null,
                pipelinePath: result?.pipelinePath || null,
              });
              return result;
            } catch (err) {
              const completedAt = new Date().toISOString();
              const cancelled = /run cancelled/i.test(
                String(err?.message || ""),
              );
              if (cancelled) actor.send({ type: "CANCELLED", at: completedAt });
              else {
                actor.send({
                  type: "FAIL",
                  at: completedAt,
                  error: err.message,
                });
              }
              researchState = {
                ...researchState,
                status: cancelled ? "cancelled" : "failed",
                currentStage: null,
                activeAgent: null,
                lastHeartbeatAt: completedAt,
                completedAt,
                runnerPid: null,
                error: cancelled ? null : err.message,
              };
              saveResearchState(ws, researchState);
              log({
                event: cancelled ? "research_cancelled" : "research_failed",
                runId: nextRunId,
                error: cancelled ? null : err.message,
              });
              process.stderr.write(
                `[coder_workflow] Research run ${nextRunId} failed: ${err.message}\n`,
              );
              return {
                runId: nextRunId,
                status: cancelled ? "cancelled" : "failed",
                error: cancelled ? null : err.message,
              };
            } finally {
              clearInterval(heartbeat);
              const entry = workflowActors.get(nextRunId);
              if (entry) {
                entry.actor.stop();
                workflowActors.delete(nextRunId);
              }
              researchRuns.delete(nextRunId);
            }
          })();

          researchRuns.set(nextRunId, {
            orchestrator: orch,
            workspace: ws,
            promise,
            startedAt: new Date().toISOString(),
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow: "research",
                  runId: nextRunId,
                  status: "started",
                }),
              },
            ],
          };
        }

        if (action === "status") {
          if (workflow === "develop") {
            const status = readDevelopWorkflowStatus(ws);
            const loopState = loadLoopState(ws);
            const workflowMachine = readWorkflowMachineStatus(
              ws,
              status.runId,
              "develop",
              loopState,
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { action, workflow: "develop", ...status, workflowMachine },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          const status = readResearchWorkflowStatus(ws);
          const workflowMachine = readWorkflowMachineStatus(
            ws,
            status.runId,
            "research",
            null,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { action, workflow: "research", ...status, workflowMachine },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === "events") {
          const logName = workflow === "develop" ? "develop" : "research";
          const result = readWorkflowEvents(ws, logName, afterSeq, limit);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    action,
                    workflow,
                    log: `${logName}.jsonl`,
                    ...result,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (!runId) {
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

        if (workflow === "develop") {
          if (action === "cancel") {
            const run = developRuns.get(runId);
            if (run) {
              const actorEntry = workflowActors.get(runId);
              if (actorEntry?.workspace === ws) {
                actorEntry.actor.send({
                  type: "CANCEL",
                  at: new Date().toISOString(),
                });
              }
              run.orchestrator.requestCancel();
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      action,
                      workflow: "develop",
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
              "cancelled",
            );
            if (cancelledOnDisk) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      action,
                      workflow: "develop",
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

          const run = developRuns.get(runId);
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

          if (action === "pause") run.orchestrator.requestPause();
          if (action === "resume") run.orchestrator.requestResume();
          const actorEntry = workflowActors.get(runId);
          if (actorEntry?.workspace === ws) {
            if (action === "pause") {
              actorEntry.actor.send({
                type: "PAUSE",
                at: new Date().toISOString(),
              });
            }
            if (action === "resume") {
              actorEntry.actor.send({
                type: "RESUME",
                at: new Date().toISOString(),
              });
            }
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow: "develop",
                  runId,
                  status: action === "pause" ? "pause_requested" : "resumed",
                }),
              },
            ],
          };
        }

        if (action === "cancel") {
          const run = researchRuns.get(runId);
          if (run) {
            run.orchestrator.requestCancel();
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
                    workflow: "research",
                    runId,
                    status: "cancel_requested",
                  }),
                },
              ],
            };
          }
          const cancelledOnDisk = markResearchRunTerminalOnDisk(
            ws,
            runId,
            "cancelled",
          );
          if (cancelledOnDisk) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    action,
                    workflow: "research",
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

        const run = researchRuns.get(runId);
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
        const researchState = loadResearchState(ws);
        if (action === "pause") {
          run.orchestrator.requestPause();
          const actorEntry = workflowActors.get(runId);
          if (actorEntry?.workspace === ws) {
            actorEntry.actor.send({
              type: "PAUSE",
              at: new Date().toISOString(),
            });
          }
          saveResearchState(ws, {
            ...researchState,
            status: "paused",
            lastHeartbeatAt: new Date().toISOString(),
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action,
                  workflow: "research",
                  runId,
                  status: "pause_requested",
                }),
              },
            ],
          };
        }
        run.orchestrator.requestResume();
        const actorEntry = workflowActors.get(runId);
        if (actorEntry?.workspace === ws) {
          actorEntry.actor.send({
            type: "RESUME",
            at: new Date().toISOString(),
          });
        }
        saveResearchState(ws, {
          ...researchState,
          status: "running",
          lastHeartbeatAt: new Date().toISOString(),
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action,
                workflow: "research",
                runId,
                status: "resumed",
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.message }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
