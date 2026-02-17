import { McpAgent } from "../../agents/mcp-agent.js";

/**
 * Resolve a Stitch MCP agent from config.
 * Shared by ui-generation and ui-refinement machines.
 *
 * @param {object} ctx - Workflow context
 * @returns {{ agentName: string, agent: McpAgent }}
 */
export function resolveStitchAgent(ctx) {
  const stitchConfig = ctx.config.design?.stitch;
  if (!stitchConfig?.enabled) {
    throw new Error(
      "Stitch is not enabled. Set design.stitch.enabled=true in coder.json.",
    );
  }
  if (!stitchConfig.serverCommand) {
    throw new Error(
      "Stitch server command not configured. Set design.stitch.serverCommand in coder.json.",
    );
  }

  const apiKeyEnv = stitchConfig.apiKeyEnv || "GOOGLE_STITCH_API_KEY";
  const apiKey = process.env[apiKeyEnv] || "";
  const env = apiKey ? { [apiKeyEnv]: apiKey } : {};

  const { agentName, agent } = ctx.agentPool.getAgent("stitch", {
    mode: "mcp",
    serverCommand: stitchConfig.serverCommand,
    serverName: "stitch",
    env,
  });
  if (!(agent instanceof McpAgent)) {
    throw new Error("Stitch agent must be an MCP agent.");
  }
  return { agentName, agent };
}
