import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadTestConfig,
  runTestCommand,
  waitForHealthCheck,
} from "../src/test-runner.js";

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

test("loadTestConfig: testConfigPath to unified coder.json accepts test.command object", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-loadtest-"));
  writeFileSync(
    path.join(dir, "coder.json"),
    JSON.stringify({
      test: {
        command: "bash scripts/test.sh",
        setup: [],
        teardown: [],
      },
    }),
    "utf8",
  );
  const cfg = loadTestConfig(dir, "coder.json");
  assert.equal(cfg?.test, "bash scripts/test.sh");
});

test("loadTestConfig: testConfigPath coder.json inherits workspace test when package has no coder.json", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-ws-merge-"));
  const pkg = path.join(ws, "packages", "a");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(ws, "coder.json"),
    JSON.stringify({
      test: {
        command: "bash scripts/test.sh",
        setup: [],
        teardown: [],
      },
    }),
    "utf8",
  );
  const cfg = loadTestConfig(pkg, "coder.json", ws);
  assert.equal(cfg?.test, "bash scripts/test.sh");
});

test("loadTestConfig: configs/coder.json loads file, not workspace merge", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-nested-cfg-"));
  const pkg = path.join(ws, "pkg");
  mkdirSync(path.join(pkg, "configs"), { recursive: true });
  writeFileSync(
    path.join(ws, "coder.json"),
    JSON.stringify({
      test: {
        command: "echo workspace",
        setup: [],
        teardown: [],
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(pkg, "configs", "coder.json"),
    JSON.stringify({
      test: {
        command: "echo nested",
        setup: [],
        teardown: [],
      },
    }),
    "utf8",
  );
  const cfg = loadTestConfig(pkg, "configs/coder.json", ws);
  assert.equal(cfg?.test, "echo nested");
});

test("loadTestConfig: testConfigPath coder.json merges scoped coder.json over workspace", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-ws-override-"));
  const pkg = path.join(ws, "packages", "b");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(ws, "coder.json"),
    JSON.stringify({
      test: {
        command: "bash scripts/ws.sh",
        setup: [],
        teardown: [],
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(pkg, "coder.json"),
    JSON.stringify({
      test: {
        command: "bash scripts/pkg.sh",
        setup: [],
        teardown: [],
      },
    }),
    "utf8",
  );
  const cfg = loadTestConfig(pkg, "coder.json", ws);
  assert.equal(cfg?.test, "bash scripts/pkg.sh");
});

test("loadTestConfig: standalone tc.json shape still works", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-standalone-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(dir, "scripts", "t.sh"),
    "#!/usr/bin/env bash\ntrue\n",
    "utf8",
  );
  writeFileSync(
    path.join(dir, "tc.json"),
    JSON.stringify({
      setup: [],
      test: "bash scripts/t.sh",
      teardown: [],
      timeoutMs: 5000,
    }),
    "utf8",
  );
  const cfg = loadTestConfig(dir, "tc.json");
  assert.equal(cfg?.test, "bash scripts/t.sh");
});
