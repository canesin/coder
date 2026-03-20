import assert from "node:assert/strict";
import test from "node:test";

import { ApiAgent } from "../src/agents/api-agent.js";
import { AgentPool } from "../src/agents/pool.js";
import { CoderConfigSchema } from "../src/config.js";
import { isRateLimitError } from "../src/helpers.js";

function makeConfig(retryOverrides = {}, fallbackOverrides = {}) {
  return CoderConfigSchema.parse({
    agents: {
      retry: { retries: 3, backoffMs: 0, ...retryOverrides },
      fallback: fallbackOverrides,
    },
  });
}

function makeMockAgent(responses) {
  let call = 0;
  return {
    async execute(_prompt, _opts) {
      const res = responses[Math.min(call++, responses.length - 1)];
      if (res instanceof Error) throw res;
      return res;
    },
    async executeStructured(prompt, opts) {
      const res = await this.execute(prompt, opts);
      let parsed;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {}
      return { ...res, parsed };
    },
    async executeWithRetry(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async kill() {},
  };
}

function makePool(config) {
  return new AgentPool({
    config,
    workspaceDir: "/tmp",
    repoRoot: "/tmp",
    passEnv: [],
  });
}

test("RetryFallbackWrapper retries on non-zero exitCode", async () => {
  const config = makeConfig({ retries: 3, backoffMs: 0 });
  const pool = makePool(config);

  const fail = { exitCode: 1, stdout: "", stderr: "transient" };
  const ok = { exitCode: 0, stdout: "done", stderr: "" };
  const mock = makeMockAgent([fail, fail, ok]);

  const { agent } = pool.getAgent("planner");
  agent._primary = mock;

  const res = await agent.execute("prompt");
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "done");
});

test("RetryFallbackWrapper does not retry more than retries", async () => {
  const config = makeConfig({ retries: 2, backoffMs: 0 });
  const pool = makePool(config);

  const fail = { exitCode: 1, stdout: "", stderr: "always fails" };
  const mock = makeMockAgent([fail]);

  const { agent } = pool.getAgent("planner");
  agent._primary = mock;

  await assert.rejects(async () => {
    await agent.execute("prompt");
  });
});

test("RetryFallbackWrapper detects rate-limit text and retries when retryOnRateLimit:true", async () => {
  const config = makeConfig({
    retries: 3,
    backoffMs: 0,
    retryOnRateLimit: true,
  });
  const pool = makePool(config);

  const rateLimited = {
    exitCode: 1,
    stdout: "",
    stderr: "429 rate limit exceeded",
  };
  const ok = { exitCode: 0, stdout: "ok", stderr: "" };
  const mock = makeMockAgent([rateLimited, rateLimited, ok]);

  const { agent } = pool.getAgent("planner");
  agent._primary = mock;

  const res = await agent.execute("prompt");
  assert.equal(res.exitCode, 0);
});

test("RetryFallbackWrapper invokes fallback after primary exhausts retries", async () => {
  const config = CoderConfigSchema.parse({
    agents: {
      retry: { retries: 1, backoffMs: 0 },
      fallback: { planner: "codex" },
    },
  });
  const pool = makePool(config);

  const fail = { exitCode: 1, stdout: "", stderr: "primary failed" };
  const fallbackOk = { exitCode: 0, stdout: "from-fallback", stderr: "" };
  const primaryMock = makeMockAgent([fail]);
  const fallbackMock = makeMockAgent([fallbackOk]);

  const { agent } = pool.getAgent("planner");
  agent._primary = primaryMock;
  agent._fallback = fallbackMock;

  const res = await agent.execute("prompt");
  assert.equal(res.stdout, "from-fallback");
});

test("RetryFallbackWrapper skips fallback when not configured", async () => {
  const config = makeConfig({ retries: 1, backoffMs: 0 });
  const pool = makePool(config);

  const fail = { exitCode: 1, stdout: "", stderr: "no fallback" };
  const mock = makeMockAgent([fail]);

  const { agent } = pool.getAgent("planner");
  agent._primary = mock;
  agent._fallback = null;

  await assert.rejects(async () => {
    await agent.execute("prompt");
  });
});

test("executeStructured retries and returns parsed JSON on success", async () => {
  const config = makeConfig({ retries: 2, backoffMs: 0 });
  const pool = makePool(config);

  const fail = { exitCode: 1, stdout: "", stderr: "transient" };
  const ok = { exitCode: 0, stdout: '{"result":42}', stderr: "" };
  const mock = makeMockAgent([fail, ok]);

  const { agent } = pool.getAgent("planner");
  agent._primary = mock;

  const res = await agent.executeStructured("prompt");
  assert.equal(res.exitCode, 0);
  assert.equal(res.parsed?.result, 42);
});

test("executeWithRetry is an alias for execute on wrapper", async () => {
  const config = makeConfig({ retries: 1, backoffMs: 0 });
  const pool = makePool(config);

  const ok = { exitCode: 0, stdout: "alias-ok", stderr: "" };
  const mock = makeMockAgent([ok]);

  const { agent } = pool.getAgent("planner");
  agent._primary = mock;

  const res = await agent.executeWithRetry("prompt");
  assert.equal(res.stdout, "alias-ok");
});

test("ApiAgent.executeWithRetry retries on HTTP error and succeeds", async () => {
  const agent = new ApiAgent({
    provider: "gemini",
    endpoint: "https://example.invalid",
    apiKey: "test-key",
    model: "gemini-test",
  });

  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) {
      return {
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      };
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "hello" }] } }],
      }),
    };
  };

  try {
    const res = await agent.executeWithRetry("test", {
      retries: 3,
      backoffMs: 0,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "hello");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("config.agents.retry schema: defaults", () => {
  const config = CoderConfigSchema.parse({});
  assert.equal(config.agents.retry.retries, 1);
  assert.equal(config.agents.retry.backoffMs, 5000);
  assert.equal(config.agents.retry.retryOnRateLimit, true);
  assert.equal(config.agents.retry.hangTimeoutMs, 300_000);
});

test("config.agents.retry.hangTimeoutMs can be overridden", () => {
  const config = CoderConfigSchema.parse({
    agents: { retry: { hangTimeoutMs: 60_000 } },
  });
  assert.equal(config.agents.retry.hangTimeoutMs, 60_000);
});

test("config.agents.retry.hangTimeoutMs: 0 disables hang detection", () => {
  const config = CoderConfigSchema.parse({
    agents: { retry: { hangTimeoutMs: 0 } },
  });
  assert.equal(config.agents.retry.hangTimeoutMs, 0);
});

test("config.agents.fallback schema: accepts role-to-name map", () => {
  const config = CoderConfigSchema.parse({
    agents: { fallback: { planner: "claude" } },
  });
  assert.equal(config.agents.fallback.planner, "claude");
});

test("isRateLimitError detects 429, rate limit, resource_exhausted, quota", () => {
  assert.equal(isRateLimitError("429 Too Many Requests"), true);
  assert.equal(isRateLimitError("rate limit exceeded"), true);
  assert.equal(isRateLimitError("RESOURCE_EXHAUSTED quota"), true);
  assert.equal(isRateLimitError("quota exceeded"), true);
  assert.equal(isRateLimitError("regular error"), false);
  assert.equal(isRateLimitError(""), false);
});

// --- Bug 1: fallback receives no resumeId; primary retried on auth error ---

test("fallback agent receives no resumeId or sessionId", async () => {
  let fallbackOpts = null;

  const config = CoderConfigSchema.parse({
    agents: {
      retry: { retries: 1, backoffMs: 0 },
      fallback: { planner: "codex" },
    },
  });
  const pool = makePool(config);

  const primaryMock = makeMockAgent([
    { exitCode: 1, stdout: "", stderr: "primary failed" },
  ]);
  const fallbackMock = {
    async execute(_prompt, opts) {
      fallbackOpts = opts;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async executeStructured(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async executeWithRetry(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async kill() {},
  };

  const { agent } = pool.getAgent("planner");
  agent._primary = primaryMock;
  agent._fallback = fallbackMock;

  await agent.execute("test prompt", {
    resumeId: "sess-123",
    sessionId: "sid-456",
    timeoutMs: 5000,
  });

  assert.ok(fallbackOpts, "fallback should have been called");
  assert.equal(fallbackOpts.resumeId, undefined, "resumeId must be stripped");
  assert.equal(fallbackOpts.sessionId, undefined, "sessionId must be stripped");
  assert.equal(fallbackOpts.timeoutMs, 5000, "other opts preserved");
});

test("auth error with session propagates so machine can run full fix", async () => {
  const calls = [];

  const config = CoderConfigSchema.parse({
    agents: {
      retry: { retries: 1, backoffMs: 0 },
      fallback: { planner: "codex" },
    },
  });
  const pool = makePool(config);

  const authErr = new Error("auth error");
  authErr.name = "CommandFatalStderrError";
  authErr.category = "auth";

  const primaryMock = {
    async execute(_prompt, opts) {
      calls.push({
        agent: "primary",
        hasSession: !!(opts?.resumeId || opts?.sessionId),
      });
      if (opts?.resumeId || opts?.sessionId) {
        throw authErr;
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async executeStructured(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async executeWithRetry(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async kill() {},
  };
  const fallbackMock = {
    async execute() {
      calls.push({ agent: "fallback" });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async executeStructured(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async executeWithRetry(prompt, opts) {
      return this.execute(prompt, opts);
    },
    async kill() {},
  };

  const { agent } = pool.getAgent("planner");
  agent._primary = primaryMock;
  agent._fallback = fallbackMock;

  // Auth errors with session must propagate so the machine can clearAllSessionIdsAndDisable
  // and retry. The pool does not retry or try fallback — it throws.
  await assert.rejects(
    () =>
      agent.execute("test prompt", {
        resumeId: "sess-123",
        sessionId: "sid-456",
      }),
    (err) => err === authErr,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { agent: "primary", hasSession: true });
});
