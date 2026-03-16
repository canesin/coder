import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorkflowStatus } from "../src/mcp/tools/workflows.js";
import { saveLoopState } from "../src/state/workflow-state.js";

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-wf-status-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

test("develop_starting: status suppresses stale failed and skipped entries", async () => {
  const ws = makeTmpDir();
  try {
    await saveLoopState(ws, {
      version: 1,
      runId: "test-run",
      status: "running",
      goal: "test",
      currentStage: "develop_starting",
      currentStageStartedAt: new Date().toISOString(),
      activeAgent: "gemini",
      lastHeartbeatAt: new Date().toISOString(),
      issueQueue: [
        { id: "A", title: "Issue A", status: "completed", source: "github" },
        {
          id: "B",
          title: "Issue B",
          status: "failed",
          error: "quota",
          source: "github",
        },
        { id: "C", title: "Issue C", status: "skipped", source: "github" },
        { id: "D", title: "Issue D", status: "pending", source: "github" },
      ],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
    });

    const status = await readWorkflowStatus(ws);

    assert.equal(status.currentStage, "develop_starting");
    assert.equal(
      status.issueQueue.length,
      2,
      "failed and skipped must be filtered out",
    );
    const ids = status.issueQueue.map((e) => e.id);
    assert.ok(ids.includes("A"), "completed must remain");
    assert.ok(ids.includes("D"), "pending must remain");
    assert.ok(!ids.includes("B"), "failed must be suppressed");
    assert.ok(!ids.includes("C"), "skipped must be suppressed");

    assert.equal(status.counts.failed, 0);
    assert.equal(status.counts.skipped, 0);
    assert.equal(status.counts.completed, 1);
    assert.equal(status.counts.pending, 1);
    assert.equal(status.counts.total, 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("research_starting: status shows all entries (suppression scoped to develop only)", async () => {
  const ws = makeTmpDir();
  try {
    await saveLoopState(ws, {
      version: 1,
      runId: "test-run",
      status: "running",
      goal: "test",
      currentStage: "research_starting",
      currentStageStartedAt: new Date().toISOString(),
      activeAgent: "gemini",
      lastHeartbeatAt: new Date().toISOString(),
      issueQueue: [
        { id: "A", title: "Issue A", status: "completed", source: "github" },
        {
          id: "B",
          title: "Issue B",
          status: "failed",
          error: "quota",
          source: "github",
        },
      ],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
    });

    const status = await readWorkflowStatus(ws);

    assert.equal(status.currentStage, "research_starting");
    assert.equal(
      status.issueQueue.length,
      2,
      "other workflows: no suppression",
    );
    assert.equal(status.counts.failed, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("non-starting stage: status shows all entries including failed and skipped", async () => {
  const ws = makeTmpDir();
  try {
    await saveLoopState(ws, {
      version: 1,
      runId: "test-run",
      status: "running",
      goal: "test",
      currentStage: "processing",
      currentStageStartedAt: new Date().toISOString(),
      activeAgent: "gemini",
      lastHeartbeatAt: new Date().toISOString(),
      issueQueue: [
        { id: "A", title: "Issue A", status: "completed", source: "github" },
        {
          id: "B",
          title: "Issue B",
          status: "failed",
          error: "quota",
          source: "github",
        },
        { id: "C", title: "Issue C", status: "skipped", source: "github" },
      ],
      currentIndex: 0,
      startedAt: new Date().toISOString(),
    });

    const status = await readWorkflowStatus(ws);

    assert.equal(status.currentStage, "processing");
    assert.equal(status.issueQueue.length, 3);
    assert.equal(status.counts.failed, 1);
    assert.equal(status.counts.skipped, 1);
    assert.equal(status.counts.completed, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
