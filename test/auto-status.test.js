import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerAutoStatusTools } from "../src/mcp/tools/auto-status.js";
import { saveLoopState } from "../src/state.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-auto-status-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

function makeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _spec, handler) {
      handlers.set(name, handler);
    },
  };
}

test("coder_auto_status reports stale when heartbeat is old for running loop", async () => {
  const ws = makeWorkspace();
  const server = makeServer();
  const staleTs = new Date(Date.now() - 120_000).toISOString();
  saveLoopState(ws, {
    version: 1,
    runId: "run1",
    goal: "x",
    status: "running",
    issueQueue: [],
    currentIndex: 0,
    currentStage: "listing_issues",
    currentStageStartedAt: staleTs,
    lastHeartbeatAt: staleTs,
    runnerPid: 999999,
    activeAgent: "gemini",
    startedAt: staleTs,
    completedAt: null,
  });

  registerAutoStatusTools(server, ws);
  const status = server.handlers.get("coder_auto_status");
  const res = await status({ workspace: ws });
  const parsed = JSON.parse(res.content[0].text);

  assert.equal(parsed.runStatus, "stale");
  assert.equal(parsed.rawRunStatus, "running");
  assert.equal(parsed.isStale, true);
  assert.ok(parsed.staleReason);
});

