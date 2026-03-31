import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostSandboxProvider } from "../src/host-sandbox.js";

test("host sandbox aborts command on configured stderr auth-failure pattern", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `echo "MCP server 'linear' rejected stored OAuth token" 1>&2; sleep 2; echo "should-not-print"`,
        {
          timeoutMs: 5000,
          killOnStderrPatterns: [
            { pattern: "rejected stored OAuth token", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStderrError");
      assert.equal(err.category, "auth");
      assert.equal(err.pattern, "rejected stored OAuth token");
      return true;
    },
  );
});

test("host sandbox aborts on Codex session-not-found pattern (auth category)", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `echo "session not found" 1>&2; sleep 2; echo "should-not-print"`,
        {
          timeoutMs: 5000,
          killOnStderrPatterns: [
            { pattern: "session not found", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStderrError");
      assert.equal(err.category, "auth");
      assert.equal(err.pattern, "session not found");
      return true;
    },
  );
});

test("host sandbox aborts command on configured stdout auth-failure pattern (session already in use)", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `echo "Error: Session ID 57ce9ef7-f502-451c-a258-535c8b62ccf5 is already in use."; sleep 2; echo "should-not-print"`,
        {
          timeoutMs: 5000,
          killOnStdoutPatterns: [
            { pattern: "already in use", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStdoutError");
      assert.equal(err.category, "auth");
      assert.equal(err.pattern, "already in use");
      return true;
    },
  );
});

test("host sandbox aborts when pattern is split across stdout chunks", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  // Simulate error split across chunks: "Error: Session " + "ID X is already in use"
  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `printf 'Error: Session '; printf 'ID 123 is already in use.'; sleep 2`,
        {
          timeoutMs: 5000,
          killOnStdoutPatterns: [
            { pattern: "already in use", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStdoutError");
      assert.equal(err.category, "auth");
      return true;
    },
  );
});

test("host sandbox fatal pattern: child ignoring SIGTERM still yields CommandFatalError not timeout", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `trap '' TERM; echo "Session ID abc is already in use"; sleep 5`,
        {
          timeoutMs: 10000,
          killOnStdoutPatterns: [
            { pattern: "already in use", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStdoutError");
      assert.equal(err.category, "auth");
      assert.equal(err.pattern, "already in use");
      return true;
    },
  );
});

test("host sandbox fatal pattern + hang timeout: yields CommandFatalError not hang timeout", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `trap '' TERM; echo "Session ID x is already in use"; sleep 5`,
        {
          timeoutMs: 10000,
          hangTimeoutMs: 1000,
          killOnStdoutPatterns: [
            { pattern: "already in use", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStdoutError");
      assert.equal(err.category, "auth");
      assert.equal(err.pattern, "already in use");
      return true;
    },
  );
});

test("host sandbox aborts with transient category on matching stderr pattern", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `echo "fetch failed sending request" 1>&2; sleep 2; echo "should-not-print"`,
        {
          timeoutMs: 5000,
          killOnStderrPatterns: [
            { pattern: "fetch failed sending request", category: "transient" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStderrError");
      assert.equal(err.category, "transient");
      assert.equal(err.pattern, "fetch failed sending request");
      return true;
    },
  );
});

test("host sandbox fatal pattern: child ignoring SIGTERM still yields CommandFatalError not timeout", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `trap '' TERM; echo "Session ID abc is already in use"; sleep 5`,
        {
          timeoutMs: 10000,
          killOnStdoutPatterns: [
            { pattern: "already in use", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStdoutError");
      assert.equal(err.category, "auth");
      assert.equal(err.pattern, "already in use");
      return true;
    },
  );
});

test("host sandbox fatal pattern + hang timeout: yields CommandFatalError not hang timeout", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `trap '' TERM; echo "Session ID x is already in use"; sleep 5`,
        {
          timeoutMs: 10000,
          hangTimeoutMs: 1000,
          killOnStdoutPatterns: [
            { pattern: "already in use", category: "auth" },
          ],
        },
      ),
    (err) => {
      assert.equal(err.name, "CommandFatalStdoutError");
      assert.equal(err.category, "auth");
      return true;
    },
  );
});

test("host sandbox hang timeout ignores stderr chatter when hangResetOnStderr is false", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(
        `for i in $(seq 1 10); do echo "tick $i" 1>&2; sleep 0.2; done`,
        { timeoutMs: 5000, hangTimeoutMs: 100, hangResetOnStderr: false },
      ),
    /Command timeout after 100ms/,
  );
});

test("host sandbox timeout: child ignoring SIGTERM escalates to SIGKILL and settles quickly (not 15s force-settle)", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  const started = Date.now();
  await assert.rejects(
    async () =>
      sandbox.commands.run(`trap '' TERM; sleep 30`, {
        timeoutMs: 200,
      }),
    (err) => {
      assert.equal(err.name, "CommandTimeoutError");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 10_000,
    `expected SIGKILL escalation path to settle in well under 15s force-settle, got ${elapsed}ms`,
  );
  assert.ok(
    elapsed >= 150,
    `expected at least timeoutMs + overhead before rejection, got ${elapsed}ms`,
  );
});

test("host sandbox throwOnNonZero includes exit metadata", async () => {
  const provider = new HostSandboxProvider();
  const sandbox = await provider.create();

  await assert.rejects(
    async () =>
      sandbox.commands.run(`echo "out"; echo "err" 1>&2; exit 3`, {
        throwOnNonZero: true,
      }),
    (err) => {
      assert.equal(err.exitCode, 3);
      assert.match(err.stdout, /out/);
      assert.match(err.stderr, /err/);
      return true;
    },
  );
});

test("host sandbox does not inherit sensitive env vars from process.env", async () => {
  const sensitiveKey = "TEST_SENSITIVE_VAR_DO_NOT_INHERIT";
  const originalValue = process.env[sensitiveKey];
  process.env[sensitiveKey] = "secret_value";
  try {
    const provider = new HostSandboxProvider();
    const sandbox = await provider.create();
    const result = await sandbox.commands.run(`printenv || true`, {
      timeoutMs: 5000,
    });
    assert.ok(
      !result.stdout.includes("secret_value"),
      "Sensitive env var must not appear in subprocess output",
    );
    assert.ok(
      !result.stdout.includes(sensitiveKey),
      "Sensitive env var key must not appear in subprocess output",
    );
  } finally {
    if (originalValue === undefined) {
      delete process.env[sensitiveKey];
    } else {
      process.env[sensitiveKey] = originalValue;
    }
  }
});

test("host sandbox strips CLAUDECODE and CLAUDE_CODE_ENTRYPOINT from final env", async () => {
  const provider = new HostSandboxProvider({
    baseEnv: {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "nested",
    },
  });
  const sandbox = await provider.create({
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "nested",
  });
  const result = await sandbox.commands.run(`printenv || true`, {
    timeoutMs: 5000,
  });
  assert.ok(!/CLAUDECODE=/.test(result.stdout));
  assert.ok(!/CLAUDE_CODE_ENTRYPOINT=/.test(result.stdout));
});

test("agent subprocess does not source ~/.profile (profile routing does not override sandbox env)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "coder-agent-noprofile-"));
  writeFileSync(
    path.join(home, ".profile"),
    'export ANTHROPIC_BASE_URL="https://openrouter.example/api"\n',
  );
  const provider = new HostSandboxProvider({
    baseEnv: {
      HOME: home,
      PATH: process.env.PATH || "/usr/bin:/bin",
    },
  });
  const sandbox = await provider.create();
  const result = await sandbox.commands.run(
    `printf '%s' "\${ANTHROPIC_BASE_URL:-}"`,
    { timeoutMs: 5000 },
  );
  assert.equal(
    result.stdout,
    "",
    "models.claude / sandbox env must win; ~/.profile must not inject ANTHROPIC_BASE_URL (regression: bash -lc)",
  );
});
