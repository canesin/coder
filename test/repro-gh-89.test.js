import assert from "node:assert/strict";
import test from "node:test";

import { CliAgent } from "../src/agents/cli-agent.js";
import { CoderConfigSchema } from "../src/config.js";

function makeCommandAuthError(message) {
  const err = new Error(message);
  err.name = "CommandAuthError";
  return err;
}

function makeConfig() {
  return CoderConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// CliAgent killOnStderrPatterns wiring
// ---------------------------------------------------------------------------

test("CliAgent wires CLAUDE_RESUME_FAILURE_PATTERNS when claude + resumeId", async () => {
  const config = makeConfig();
  const agent = new CliAgent("claude", {
    cwd: "/tmp",
    secrets: {},
    config,
    workspaceDir: "/tmp",
  });

  let capturedOpts;
  agent._ensureSandbox = async () => ({
    commands: {
      run(_cmd, opts) {
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  await agent.execute("test prompt", { resumeId: "fake-uuid" });
  assert.ok(
    capturedOpts.killOnStderrPatterns.some((p) =>
      p.includes("No conversation found with session ID"),
    ),
    "should include Claude resume failure pattern",
  );
});

test("CliAgent wires CLAUDE_RESUME_FAILURE_PATTERNS when claude + sessionId", async () => {
  const config = makeConfig();
  const agent = new CliAgent("claude", {
    cwd: "/tmp",
    secrets: {},
    config,
    workspaceDir: "/tmp",
  });

  let capturedOpts;
  agent._ensureSandbox = async () => ({
    commands: {
      run(_cmd, opts) {
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  await agent.execute("test prompt", { sessionId: "fake-uuid" });
  assert.ok(
    capturedOpts.killOnStderrPatterns.length > 0,
    "should include Claude resume failure patterns when sessionId is provided",
  );
  assert.ok(
    capturedOpts.killOnStderrPatterns.some((p) =>
      p.includes("No conversation found with session ID"),
    ),
    "should include Claude resume failure pattern",
  );
});

test("All expected Claude resume failure patterns are present", async () => {
  const config = makeConfig();
  const agent = new CliAgent("claude", {
    cwd: "/tmp",
    secrets: {},
    config,
    workspaceDir: "/tmp",
  });

  let capturedOpts;
  agent._ensureSandbox = async () => ({
    commands: {
      run(_cmd, opts) {
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  await agent.execute("test prompt", { resumeId: "fake-uuid" });

  const expected = [
    "No conversation found with session ID",
    "Conversation not found",
    "Session not found",
    "Invalid session ID",
    "Conversation has expired",
    "Session has expired",
  ];
  assert.equal(capturedOpts.killOnStderrPatterns.length, expected.length);
  for (const pattern of expected) {
    assert.ok(
      capturedOpts.killOnStderrPatterns.some((p) => p.includes(pattern)),
      `should include pattern: "${pattern}"`,
    );
  }
});

test("CliAgent does NOT add resume patterns for claude without resumeId or sessionId", async () => {
  const config = makeConfig();
  const agent = new CliAgent("claude", {
    cwd: "/tmp",
    secrets: {},
    config,
    workspaceDir: "/tmp",
  });

  let capturedOpts;
  agent._ensureSandbox = async () => ({
    commands: {
      run(_cmd, opts) {
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  await agent.execute("test prompt", {});
  assert.deepEqual(capturedOpts.killOnStderrPatterns, []);
});

test("CliAgent does NOT add resume patterns for gemini with resumeId", async () => {
  const config = makeConfig();
  const agent = new CliAgent("gemini", {
    cwd: "/tmp",
    secrets: {},
    config,
    workspaceDir: "/tmp",
  });

  let capturedOpts;
  agent._ensureSandbox = async () => ({
    commands: {
      run(_cmd, opts) {
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  await agent.execute("test prompt", { resumeId: "fake-uuid" });
  // Gemini should get its own auth patterns, not Claude resume patterns
  assert.ok(
    !capturedOpts.killOnStderrPatterns.some((p) =>
      p.includes("No conversation found with session ID"),
    ),
    "should NOT include Claude resume failure pattern for gemini",
  );
});

// ---------------------------------------------------------------------------
// Machine-level session retry pattern
// ---------------------------------------------------------------------------

test("CommandAuthError with resumeId triggers session retry", async () => {
  const calls = [];
  const mockAgent = {
    async execute(prompt, opts) {
      calls.push({ prompt, opts });
      if (calls.length === 1) {
        throw makeCommandAuthError(
          "Command aborted after stderr auth failure: No conversation found with session ID",
        );
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };

  // Simulate machine-level retry pattern (same as planning/implementation)
  const sessionId = "stale-session-uuid";
  let currentSessionId = sessionId;
  let res;

  try {
    res = await mockAgent.execute("do stuff", {
      resumeId: currentSessionId,
      timeoutMs: 60_000,
    });
  } catch (err) {
    if (err.name === "CommandAuthError" && currentSessionId) {
      currentSessionId = null;
      res = await mockAgent.execute("do stuff", { timeoutMs: 60_000 });
    } else {
      throw err;
    }
  }

  assert.equal(res.exitCode, 0);
  assert.equal(currentSessionId, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.resumeId, sessionId);
  assert.equal(calls[1].opts.resumeId, undefined);
});

test("CommandAuthError without resumeId is not caught as session failure", async () => {
  const mockAgent = {
    async execute() {
      throw makeCommandAuthError(
        "Command aborted after stderr auth failure: some other auth issue",
      );
    },
  };

  // Simulate machine-level retry pattern — no resumeId means rethrow
  const sessionOpts = { timeoutMs: 60_000 }; // no resumeId
  await assert.rejects(
    async () => {
      try {
        await mockAgent.execute("do stuff", sessionOpts);
      } catch (err) {
        if (err.name === "CommandAuthError" && sessionOpts.resumeId) {
          // Would retry — but resumeId is falsy so this branch is skipped
          return;
        }
        throw err;
      }
    },
    { name: "CommandAuthError" },
  );
});
