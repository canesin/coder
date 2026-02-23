import assert from "node:assert/strict";
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
          killOnStderrPatterns: ["rejected stored OAuth token"],
        },
      ),
    /Command aborted after stderr auth failure/,
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
