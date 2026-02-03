import { z } from "zod";
import { CoderOrchestrator } from "../../orchestrator.js";

export function registerStatusTools(server, defaultWorkspace) {
  server.tool(
    "coder_status",
    "Returns the current workflow state: which steps are complete, selected issue, " +
      "branch, and repo path. Call this to check progress or resume a partially-completed workflow.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
    },
    async ({ workspace }) => {
      const ws = workspace || defaultWorkspace;
      const orch = new CoderOrchestrator(ws);
      try {
        const status = orch.getStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
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
