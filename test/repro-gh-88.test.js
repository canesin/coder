import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostSandboxProvider } from "../src/host-sandbox.js";
import { closeAllLoggers, logsDir, makeJsonlLogger } from "../src/logging.js";
import {
  loadWorkflowSnapshot,
  saveWorkflowTerminalState,
} from "../src/state/workflow-state.js";

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-gh88-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

// --- saveWorkflowTerminalState guardRunId ---

test("GH-88: saveWorkflowTerminalState with guardRunId skips write when runId differs", () => {
  const ws = makeTmpDir();
  try {
    saveWorkflowTerminalState(ws, {
      runId: "run-B",
      workflow: "develop",
      state: "running",
      context: { runId: "run-B" },
    });

    const result = saveWorkflowTerminalState(ws, {
      runId: "run-A",
      workflow: "develop",
      state: "completed",
      context: { runId: "run-A" },
      guardRunId: "run-A",
    });

    assert.equal(result, null, "stale write should be blocked");
    const loaded = loadWorkflowSnapshot(ws);
    assert.equal(loaded.runId, "run-B", "file should still belong to run-B");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("GH-88: saveWorkflowTerminalState with guardRunId allows write when runId matches", () => {
  const ws = makeTmpDir();
  try {
    saveWorkflowTerminalState(ws, {
      runId: "run-A",
      workflow: "develop",
      state: "running",
      context: { runId: "run-A" },
    });

    const result = saveWorkflowTerminalState(ws, {
      runId: "run-A",
      workflow: "develop",
      state: "completed",
      context: { runId: "run-A" },
      guardRunId: "run-A",
    });

    assert.ok(result, "write should succeed");
    const loaded = loadWorkflowSnapshot(ws);
    assert.equal(loaded.value, "completed");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("GH-88: saveWorkflowTerminalState without guardRunId always writes", () => {
  const ws = makeTmpDir();
  try {
    saveWorkflowTerminalState(ws, {
      runId: "run-B",
      workflow: "develop",
      state: "running",
      context: { runId: "run-B" },
    });

    const result = saveWorkflowTerminalState(ws, {
      runId: "run-A",
      workflow: "develop",
      state: "completed",
      context: { runId: "run-A" },
    });

    assert.ok(result, "write should succeed without guard");
    const loaded = loadWorkflowSnapshot(ws);
    assert.equal(loaded.runId, "run-A");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- makeJsonlLogger runId injection ---

test("GH-88: makeJsonlLogger injects runId into every event", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-gh88-log-"));
  try {
    const logger = makeJsonlLogger(ws, "test-workflow", { runId: "test-run" });
    logger({ event: "step_started", stage: "planning" });
    await closeAllLoggers();

    const content = readFileSync(
      path.join(logsDir(ws), "test-workflow.jsonl"),
      "utf8",
    );
    const entry = JSON.parse(content.trim());
    assert.equal(entry.runId, "test-run");
    assert.equal(entry.event, "step_started");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("GH-88: makeJsonlLogger omits runId when not provided", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-gh88-log-"));
  try {
    const logger = makeJsonlLogger(ws, "test-norun");
    logger({ event: "standalone" });
    await closeAllLoggers();

    const content = readFileSync(
      path.join(logsDir(ws), "test-norun.jsonl"),
      "utf8",
    );
    const entry = JSON.parse(content.trim());
    assert.equal(entry.runId, undefined, "runId should not be present");
    assert.equal(entry.event, "standalone");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- HostSandboxInstance.kill() ---

test("GH-88: kill() resolves promptly for already-exited child", async () => {
  const provider = new HostSandboxProvider({ useSystemdRun: false });
  const sandbox = await provider.create();

  await sandbox.commands.run("true", { timeoutMs: 5000 });

  const start = Date.now();
  await sandbox.kill();
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `kill() took ${elapsed}ms, expected < 2000ms`);
});

test("GH-88: kill() terminates a running child", async () => {
  const provider = new HostSandboxProvider({ useSystemdRun: false });
  const sandbox = await provider.create();

  // Start a long-running command but don't await it — kick off in background
  const runPromise = sandbox.commands.run("sleep 60", { timeoutMs: 30000 });

  // Give it time to spawn
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sandbox.currentChild, "child should be running");

  await sandbox.kill();
  assert.equal(sandbox.currentChild, null, "currentChild should be null");

  // The run promise should also settle (with a non-zero exit or error)
  const result = await runPromise;
  assert.ok(result.exitCode !== undefined || result.stderr !== undefined);
});

test("GH-88: kill() signals process group when leader exited but descendants hold stdio", async () => {
  const provider = new HostSandboxProvider({ useSystemdRun: false });
  const sandbox = await provider.create();

  // Leader exits, but bg child inherits stdio (keeps _run pending via close).
  // This means currentChild is still set but child.exitCode !== null.
  const pidFile = path.join(os.tmpdir(), `gh88-bgpid-${Date.now()}`);
  const runPromise = sandbox.commands.run(
    `bash -c 'sleep 60 & echo $! > ${pidFile}; exit 0'`,
    { timeoutMs: 30000 },
  );

  // Wait for leader to exit and write pidFile
  await new Promise((r) => setTimeout(r, 500));

  let bgPid;
  try {
    bgPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    return;
  }

  // currentChild should still be set (close hasn't fired due to bg child stdio)
  assert.ok(sandbox.currentChild, "currentChild should still be set");

  await sandbox.kill();

  // The run promise should settle now
  await runPromise;

  await new Promise((r) => setTimeout(r, 600));

  let alive = false;
  try {
    process.kill(bgPid, 0);
    alive = true;
  } catch {}
  assert.equal(alive, false, `background PID ${bgPid} should be dead`);

  try {
    rmSync(pidFile);
  } catch {}
});
