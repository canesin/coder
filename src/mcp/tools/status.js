import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveConfig } from "../../config.js";
import { loadState } from "../../state/workflow-state.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

async function readActivityFile(workspaceDir) {
  const p = path.join(workspaceDir, ".coder", "activity.json");
  if (
    !(await access(p).then(
      () => true,
      () => false,
    ))
  )
    return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function readMcpHealth(workspaceDir) {
  const p = path.join(workspaceDir, ".coder", "mcp-health.json");
  if (
    !(await access(p).then(
      () => true,
      () => false,
    ))
  )
    return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function readResearchState(workspaceDir) {
  const statePath = path.join(workspaceDir, ".coder", "research-state.json");
  if (
    !(await access(statePath).then(
      () => true,
      () => false,
    ))
  )
    return null;
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
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
    if (
      await access(pipelinePath).then(
        () => true,
        () => false,
      )
    ) {
      try {
        pipeline = JSON.parse(await readFile(pipelinePath, "utf8"));
      } catch {
        // ignore corrupt pipeline
      }
    }
    return { runId, pipeline };
  } catch {
    return null;
  }
}

async function getStatus(workspaceDir) {
  const config = resolveConfig(workspaceDir);
  const state = await loadState(workspaceDir);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  const scratchpadDir = path.join(workspaceDir, ".coder", "scratchpad");

  const scratchpadPath = state.scratchpadPath
    ? path.resolve(workspaceDir, state.scratchpadPath)
    : null;

  const [issueExists, planExists, critiqueExists] = await Promise.all([
    access(path.join(artifactsDir, "ISSUE.md")).then(
      () => true,
      () => false,
    ),
    access(path.join(artifactsDir, "PLAN.md")).then(
      () => true,
      () => false,
    ),
    access(path.join(artifactsDir, "PLANREVIEW.md")).then(
      () => true,
      () => false,
    ),
  ]);
  const currentExists = scratchpadPath
    ? await access(scratchpadPath).then(
        () => true,
        () => false,
      )
    : false;

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
      issueExists,
      planExists,
      critiqueExists,
    },
    scratchpad: {
      dir: scratchpadDir,
      current: state.scratchpadPath || null,
      currentExists,
      sqlite: {
        enabled: config.workflow.scratchpad.sqliteSync,
        path: config.workflow.scratchpad.sqlitePath,
      },
    },
    agentActivity: await readActivityFile(workspaceDir),
    currentStage: null,
    currentStageStartedAt: null,
    lastHeartbeatAt: null,
    activeAgent: null,
    mcpHealth: await readMcpHealth(workspaceDir),
    researchWorkflow: await readResearchState(workspaceDir),
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
