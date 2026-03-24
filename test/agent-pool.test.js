import assert from "node:assert/strict";
import test from "node:test";

import { AgentPool } from "../src/agents/pool.js";
import { CoderConfigSchema } from "../src/config.js";

function makePool() {
  return new AgentPool({
    config: CoderConfigSchema.parse({}),
    workspaceDir: "/tmp",
    repoRoot: "/tmp",
    passEnv: [],
  });
}

test("AgentPool forwards MCP options to _getMcpAgent", () => {
  const pool = makePool();
  const { agentName } = pool.getAgent("stitch", {
    mode: "mcp",
    transport: "stdio",
    serverCommand: "node",
    serverName: "my-stitch",
  });
  assert.equal(agentName, "my-stitch");
});

test("AgentPool forwards API options to _getApiAgent", () => {
  const pool = makePool();
  const { agentName } = pool.getAgent("gemini", {
    mode: "api",
    provider: "anthropic",
  });
  assert.equal(agentName, "anthropic-api");
});
