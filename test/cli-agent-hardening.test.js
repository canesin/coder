import assert from "node:assert/strict";
import test from "node:test";

import { CliAgent } from "../src/agents/cli-agent.js";
import { CoderConfigSchema } from "../src/config.js";

/**
 * Build a CliAgent with a mock sandbox so we can inspect what options
 * flow through to sandbox.commands.run() without spawning real processes.
 */
function makeTestAgent(name, configOverrides = {}) {
  const config = CoderConfigSchema.parse(configOverrides);
  const agent = new CliAgent(name, {
    cwd: "/tmp",
    secrets: {},
    config,
    workspaceDir: "/tmp",
  });

  // Capture what sandbox.commands.run receives
  const calls = [];
  const mockSandbox = {
    on() {},
    kill: async () => {},
    commands: {
      run(_cmd, opts) {
        calls.push(opts);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    },
  };
  // Bypass _ensureSandbox by injecting directly
  agent._sandbox = mockSandbox;

  return { agent, calls };
}

test("config hangTimeoutMs flows to sandbox when caller does not override", async () => {
  const { agent, calls } = makeTestAgent("claude", {
    agents: { retry: { hangTimeoutMs: 180_000 } },
  });
  await agent.execute("test prompt");
  assert.equal(calls[0].hangTimeoutMs, 180_000);
});

test("per-call hangTimeoutMs takes precedence over config", async () => {
  const { agent, calls } = makeTestAgent("claude", {
    agents: { retry: { hangTimeoutMs: 180_000 } },
  });
  await agent.execute("test prompt", { hangTimeoutMs: 120_000 });
  assert.equal(calls[0].hangTimeoutMs, 120_000);
});

test("explicit hangTimeoutMs: 0 disables even with config value", async () => {
  const { agent, calls } = makeTestAgent("claude", {
    agents: { retry: { hangTimeoutMs: 180_000 } },
  });
  await agent.execute("test prompt", { hangTimeoutMs: 0 });
  assert.equal(calls[0].hangTimeoutMs, 0);
});

test("default config gives 300_000 hang timeout to all agents", async () => {
  const { agent, calls } = makeTestAgent("gemini");
  await agent.execute("test prompt");
  assert.equal(calls[0].hangTimeoutMs, 300_000);
});

test("codex agent gets CODEX_FAILURE_PATTERNS", async () => {
  const { agent, calls } = makeTestAgent("codex");
  await agent.execute("test prompt");
  const patterns = calls[0].killOnStderrPatterns;
  assert.equal(patterns.length, 2);
  assert.equal(patterns[0].pattern, "org.freedesktop.secrets");
  assert.equal(patterns[0].category, "auth");
  assert.equal(patterns[1].pattern, "Cannot autolaunch D-Bus");
  assert.equal(patterns[1].category, "auth");
});

test("claude without session gets empty patterns", async () => {
  const { agent, calls } = makeTestAgent("claude");
  await agent.execute("test prompt");
  assert.deepEqual(calls[0].killOnStderrPatterns, []);
});

test("claude with session gets resume failure patterns", async () => {
  const { agent, calls } = makeTestAgent("claude");
  await agent.execute("test prompt", { resumeId: "abc" });
  const patterns = calls[0].killOnStderrPatterns;
  assert.ok(patterns.length > 0, "should have resume patterns");
  assert.ok(
    patterns.some((p) => p.pattern.includes("session")),
    "should match session-related patterns",
  );
});

test("gemini gets auth + transient patterns", async () => {
  const { agent, calls } = makeTestAgent("gemini");
  await agent.execute("test prompt");
  const patterns = calls[0].killOnStderrPatterns;
  assert.ok(
    patterns.some((p) => p.category === "auth"),
    "should have auth patterns",
  );
  assert.ok(
    patterns.some((p) => p.category === "transient"),
    "should have transient patterns",
  );
});

test("gemini transient patterns include quota-exceeded and RESOURCE_EXHAUSTED", async () => {
  const { agent, calls } = makeTestAgent("gemini");
  await agent.execute("test prompt");
  const patterns = calls[0].killOnStderrPatterns;
  assert.ok(
    patterns.some((p) => p.pattern.includes("exceeded your current quota")),
    "should match quota-exceeded",
  );
  assert.ok(
    patterns.some((p) => p.pattern === "RESOURCE_EXHAUSTED"),
    "should match RESOURCE_EXHAUSTED",
  );
  assert.ok(
    patterns.filter((p) => p.category === "rate_limit").length >= 2,
    "should have rate_limit category entries",
  );
});

test("unknown agent gets empty patterns and config hang timeout", async () => {
  const { agent, calls } = makeTestAgent("custom-agent");
  await agent.execute("test prompt");
  assert.deepEqual(calls[0].killOnStderrPatterns, []);
  assert.equal(calls[0].hangTimeoutMs, 300_000);
});
