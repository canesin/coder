import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CoderOrchestrator } from "../src/orchestrator.js";
import { loadLoopState } from "../src/state.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-auto-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

function seedLoopState(workspaceDir, state) {
  writeFileSync(
    path.join(workspaceDir, ".coder", "loop-state.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

function loopEntry({
  source = "github",
  id,
  title = `Issue ${id}`,
  repoPath = "",
  status = "pending",
  dependsOn = [],
}) {
  return {
    source,
    id: String(id),
    title,
    repoPath,
    status,
    branch: null,
    prUrl: null,
    error: null,
    startedAt: null,
    completedAt: null,
    dependsOn,
  };
}

class FakeAutoOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
    this.calls = [];
    this.mockIssues = [];
    this.mockQueue = [];
  }

  async listIssues() {
    this.calls.push("listIssues");
    return { issues: this.mockIssues, recommended_index: 0 };
  }

  async _buildAutoQueue() {
    this.calls.push("buildQueue");
    return this.mockQueue;
  }

  async draftIssue({ issue, repoPath, baseBranch }) {
    this.calls.push(`draft:${issue.source}#${issue.id}`);
    this.calls.push(`draftBase:${baseBranch || ""}`);
    const state = this._loadState();
    state.selected = issue;
    state.repoPath = repoPath || null;
    state.baseBranch = baseBranch || null;
    state.branch = `coder/${issue.source}-${issue.id}`;
    state.steps = { ...(state.steps || {}), wroteIssue: true };
    this._saveState(state);
  }

  async createPlan() {
    this.calls.push("createPlan");
  }

  async implement() {
    this.calls.push("implement");
  }

  async reviewAndTest() {
    this.calls.push("reviewAndTest");
  }

  async finalize() {
    this.calls.push("finalize");
  }

  async createPR({ base } = {}) {
    this.calls.push("createPR");
    this.calls.push(`createPRBase:${base || ""}`);
    const state = this._loadState();
    const prUrl = `https://example.test/pr/${encodeURIComponent(state.branch || "unknown")}`;
    state.prUrl = prUrl;
    this._saveState(state);
    return { prUrl, branch: state.branch || "unknown", base: state.baseBranch || null };
  }

  _resetForNextIssue(repoPath, { destructive = false } = {}) {
    this.calls.push(`reset:${repoPath || "."}:${destructive ? "destructive" : "safe"}`);
  }
}

test("runAuto resume: skips already completed items and advances checkpoint", async () => {
  const ws = makeWorkspace();
  seedLoopState(ws, {
    version: 1,
    goal: "resume",
    status: "running",
    projectFilter: null,
    maxIssues: null,
    issueQueue: [
      { ...loopEntry({ source: "github", id: "1", status: "completed" }), completedAt: new Date().toISOString() },
      loopEntry({ source: "github", id: "2", status: "pending" }),
    ],
    currentIndex: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  const orch = new FakeAutoOrchestrator(ws);
  const result = await orch.runAuto();

  assert.equal(orch.calls.includes("draft:github#1"), false);
  assert.equal(orch.calls.includes("draft:github#2"), true);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  const persisted = loadLoopState(ws);
  assert.equal(persisted.currentIndex, 2);
  assert.equal(persisted.issueQueue[0].status, "completed");
  assert.equal(persisted.issueQueue[1].status, "completed");
});

test("runAuto dependency handling: source-qualified refs prevent cross-source collisions", async () => {
  const ws = makeWorkspace();
  seedLoopState(ws, {
    version: 1,
    goal: "deps",
    status: "running",
    projectFilter: null,
    maxIssues: null,
    issueQueue: [
      { ...loopEntry({ source: "github", id: "123", status: "failed" }), error: "failed upstream" },
      loopEntry({ source: "linear", id: "123", status: "pending", dependsOn: ["github#123"] }),
    ],
    currentIndex: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  const orch = new FakeAutoOrchestrator(ws);
  const result = await orch.runAuto();

  assert.equal(orch.calls.some((c) => c.startsWith("draft:linear#123")), false);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);

  const persisted = loadLoopState(ws);
  assert.equal(persisted.issueQueue[1].status, "skipped");
  assert.match(persisted.issueQueue[1].error || "", /depends on failed issue/);
});

test("runAuto stacked mode: dependent issue is drafted on dependency branch", async () => {
  const ws = makeWorkspace();
  seedLoopState(ws, {
    version: 1,
    goal: "stacked",
    status: "running",
    projectFilter: null,
    maxIssues: null,
    issueQueue: [
      {
        ...loopEntry({ source: "github", id: "1", status: "completed" }),
        branch: "coder/github-1",
        completedAt: new Date().toISOString(),
      },
      loopEntry({ source: "github", id: "2", status: "pending", dependsOn: ["github#1"] }),
    ],
    currentIndex: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  const orch = new FakeAutoOrchestrator(ws);
  const result = await orch.runAuto();

  assert.equal(result.completed, 2);
  assert.equal(orch.calls.includes("draft:github#2"), true);
  assert.equal(orch.calls.includes("draftBase:coder/github-1"), true);
  assert.equal(orch.calls.includes("createPRBase:coder/github-1"), true);

  const persisted = loadLoopState(ws);
  assert.equal(persisted.issueQueue[1].status, "completed");
  assert.equal(persisted.issueQueue[1].baseBranch, "coder/github-1");
});

test("runAuto empty queue: finishes as completed (not failed)", async () => {
  const ws = makeWorkspace();
  const orch = new FakeAutoOrchestrator(ws);
  orch.mockIssues = [];
  orch.mockQueue = [];

  const result = await orch.runAuto({ goal: "nothing to do" });
  assert.equal(result.status, "completed");
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  const persisted = loadLoopState(ws);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.issueQueue.length, 0);
});

test("runAuto validates maxIssues >= 1", async () => {
  const ws = makeWorkspace();
  const orch = new FakeAutoOrchestrator(ws);
  await assert.rejects(async () => orch.runAuto({ maxIssues: 0 }), /maxIssues must be an integer >= 1/);
});

test("runAuto cancel request marks run as cancelled (not completed)", async () => {
  const ws = makeWorkspace();
  seedLoopState(ws, {
    version: 1,
    goal: "cancel",
    status: "running",
    projectFilter: null,
    maxIssues: null,
    issueQueue: [
      loopEntry({ source: "github", id: "1", status: "pending" }),
      loopEntry({ source: "github", id: "2", status: "pending" }),
    ],
    currentIndex: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  });

  const orch = new FakeAutoOrchestrator(ws);
  orch.requestCancel();
  const result = await orch.runAuto();

  assert.equal(result.status, "cancelled");
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  const persisted = loadLoopState(ws);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.issueQueue[0].status, "pending");
  assert.equal(persisted.issueQueue[1].status, "pending");
});
