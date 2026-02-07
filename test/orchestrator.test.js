import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CoderOrchestrator } from "../src/orchestrator.js";
import { loadState } from "../src/state.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-orch-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

class StubOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
    this._responses = [];
    this.secrets = { ...this.secrets, LINEAR_API_KEY: "linear-token" };
  }

  queueResponse(res) {
    this._responses.push(res);
  }

  _getGemini() {
    return {};
  }

  async _executeWithRetry() {
    const next = this._responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

test("_normalizeRepoPath keeps valid workspace-relative paths and rejects invalid ones", () => {
  const ws = makeWorkspace();
  mkdirSync(path.join(ws, "subrepo"), { recursive: true });
  const orch = new CoderOrchestrator(ws);

  assert.equal(orch._normalizeRepoPath("subrepo"), "subrepo");
  assert.equal(orch._normalizeRepoPath("."), ".");
  assert.equal(orch._normalizeRepoPath("../escape"), ".");
  assert.equal(orch._normalizeRepoPath("/tmp"), ".");
  assert.equal(orch._normalizeRepoPath("does-not-exist"), ".");
});

test("listIssues continues when optional Linear project listing fails", async () => {
  const ws = makeWorkspace();
  const orch = new StubOrchestrator(ws);

  orch.queueResponse(new Error("linear auth failed"));
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({ issues: [], recommended_index: 0 }),
  });

  const result = await orch.listIssues();
  assert.deepEqual(result, { issues: [], recommended_index: 0, linearProjects: [] });

  const state = loadState(ws);
  assert.equal(state.steps.listedProjects, true);
  assert.equal(state.steps.listedIssues, true);
});

test("_buildAutoQueue normalizes invalid repo_path from Gemini output", async () => {
  const ws = makeWorkspace();
  mkdirSync(path.join(ws, "valid-subdir"), { recursive: true });
  const orch = new StubOrchestrator(ws);

  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      queue: [
        {
          source: "github",
          id: "1",
          title: "Issue 1",
          repo_path: "fcc/OpenPVT",
          depends_on: [],
          reason: "invalid path",
        },
        {
          source: "github",
          id: "2",
          title: "Issue 2",
          repo_path: "valid-subdir",
          depends_on: [],
          reason: "valid path",
        },
      ],
      excluded: [],
    }),
  });

  const queue = await orch._buildAutoQueue(
    [
      { source: "github", id: "1", title: "Issue 1", repo_path: ".", difficulty: 1 },
      { source: "github", id: "2", title: "Issue 2", repo_path: ".", difficulty: 1 },
    ],
    "resolve all",
  );

  assert.equal(queue[0].repoPath, ".");
  assert.equal(queue[1].repoPath, "valid-subdir");
});
