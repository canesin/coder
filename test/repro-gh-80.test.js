import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadWorkflowSnapshot,
  saveWorkflowSnapshot,
  saveWorkflowTerminalState,
  workflowStatePathFor,
} from "../src/state/workflow-state.js";

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-repro-80-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

test("saveWorkflowSnapshot throws descriptive error on write failure", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-repro-80-"));
  const stateDir = path.join(ws, ".coder");
  mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "workflow-state.json");

  // Force a failure by making the target path a directory
  mkdirSync(statePath);

  try {
    assert.throws(
      () => {
        saveWorkflowSnapshot(ws, {
          runId: "test-run",
          snapshot: { value: "running", context: {} },
        });
      },
      (err) => {
        return (
          err.message.includes("Failed to write state") &&
          err.message.includes("workflow-state.json")
        );
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("saveWorkflowTerminalState guardRunId prevents stale overwrite", () => {
  const ws = makeTmpDir();
  // Seed with run-A
  saveWorkflowTerminalState(ws, {
    runId: "run-A",
    state: "completed",
    context: {},
  });

  // Attempt overwrite with mismatched guardRunId
  const result = saveWorkflowTerminalState(ws, {
    runId: "run-B",
    state: "failed",
    context: {},
    guardRunId: "run-B",
  });

  assert.equal(result, null);
  const ondisk = JSON.parse(readFileSync(workflowStatePathFor(ws), "utf8"));
  assert.equal(ondisk.runId, "run-A");
  rmSync(ws, { recursive: true, force: true });
});

test("saveWorkflowTerminalState guardRunId allows matching write", () => {
  const ws = makeTmpDir();
  saveWorkflowTerminalState(ws, {
    runId: "run-A",
    state: "running",
    context: {},
  });

  const result = saveWorkflowTerminalState(ws, {
    runId: "run-A",
    state: "completed",
    context: {},
    guardRunId: "run-A",
  });

  assert.notEqual(result, null);
  const ondisk = JSON.parse(readFileSync(workflowStatePathFor(ws), "utf8"));
  assert.equal(ondisk.value, "completed");
  rmSync(ws, { recursive: true, force: true });
});

test("loadWorkflowSnapshot logs warning on corrupt JSON", () => {
  const ws = makeTmpDir();
  writeFileSync(workflowStatePathFor(ws), "NOT-JSON{{{", "utf8");

  const orig = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args.join(" "));
  try {
    const result = loadWorkflowSnapshot(ws);
    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("workflow-state.json"));
  } finally {
    console.error = orig;
    rmSync(ws, { recursive: true, force: true });
  }
});
