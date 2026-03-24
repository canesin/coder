import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpAgent } from "../src/agents/mcp-agent.js";

test("REV-03: concurrent callers share one initialization promise", async (t) => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 0,
    backoffMs: 0,
  });

  const resolvers = [];
  let connectCalls = 0;
  t.mock.method(Client.prototype, "connect", () => {
    connectCalls++;
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  });

  const p1 = agent._ensureClient();

  // Simulate the retry-window race: _client is cleared while connection is in flight
  agent._client = null;

  const p2 = agent._ensureClient();

  for (const r of resolvers) r();
  await Promise.all([p1, p2]);

  assert.equal(
    connectCalls,
    1,
    "Expected Client.connect to be called exactly once",
  );
});

test("REV-03: kill() aborts in-flight _ensureClient()", async (t) => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 0,
    backoffMs: 0,
  });

  t.mock.method(Client.prototype, "connect", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const p = agent._ensureClient();
  await agent.kill();
  assert.equal(
    agent._connectPromise,
    null,
    "_connectPromise should be null after kill()",
  );

  await assert.rejects(p, { message: /aborted by kill/ });
  assert.equal(agent._client, null, "_client should remain null after kill()");
});
