import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveConfig } from "../../config.js";
import {
  loadLoopState,
  loadState,
  loadWorkflowSnapshot,
} from "../../state/workflow-state.js";

function readActivityFile(workspaceDir) {
  const p = path.join(workspaceDir, ".coder", "activity.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readMcpHealth(workspaceDir) {
  const p = path.join(workspaceDir, ".coder", "mcp-health.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function inferWorkflowFromSnapshotStage(currentStage) {
  const s = String(currentStage ?? "");
  if (s.startsWith("research.")) return "research";
  if (s.startsWith("design.")) return "design";
  return "develop";
}

async function readWorkflowRunState(workspaceDir) {
  const loopState = await loadLoopState(workspaceDir);
  const snapshot = await loadWorkflowSnapshot(workspaceDir);

  if (
    (loopState.status === "running" || loopState.status === "paused") &&
    (loopState.currentStage ||
      loopState.activeAgent ||
      loopState.lastHeartbeatAt)
  ) {
    return {
      runId: loopState.runId || null,
      runStatus: loopState.status || null,
      currentStage: loopState.currentStage || null,
      currentStageStartedAt: loopState.currentStageStartedAt || null,
      lastHeartbeatAt: loopState.lastHeartbeatAt || null,
      activeAgent: loopState.activeAgent || null,
      /** Develop multi-issue loop only writes loop-state.json while running. */
      activeWorkflow: "develop",
    };
  }

  if (snapshot?.context) {
    const ctx = snapshot.context;
    return {
      runId: snapshot.runId || null,
      runStatus: snapshot.value ?? null,
      currentStage: ctx.currentStage ?? null,
      currentStageStartedAt: null,
      lastHeartbeatAt: ctx.lastHeartbeatAt ?? null,
      activeAgent: ctx.activeAgent ?? null,
      activeWorkflow:
        snapshot.workflow ?? inferWorkflowFromSnapshotStage(ctx.currentStage),
    };
  }

  return null;
}

function readResearchState(workspaceDir) {
  const statePath = path.join(workspaceDir, ".coder", "research-state.json");
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const runId = state.runId;
    if (!runId) return { runId: null, pipeline: null };
    const pipelinePath = path.join(
      workspaceDir,
      ".coder",
      "scratchpad",
      runId,
      "pipeline.json",
    );
    let pipeline = null;
    if (existsSync(pipelinePath)) {
      try {
        pipeline = JSON.parse(readFileSync(pipelinePath, "utf8"));
      } catch {
        // ignore corrupt pipeline
      }
    }
    return { runId, pipeline };
  } catch {
    return null;
  }
}

/**
 * Coarse develop pipeline position from machine `steps` + artifact files.
 * `currentStage` / loop state can lag; use this when they disagree with `artifacts`.
 *
 * @param {{ steps?: object }} state
 * @param {{ issueExists: boolean, planExists: boolean, critiqueExists: boolean }} artifacts
 * @returns {"issue_draft" | "planning" | "plan_review" | "past_plan_review" | null}
 */
export function deriveDevelopArtifactPhase(state, artifacts) {
  const s = state?.steps || {};
  const touched =
    artifacts.issueExists ||
    s.wroteIssue ||
    artifacts.planExists ||
    s.wrotePlan ||
    artifacts.critiqueExists ||
    s.wroteCritique;
  if (!touched) return null;
  const issue = artifacts.issueExists || s.wroteIssue;
  const plan = artifacts.planExists || s.wrotePlan;
  const critique = artifacts.critiqueExists || s.wroteCritique;
  if (!issue) return "issue_draft";
  if (!plan) return "planning";
  if (!critique) return "plan_review";
  return "past_plan_review";
}

export async function getStatus(workspaceDir) {
  const config = resolveConfig(workspaceDir);
  const state = await loadState(workspaceDir);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  const scratchpadDir = path.join(workspaceDir, ".coder", "scratchpad");

  const scratchpadPath = state.scratchpadPath
    ? path.resolve(workspaceDir, state.scratchpadPath)
    : null;

  const runState = await readWorkflowRunState(workspaceDir);

  const artifacts = {
    issueExists: existsSync(path.join(artifactsDir, "ISSUE.md")),
    planExists: existsSync(path.join(artifactsDir, "PLAN.md")),
    critiqueExists: existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
    reviewFindingsExists: existsSync(
      path.join(artifactsDir, "REVIEW_FINDINGS.md"),
    ),
  };

  const rs = runState?.runStatus;
  const derivedArtifactPhase =
    (rs === "running" || rs === "paused") &&
    runState?.activeWorkflow === "develop"
      ? deriveDevelopArtifactPhase(state, artifacts)
      : null;

  return {
    selected: state.selected || null,
    selectedProject: state.selectedProject || null,
    repoPath: state.repoPath || null,
    baseBranch: state.baseBranch || null,
    branch: state.branch || null,
    agentRoles: config.workflow.agentRoles,
    steps: state.steps || {},
    lastError: state.lastError || null,
    prUrl: state.prUrl || null,
    prBranch: state.prBranch || null,
    prBase: state.prBase || null,
    wip: {
      enabled: config.workflow.wip.push,
      remote: config.workflow.wip.remote,
      autoCommit: config.workflow.wip.autoCommit,
      includeUntracked: config.workflow.wip.includeUntracked,
      lastPushedAt: state.lastWipPushAt || null,
    },
    artifacts,
    scratchpad: {
      dir: scratchpadDir,
      current: state.scratchpadPath || null,
      currentExists: scratchpadPath ? existsSync(scratchpadPath) : false,
      sqlite: {
        enabled: config.workflow.scratchpad.sqliteSync,
        path: config.workflow.scratchpad.sqlitePath,
      },
    },
    agentActivity: readActivityFile(workspaceDir),
    currentStage: runState?.currentStage ?? null,
    currentStageStartedAt: runState?.currentStageStartedAt ?? null,
    lastHeartbeatAt: runState?.lastHeartbeatAt ?? null,
    activeAgent: runState?.activeAgent ?? null,
    runId: runState?.runId ?? null,
    runStatus: runState?.runStatus ?? null,
    derivedArtifactPhase,
    mcpHealth: readMcpHealth(workspaceDir),
    researchWorkflow: readResearchState(workspaceDir),
  };
}

export function registerStatusTools(server, resolveWorkspace) {
  server.registerTool(
    "coder_status",
    {
      description:
        "Returns the current workflow state: which steps are complete, selected issue, " +
        "branch, and repo path. When `runStatus` is running/paused and the active run is develop, " +
        "`derivedArtifactPhase` summarizes develop progress from artifacts + steps " +
        "(use when `currentStage` lags). Omitted for research/design runs. " +
        "Prefer `steps` and `artifacts` for what exists on disk; `currentStage` is coarse runner position.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe(
            "Workspace directory — ALWAYS pass your project root path. Required in HTTP mode.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace }) => {
      try {
        const ws = resolveWorkspace(workspace);
        const status = await getStatus(ws);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to get status: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
