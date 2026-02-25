import { McpAgent } from "../../agents/mcp-agent.js";

/**
 * Validate that Stitch config is present and well-formed.
 * Throws immediately if disabled or missing required fields.
 *
 * @param {object} ctx - Workflow context
 */
export function validateStitchConfig(ctx) {
  const stitchConfig = ctx.config.design?.stitch;
  if (!stitchConfig?.enabled) {
    throw new Error(
      "Stitch is not enabled. Set design.stitch.enabled=true in coder.json.",
    );
  }

  const transport = stitchConfig.transport || "stdio";
  if (transport === "stdio" && !stitchConfig.serverCommand) {
    throw new Error(
      "Stitch server command not configured. Set design.stitch.serverCommand in coder.json.",
    );
  }
  if (transport === "http" && !stitchConfig.serverUrl) {
    throw new Error(
      "Stitch server URL not configured. Set design.stitch.serverUrl in coder.json.",
    );
  }
}

/**
 * Resolve a Stitch MCP agent from config.
 * Shared by ui-generation and ui-refinement machines.
 *
 * @param {object} ctx - Workflow context
 * @returns {{ agentName: string, agent: McpAgent }}
 */
export function resolveStitchAgent(ctx) {
  validateStitchConfig(ctx);

  const stitchConfig = ctx.config.design.stitch;
  const transport = stitchConfig.transport || "stdio";
  const apiKeyEnv = stitchConfig.apiKeyEnv || "GOOGLE_STITCH_API_KEY";
  const apiKey = process.env[apiKeyEnv] || "";
  const env = apiKey ? { [apiKeyEnv]: apiKey } : {};

  const { agentName, agent } = ctx.agentPool.getAgent("stitch", {
    mode: "mcp",
    transport,
    serverCommand: stitchConfig.serverCommand,
    serverUrl: stitchConfig.serverUrl,
    authHeader: stitchConfig.authHeader || "X-Goog-Api-Key",
    serverName: "stitch",
    env,
  });
  if (!(agent instanceof McpAgent)) {
    throw new Error("Stitch agent must be an MCP agent.");
  }
  return { agentName, agent };
}
