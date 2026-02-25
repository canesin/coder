import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { runTestCommand, waitForHealthCheck } from "../src/test-runner.js";

test("waitForHealthCheck rejects non-local URLs by default", async () => {
  await assert.rejects(
    async () => waitForHealthCheck("https://example.com/health", 1, 1),
    /must target localhost by default/i,
  );
});

test("runTestCommand returns exitCode 1 for missing binary", () => {
  const res = runTestCommand(os.tmpdir(), ["non-existent-binary-xyz"]);
  assert.equal(res.exitCode, 1);
});

test("runTestCommand includes ENOENT in stderr for missing binary", () => {
  const res = runTestCommand(os.tmpdir(), ["non-existent-binary-xyz"]);
  assert.match(res.stderr, /ENOENT/);
});

test("runTestCommand returns exitCode 0 for successful command", () => {
  const res = runTestCommand(os.tmpdir(), ["node", "-e", "process.exit(0)"]);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stderr, "");
});

test("runTestCommand preserves specific exit codes", () => {
  const res = runTestCommand(os.tmpdir(), ["node", "-e", "process.exit(42)"]);
  assert.equal(res.exitCode, 42);
});
