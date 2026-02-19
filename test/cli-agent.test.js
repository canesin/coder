import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliAgent } from "../src/agents/cli-agent.js";
import { CoderConfigSchema } from "../src/config.js";

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "cli-agent-test-"));
}

function makeMinimalConfig(overrides = {}) {
  const defaults = {
    models: {
      gemini: {
        model: "gemini-pro",
        apiEndpoint: "https://example.com",
        apiKeyEnv: "KEY",
      },
    },
  };
  return CoderConfigSchema.parse({ ...defaults, ...overrides });
}

test("executeWithRetry: retries 5 times by default on rate limit", async () => {
  const tmp = makeTmpDir();
  const config = makeMinimalConfig();
  const agent = new CliAgent("gemini", {
    cwd: tmp,
    secrets: {},
    config,
    workspaceDir: tmp,
  });

  let calls = 0;
  const mockRun = async () => {
    calls++;
    return {
      exitCode: 1,
      stdout: "rate limit exceeded 429",
      stderr: "",
    };
  };

  agent._sandbox = {
    on: () => {},
    commands: { run: mockRun },
    kill: async () => {},
  };

  await assert.rejects(
    async () => {
      await agent.executeWithRetry("test prompt", {
        retryOnRateLimit: true,
        backoffMs: 1,
      });
    },
    (err) => err.name === "RateLimitError",
  );

  assert.equal(calls, 6);

  rmSync(tmp, { recursive: true, force: true });
});

test("executeWithRetry: respects custom retries option", async () => {
  const tmp = makeTmpDir();
  const config = makeMinimalConfig();
  const agent = new CliAgent("gemini", {
    cwd: tmp,
    secrets: {},
    config,
    workspaceDir: tmp,
  });

  let calls = 0;
  const mockRun = async () => {
    calls++;
    return {
      exitCode: 1,
      stdout: "rate limit exceeded 429",
      stderr: "",
    };
  };

  agent._sandbox = {
    on: () => {},
    commands: { run: mockRun },
    kill: async () => {},
  };

  await assert.rejects(
    async () => {
      await agent.executeWithRetry("test prompt", {
        retryOnRateLimit: true,
        retries: 2,
        backoffMs: 1,
      });
    },
    (err) => err.name === "RateLimitError",
  );

  assert.equal(calls, 3);

  rmSync(tmp, { recursive: true, force: true });
});

test("executeWithRetry: does not retry on CommandTimeoutError", async () => {
  const tmp = makeTmpDir();
  const config = makeMinimalConfig();
  const agent = new CliAgent("gemini", {
    cwd: tmp,
    secrets: {},
    config,
    workspaceDir: tmp,
  });

  let calls = 0;
  const mockRun = async () => {
    calls++;
    const err = new Error("timeout");
    err.name = "CommandTimeoutError";
    throw err;
  };

  agent._sandbox = {
    on: () => {},
    commands: { run: mockRun },
    kill: async () => {},
  };

  await assert.rejects(
    async () => {
      await agent.executeWithRetry("test prompt", {
        retryOnRateLimit: true,
        backoffMs: 1,
      });
    },
    (err) => err.name === "CommandTimeoutError",
  );

  assert.equal(calls, 1);

  rmSync(tmp, { recursive: true, force: true });
});

test("executeWithFallback: switches to fallback model after rate limit exhaustion", async () => {
  const tmp = makeTmpDir();
  const config = makeMinimalConfig({
    models: {
      gemini: {
        model: "gemini-pro",
        fallbackModel: "gemini-flash",
      },
    },
  });
  const agent = new CliAgent("gemini", {
    cwd: tmp,
    secrets: {},
    config,
    workspaceDir: tmp,
  });

  const executedCommands = [];
  const mockRun = async (cmd) => {
    executedCommands.push(cmd);
    if (cmd.includes("gemini-pro")) {
      return {
        exitCode: 1,
        stdout: "rate limit 429",
        stderr: "",
      };
    }
    if (cmd.includes("gemini-flash")) {
      return {
        exitCode: 0,
        stdout: "success",
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "unknown", stderr: "" };
  };

  agent._sandbox = {
    on: () => {},
    commands: { run: mockRun },
    kill: async () => {},
  };

  const res = await agent.executeWithFallback("prompt", {
    retryOnRateLimit: true,
    backoffMs: 1,
  });

  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "success");

  const proCalls = executedCommands.filter((c) =>
    c.includes("gemini-pro"),
  ).length;
  const flashCalls = executedCommands.filter((c) =>
    c.includes("gemini-flash"),
  ).length;

  assert.equal(proCalls, 6);
  assert.ok(flashCalls >= 1);

  rmSync(tmp, { recursive: true, force: true });
});

test("executeWithFallback: rethrows RateLimitError when no fallback configured", async () => {
  const tmp = makeTmpDir();
  const config = makeMinimalConfig({
    models: {
      gemini: {
        model: "gemini-pro",
        fallbackModel: "",
      },
    },
  });
  const agent = new CliAgent("gemini", {
    cwd: tmp,
    secrets: {},
    config,
    workspaceDir: tmp,
  });

  const mockRun = async () => {
    return {
      exitCode: 1,
      stdout: "rate limit 429",
      stderr: "",
    };
  };

  agent._sandbox = {
    on: () => {},
    commands: { run: mockRun },
    kill: async () => {},
  };

  await assert.rejects(
    async () => {
      await agent.executeWithFallback("prompt", {
        retryOnRateLimit: true,
        backoffMs: 1,
      });
    },
    (err) => err.name === "RateLimitError",
  );

  rmSync(tmp, { recursive: true, force: true });
});

test("config: ModelEntrySchema accepts fallbackModel", () => {
  const parsed = CoderConfigSchema.parse({
    models: {
      gemini: {
        model: "gemini-pro",
        fallbackModel: "gemini-flash",
      },
    },
  });
  assert.equal(parsed.models.gemini.fallbackModel, "gemini-flash");
});

test("config: ModelEntrySchema rejects invalid fallbackModel names", () => {
  assert.throws(() => {
    CoderConfigSchema.parse({
      models: {
        gemini: {
          model: "gemini-pro",
          fallbackModel: "bad;model",
        },
      },
    });
  }, /Invalid model name/);
});

test("executeWithRetry: retryOnRateLimit defaults to true", async () => {
  const tmp = makeTmpDir();
  const config = makeMinimalConfig();
  const agent = new CliAgent("gemini", {
    cwd: tmp,
    secrets: {},
    config,
    workspaceDir: tmp,
  });

  let calls = 0;
  const mockRun = async () => {
    calls++;
    return { exitCode: 1, stdout: "rate limit exceeded 429", stderr: "" };
  };

  agent._sandbox = {
    on: () => {},
    commands: { run: mockRun },
    kill: async () => {},
  };

  await assert.rejects(
    async () => {
      await agent.executeWithRetry("test prompt", { backoffMs: 1 });
    },
    (err) => err.name === "RateLimitError",
  );

  assert.ok(calls > 1, `Expected retries, got calls=${calls}`);

  rmSync(tmp, { recursive: true, force: true });
});
