import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveConfig } from "../../config.js";
import { loadState } from "../../state/workflow-state.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

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

function getStatus(workspaceDir) {
  const config = resolveConfig(workspaceDir);
  const state = loadState(workspaceDir);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  const scratchpadDir = path.join(workspaceDir, ".coder", "scratchpad");

  const scratchpadPath = state.scratchpadPath
    ? path.resolve(workspaceDir, state.scratchpadPath)
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
    artifacts: {
      issueExists: existsSync(path.join(artifactsDir, "ISSUE.md")),
      planExists: existsSync(path.join(artifactsDir, "PLAN.md")),
      critiqueExists: existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
      reviewFindingsExists: existsSync(
        path.join(artifactsDir, "REVIEW_FINDINGS.md"),
      ),
    },
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
    currentStage: null,
    currentStageStartedAt: null,
    lastHeartbeatAt: null,
    activeAgent: null,
    mcpHealth: readMcpHealth(workspaceDir),
    researchWorkflow: readResearchState(workspaceDir),
  };
}

export function registerStatusTools(server, defaultWorkspace) {
  server.registerTool(
    "coder_status",
    {
      description:
        "Returns the current workflow state: which steps are complete, selected issue, " +
        "branch, and repo path. Call this to check progress or resume a partially-completed workflow.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
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
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const status = getStatus(ws);
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
