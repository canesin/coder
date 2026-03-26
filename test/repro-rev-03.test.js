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

  // Second concurrent call should reuse the in-flight _connectPromise
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

test("REV-03: restart after kill() does not corrupt new attempt", async (t) => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 0,
    backoffMs: 0,
  });

  // Controllable connect mock: each call gets its own resolver
  const resolvers = [];
  t.mock.method(Client.prototype, "connect", () => {
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  });

  // Attempt A starts connecting
  const pA = agent._ensureClient();
  assert.equal(resolvers.length, 1, "first connect started");

  // kill() invalidates attempt A
  await agent.kill();

  // Attempt B starts a fresh connection
  const pB = agent._ensureClient();
  assert.equal(resolvers.length, 2, "second connect started");

  // Resolve attempt A first, then attempt B
  resolvers[0]();
  resolvers[1]();

  await assert.rejects(pA, { message: /aborted by kill/ });

  const clientB = await pB;
  assert.ok(clientB, "second _ensureClient() should return a non-null client");
  assert.equal(
    agent._client,
    clientB,
    "agent._client should be the client from attempt B",
  );
});
