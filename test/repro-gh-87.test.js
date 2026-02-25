import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpAgent } from "../src/agents/mcp-agent.js";

function makeNetworkError(code) {
  const err = new Error(`connect ${code}`);
  err.code = code;
  return err;
}

function makeHttpError(statusCode, message) {
  const err = new Error(`Streamable HTTP error: ${message}`);
  err.code = statusCode;
  return err;
}

function makeMockClient(overrides = {}) {
  return {
    connect: overrides.connect || (async () => {}),
    listTools: overrides.listTools || (async () => ({ tools: [] })),
    callTool:
      overrides.callTool ||
      (async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: async () => {},
  };
}

test("GH-87: transient ECONNRESET is retried and succeeds", async () => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 2,
    backoffMs: 0,
  });

  let calls = 0;
  const mock = makeMockClient({
    callTool: async () => {
      calls++;
      if (calls < 2) throw makeNetworkError("ECONNRESET");
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  agent._client = mock;

  const res = await agent.callTool("test_tool", {});
  assert.equal(res.content[0].text, "ok");
  assert.equal(calls, 2);
});

test("GH-87: agent succeeds if server available within retry limit", async () => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 3,
    backoffMs: 0,
  });

  let calls = 0;
  const mock = makeMockClient({
    listTools: async () => {
      calls++;
      if (calls < 3) throw makeNetworkError("ECONNREFUSED");
      return { tools: [{ name: "t1" }] };
    },
  });
  agent._client = mock;

  const tools = await agent.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "t1");
  assert.equal(calls, 3);
});

test("GH-87: permanent 404 fails immediately without retrying", async () => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 3,
    backoffMs: 0,
  });

  let calls = 0;
  const mock = makeMockClient({
    callTool: async () => {
      calls++;
      throw makeHttpError(404, "Not Found");
    },
  });
  agent._client = mock;

  await assert.rejects(() => agent.callTool("missing", {}));
  assert.equal(calls, 1);
});

test("GH-87: _ensureClient retries transient connection failures", async (t) => {
  const agent = new McpAgent({
    transport: "http",
    serverUrl: "http://localhost:1",
    retries: 2,
    backoffMs: 0,
  });

  let connectCalls = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    connectCalls++;
    if (connectCalls < 2) throw makeNetworkError("ECONNREFUSED");
  });

  const client = await agent._ensureClient();
  assert.ok(client);
  assert.equal(connectCalls, 2);
});

test("GH-87: stdio transport does not retry", async () => {
  const agent = new McpAgent({
    transport: "stdio",
    serverCommand: "echo",
    retries: 3,
    backoffMs: 0,
  });

  let calls = 0;
  const mock = makeMockClient({
    callTool: async () => {
      calls++;
      throw makeNetworkError("ECONNRESET");
    },
  });
  agent._client = mock;

  await assert.rejects(() => agent.callTool("test", {}));
  assert.equal(calls, 1);
});
