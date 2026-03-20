import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveDevelopArtifactPhase,
  getStatus,
} from "../src/mcp/tools/status.js";

function makeWorkspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-status-test-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(ws, ".coder", "scratchpad"), { recursive: true });
  return ws;
}

test("getStatus returns null run state when no workflow/loop state files exist", async () => {
  const ws = makeWorkspace();
  try {
    const status = await getStatus(ws);
    assert.equal(status.currentStage, null);
    assert.equal(status.lastHeartbeatAt, null);
    assert.equal(status.activeAgent, null);
    assert.equal(status.runId, null);
    assert.equal(status.runStatus, null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("getStatus merges currentStage etc from loop-state when develop is running", async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      path.join(ws, ".coder", "loop-state.json"),
      JSON.stringify({
        runId: "test-run-1",
        status: "running",
        currentStage: "develop.planning",
        currentStageStartedAt: "2025-01-01T12:00:00.000Z",
        lastHeartbeatAt: "2025-01-01T12:01:00.000Z",
        activeAgent: "gemini",
      }),
      "utf8",
    );

    const status = await getStatus(ws);
    assert.equal(status.currentStage, "develop.planning");
    assert.equal(status.currentStageStartedAt, "2025-01-01T12:00:00.000Z");
    assert.equal(status.lastHeartbeatAt, "2025-01-01T12:01:00.000Z");
    assert.equal(status.activeAgent, "gemini");
    assert.equal(status.runId, "test-run-1");
    assert.equal(status.runStatus, "running");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("getStatus includes derivedArtifactPhase when develop run is active", async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      path.join(ws, ".coder", "loop-state.json"),
      JSON.stringify({
        runId: "run-d",
        status: "running",
        currentStage: "develop_starting",
        lastHeartbeatAt: "2025-01-01T12:00:00.000Z",
        activeAgent: "gemini",
      }),
      "utf8",
    );
    writeFileSync(
      path.join(ws, ".coder", "state.json"),
      JSON.stringify({
        steps: { wroteIssue: true, wrotePlan: true },
      }),
      "utf8",
    );
    writeFileSync(path.join(ws, ".coder", "artifacts", "ISSUE.md"), "# i\n");
    writeFileSync(path.join(ws, ".coder", "artifacts", "PLAN.md"), "# p\n");

    const status = await getStatus(ws);
    assert.equal(status.runStatus, "running");
    assert.equal(status.derivedArtifactPhase, "plan_review");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deriveDevelopArtifactPhase returns null when no develop artifacts touched", () => {
  assert.equal(
    deriveDevelopArtifactPhase(
      { steps: {} },
      {
        issueExists: false,
        planExists: false,
        critiqueExists: false,
      },
    ),
    null,
  );
});

test("getStatus merges from workflow-state when loop state is idle", async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      path.join(ws, ".coder", "workflow-state.json"),
      JSON.stringify({
        version: 2,
        workflow: "research",
        runId: "research-abc",
        value: "running",
        context: {
          currentStage: "research.deep_research",
          lastHeartbeatAt: "2025-01-01T12:00:00.000Z",
          activeAgent: "gemini",
        },
        updatedAt: "2025-01-01T12:00:00.000Z",
      }),
      "utf8",
    );

    const status = await getStatus(ws);
    assert.equal(status.currentStage, "research.deep_research");
    assert.equal(status.lastHeartbeatAt, "2025-01-01T12:00:00.000Z");
    assert.equal(status.activeAgent, "gemini");
    assert.equal(status.runId, "research-abc");
    assert.equal(status.runStatus, "running");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("getStatus omits derivedArtifactPhase when a non-develop workflow is running", async () => {
  const ws = makeWorkspace();
  try {
    writeFileSync(
      path.join(ws, ".coder", "workflow-state.json"),
      JSON.stringify({
        version: 2,
        workflow: "research",
        runId: "research-abc",
        value: "running",
        context: {
          currentStage: "research.deep_research",
          lastHeartbeatAt: "2025-01-01T12:00:00.000Z",
          activeAgent: "gemini",
        },
        updatedAt: "2025-01-01T12:00:00.000Z",
      }),
      "utf8",
    );
    writeFileSync(
      path.join(ws, ".coder", "state.json"),
      JSON.stringify({
        steps: { wroteIssue: true, wrotePlan: true },
      }),
      "utf8",
    );
    writeFileSync(path.join(ws, ".coder", "artifacts", "ISSUE.md"), "# i\n");
    writeFileSync(path.join(ws, ".coder", "artifacts", "PLAN.md"), "# p\n");

    const status = await getStatus(ws);
    assert.equal(status.runStatus, "running");
    assert.equal(status.derivedArtifactPhase, null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
