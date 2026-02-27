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

test("GH-117: kill() aborts multiple concurrent requests", async () => {
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    return new Promise((_resolve, reject) => {
      if (opts.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        return reject(err);
      }
      opts.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };

  try {
    const agent = new ApiAgent({
      provider: "gemini",
      endpoint: "https://test",
      apiKey: "test-key",
    });

    const p1 = agent.execute("a");
    const p2 = agent.execute("b");
    const p3 = agent.execute("c");

    await agent.kill();
    const results = await Promise.all([p1, p2, p3]);

    for (const res of results) {
      assert.equal(
        res.exitCode,
        124,
        "aborted request should return exitCode 124",
      );
    }
    assert.equal(agent.activeControllers.size, 0);
  } finally {
    global.fetch = origFetch;
  }
});

test("GH-117: concurrent execute() calls don't interfere", async () => {
  const origFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    const n = ++callCount;
    await new Promise((r) => setTimeout(r, 50));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: `resp-${n}` }] } }],
      }),
    };
  };

  try {
    const agent = new ApiAgent({
      provider: "gemini",
      endpoint: "https://test",
      apiKey: "test-key",
    });

    const [r1, r2] = await Promise.all([
      agent.execute("a"),
      agent.execute("b"),
    ]);

    assert.equal(r1.exitCode, 0);
    assert.equal(r2.exitCode, 0);
    assert.ok(r1.stdout.startsWith("resp-"));
    assert.ok(r2.stdout.startsWith("resp-"));
    assert.equal(agent.activeControllers.size, 0);
  } finally {
    global.fetch = origFetch;
  }
});

test("GH-117: one call's timeout does not abort a concurrent call", async () => {
  const origFetch = global.fetch;
  const resolvers = [];
  global.fetch = async (_url, opts) => {
    return new Promise((resolve, reject) => {
      opts.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
      resolvers.push(resolve);
    });
  };

  try {
    const agent = new ApiAgent({
      provider: "gemini",
      endpoint: "https://test",
      apiKey: "test-key",
    });

    // Call A: very short timeout → will abort
    const pA = agent.execute("a", { timeoutMs: 10 });
    // Call B: long timeout → should survive A's timeout
    const pB = agent.execute("b", { timeoutMs: 60_000 });

    const resA = await pA;
    assert.equal(resA.exitCode, 124, "short-timeout call should abort");

    // Resolve B's fetch after A has timed out
    resolvers[1]({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok-b" }] } }],
      }),
    });
    const resB = await pB;
    assert.equal(resB.exitCode, 0, "long-timeout call must not be aborted");
    assert.equal(resB.stdout, "ok-b");
    assert.equal(agent.activeControllers.size, 0);
  } finally {
    global.fetch = origFetch;
  }
});

test("GH-117: new request after kill() is not pre-aborted", async () => {
  const origFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async (_url, opts) => {
    fetchCount++;
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        return reject(err);
      }
      opts.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
      resolve({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "fresh" }] } }],
        }),
      });
    });
  };

  try {
    const agent = new ApiAgent({
      provider: "gemini",
      endpoint: "https://test",
      apiKey: "test-key",
    });

    // Start and immediately kill
    const p1 = agent.execute("a");
    await agent.kill();
    await p1;

    // New request after kill must succeed
    fetchCount = 0;
    const res = await agent.execute("b");
    assert.equal(res.exitCode, 0, "post-kill request must not be pre-aborted");
    assert.equal(res.stdout, "fresh");
    assert.equal(fetchCount, 1);
    assert.equal(agent.activeControllers.size, 0);
  } finally {
    global.fetch = origFetch;
  }
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
