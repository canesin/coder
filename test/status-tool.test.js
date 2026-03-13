import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// getStatus is now exported
import { getStatus } from "../src/mcp/tools/status.js";
import { saveLoopState } from "../src/state/workflow-state.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "status-tool-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "scratchpad"), { recursive: true });
  return tmp;
}

test("getStatus is exported as a function", () => {
  assert.equal(typeof getStatus, "function");
});

test("getStatus returns loop state fields when loop state exists", async () => {
  const ws = makeTmpWorkspace();
  try {
    await saveLoopState(ws, {
      runId: "test-run-123",
      status: "running",
      currentStage: "implementation",
      lastHeartbeatAt: "2025-01-01T00:00:00.000Z",
      activeAgent: "implementer",
      issueQueue: [],
    });

    const status = await getStatus(ws);
    assert.equal(status.loopRunId, "test-run-123");
    assert.equal(status.loopStatus, "running");
    assert.equal(status.currentStage, "implementation");
    assert.equal(status.lastHeartbeatAt, "2025-01-01T00:00:00.000Z");
    assert.equal(status.activeAgent, "implementer");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("getStatus returns nulls when no loop state exists", async () => {
  const ws = makeTmpWorkspace();
  try {
    const status = await getStatus(ws);
    assert.equal(status.loopRunId, null);
    assert.equal(status.loopStatus, null);
    assert.equal(status.currentStage, null);
    assert.equal(status.lastHeartbeatAt, null);
    assert.equal(status.activeAgent, null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
