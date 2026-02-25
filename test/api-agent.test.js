import assert from "node:assert/strict";
import test from "node:test";
import { ApiAgent } from "../src/agents/api-agent.js";
import { McpAgent } from "../src/agents/mcp-agent.js";

test("GH-59: Gemini API key in x-goog-api-key header, not URL", async () => {
  let capturedUrl;
  let capturedHeaders;

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    };
  };

  try {
    const agent = new ApiAgent({
      provider: "gemini",
      endpoint: "https://test",
      apiKey: "test-key",
    });
    const res = await agent.execute("hello");

    assert.equal(res.stdout, "ok");
    assert.equal(
      new URL(capturedUrl).searchParams.get("key"),
      null,
      "API key must not appear in URL query params",
    );
    assert.equal(
      capturedHeaders["x-goog-api-key"],
      "test-key",
      "API key must be in x-goog-api-key header",
    );
  } finally {
    global.fetch = origFetch;
  }
});

test("GH-81: executeStructured skips JSON parse on non-zero exitCode", async () => {
  const agent = new ApiAgent({
    provider: "gemini",
    endpoint: "http://localhost",
    apiKey: "none",
  });
  agent.execute = async () => ({
    exitCode: 1,
    stdout: "Plain text error",
    stderr: "Some stderr",
  });

  const res = await agent.executeStructured("test prompt");
  assert.equal(res.exitCode, 1);
  assert.equal(res.parsed, undefined);
  assert.equal(res.stdout, "Plain text error");
  assert.equal(res.stderr, "Some stderr");
});

test("GH-81: executeStructured parses JSON on exitCode 0", async () => {
  const agent = new ApiAgent({
    provider: "gemini",
    endpoint: "http://localhost",
    apiKey: "none",
  });
  agent.execute = async () => ({
    exitCode: 0,
    stdout: '{"ok":true}',
    stderr: "",
  });

  const res = await agent.executeStructured("test prompt");
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.parsed, { ok: true });
});

test("GH-81: McpAgent executeStructured returns undefined on failure", async () => {
  const agent = new McpAgent({ serverCommand: "true" });
  agent.execute = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "connection refused",
  });

  const res = await agent.executeStructured("test prompt");
  assert.equal(res.exitCode, 1);
  assert.equal(res.parsed, undefined);
});
