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

test("host sandbox strips CLAUDECODE from subprocess environment", async () => {
  const original = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "some_secret_value";
  try {
    const provider = new HostSandboxProvider();
    const sandbox = await provider.create();
    const result = await sandbox.commands.run("env", { timeoutMs: 5000 });
    assert.doesNotMatch(result.stdout, /CLAUDECODE=some_secret_value/);
  } finally {
    if (original === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = original;
  }
});
