import { z } from "zod";
import { CoderOrchestrator } from "../../orchestrator.js";

const SelectedIssueShape = {
  source: z.enum(["github", "linear"]),
  id: z.string().min(1),
  title: z.string().min(1),
};

const AgentActivityShape = z.record(
  z.object({
    lastActivityTs: z.number().optional(),
    idleMs: z.number().nullable().optional(),
    status: z.string().optional(),
  }).passthrough(),
).nullable();

const McpHealthShape = z.record(
  z.object({
    ready: z.string().optional(),
    failed: z.string().optional(),
    parsedAt: z.string().optional(),
  }).passthrough(),
).nullable();

const StatusResultShape = {
  version: z.number().int(),
  selected: z.object(SelectedIssueShape).nullable(),
  selectedProject: z.object({
    id: z.string(),
    name: z.string(),
    key: z.string(),
  }).nullable(),
  repoPath: z.string().nullable(),
  baseBranch: z.string().nullable(),
  branch: z.string().nullable(),
  steps: z.record(z.boolean()),
  lastError: z.string().nullable(),
  prUrl: z.string().nullable(),
  prBranch: z.string().nullable(),
  prBase: z.string().nullable(),
  artifacts: z.object({
    issueExists: z.boolean(),
    planExists: z.boolean(),
    critiqueExists: z.boolean(),
  }),
  agentActivity: AgentActivityShape,
  currentStage: z.string().nullable(),
  currentStageStartedAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  activeAgent: z.string().nullable(),
  mcpHealth: McpHealthShape,
};
const StatusResultSchema = z.object(StatusResultShape);

export function registerStatusTools(server, defaultWorkspace) {
  server.registerTool(
    "coder_status",
    {
      description:
        "Returns the current workflow state: which steps are complete, selected issue, " +
        "branch, and repo path. Call this to check progress or resume a partially-completed workflow.",
      inputSchema: {
        workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      },
      outputSchema: StatusResultShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace }) => {
      const ws = workspace || defaultWorkspace;
      const orch = new CoderOrchestrator(ws);
      try {
        const status = orch.getStatus();
        const normalizedStatus = StatusResultSchema.parse(status);
        return {
          structuredContent: normalizedStatus,
          content: [{ type: "text", text: JSON.stringify(normalizedStatus, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to get status: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
