import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CoderOrchestrator } from "../src/orchestrator.js";
import { loadState } from "../src/state.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-orch-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  run("git", ["init"], dir);
  return dir;
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `command failed: ${cmd} ${args.join(" ")}\n${res.stderr || res.stdout}`);
  return res;
}

function commitInitial(cwd) {
  run("git", ["config", "user.email", "test@example.com"], cwd);
  run("git", ["config", "user.name", "Test User"], cwd);
  writeFileSync(path.join(cwd, "README.md"), "hello\n", "utf8");
  run("git", ["add", "."], cwd);
  run("git", ["commit", "-m", "initial"], cwd);
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

class StubPlanOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
  }
  _getClaude() {
    return {};
  }
  async _executeAgentCommand(agentName, _agent, _cmd) {
    // Simulate Claude writing PLAN.md and creating untracked exploration artifacts.
    if (agentName === "claude") {
      writeFileSync(path.join(this.workspaceDir, "PLAN.md"), "# Plan\n", "utf8");
      writeFileSync(path.join(this.workspaceDir, "Cargo.toml"), "[package]\nname='x'\n", "utf8");
      mkdirSync(path.join(this.workspaceDir, "src"), { recursive: true });
      writeFileSync(path.join(this.workspaceDir, "src", "lib.rs"), "pub fn x() {}\n", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class StubAutoInfraOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
  }
  async listIssues() {
    return {
      issues: [
        { source: "github", id: "1", title: "Issue 1", repo_path: ".", difficulty: 1 },
        { source: "github", id: "2", title: "Issue 2", repo_path: ".", difficulty: 1 },
      ],
      recommended_index: 0,
      linearProjects: [],
    };
  }
  async _buildAutoQueue() {
    return [
      { source: "github", id: "1", title: "Issue 1", repoPath: ".", baseBranch: null, status: "pending", branch: null, prUrl: null, error: null, startedAt: null, completedAt: null, dependsOn: [] },
      { source: "github", id: "2", title: "Issue 2", repoPath: ".", baseBranch: null, status: "pending", branch: null, prUrl: null, error: null, startedAt: null, completedAt: null, dependsOn: [] },
    ];
  }
  _resetForNextIssue() {}
  async draftIssue() {
    const state = loadState(this.workspaceDir);
    state.repoPath = ".";
    state.branch = "coder/github-1";
    state.steps = { ...(state.steps || {}), wroteIssue: true, verifiedCleanRepo: true };
    writeFileSync(path.join(this.workspaceDir, "ISSUE.md"), "# Issue\n", "utf8");
    run("git", ["checkout", "-B", state.branch], this.workspaceDir);
    writeFileSync(path.join(this.workspaceDir, ".coder", "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
  }
  async createPlan() {
    const state = loadState(this.workspaceDir);
    state.steps = { ...(state.steps || {}), wrotePlan: true, wroteCritique: true };
    writeFileSync(path.join(this.workspaceDir, "PLAN.md"), "# Plan\n", "utf8");
    writeFileSync(path.join(this.workspaceDir, ".coder", "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
    return { planMd: "# Plan\n", critiqueMd: "" };
  }
  async implement() {
    const state = loadState(this.workspaceDir);
    state.steps = { ...(state.steps || {}), implemented: true };
    writeFileSync(path.join(this.workspaceDir, ".coder", "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
    return { summary: "ok" };
  }
  async reviewAndTest() {
    const err = new Error("Test infra missing");
    err.name = "TestInfrastructureError";
    throw err;
  }
  async finalize() {}
  async createPR() {}
}

test("_normalizeRepoPath keeps valid workspace-relative paths and rejects invalid ones", () => {
  const ws = makeWorkspace();
  mkdirSync(path.join(ws, "subrepo"), { recursive: true });
  run("git", ["init"], path.join(ws, "subrepo"));
  mkdirSync(path.join(ws, "subrepo", "src"), { recursive: true });
  writeFileSync(path.join(ws, "subrepo", "src", "file.js"), "console.log('x');\n", "utf8");
  const orch = new CoderOrchestrator(ws);

  assert.equal(orch._normalizeRepoPath("subrepo"), "subrepo");
  assert.equal(orch._normalizeRepoPath("subrepo/src/file.js"), "subrepo");
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
  run("git", ["init"], path.join(ws, "valid-subdir"));
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

test("_executeWithRetry enforces strict MCP startup checks and does not retry", async () => {
  const ws = makeWorkspace();
  writeFileSync(
    path.join(ws, ".coder", "mcp-health.json"),
    JSON.stringify({ gemini: { ready: "foo", failed: "bar" } }, null, 2) + "\n",
    "utf8",
  );

  const orch = new CoderOrchestrator(ws, { strictMcpStartup: true });
  let calls = 0;
  const fakeAgent = {
    async executeCommand() {
      calls += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };

  await assert.rejects(
    async () => orch._executeWithRetry(fakeAgent, "noop", { retries: 3, agentName: "gemini" }),
    /MCP startup failure for gemini/,
  );
  assert.equal(calls, 1);
});

test("_ensureGitignore writes .geminiignore unignore rules for workflow artifacts", () => {
  const ws = makeWorkspace();
  // Constructor calls _ensureGitignore.
  // eslint-disable-next-line no-new
  new CoderOrchestrator(ws);
  const content = readFileSync(path.join(ws, ".geminiignore"), "utf8");
  assert.match(content, /!ISSUE\.md/);
  assert.match(content, /!PLAN\.md/);
  assert.match(content, /!PLANREVIEW\.md/);
});

test("createPlan allows untracked exploration artifacts but cleans up newly-created ones", async () => {
  const ws = makeWorkspace();
  commitInitial(ws);
  const orch = new StubPlanOrchestrator(ws);
  writeFileSync(path.join(ws, "ISSUE.md"), "# Issue\n", "utf8");
  writeFileSync(
    path.join(ws, ".coder", "state.json"),
    JSON.stringify({
      repoPath: ".",
      branch: "coder/github-1",
      selected: { source: "github", id: "1", title: "Issue 1" },
      steps: { wroteIssue: true, wroteCritique: true },
    }, null, 2) + "\n",
    "utf8",
  );
  run("git", ["checkout", "-B", "coder/github-1"], ws);

  await orch.createPlan();

  assert.equal(readFileSync(path.join(ws, "PLAN.md"), "utf8").includes("# Plan"), true);
  assert.equal(existsSync(path.join(ws, "Cargo.toml")), false);
  assert.equal(existsSync(path.join(ws, "src")), false);
});

test("runAuto aborts and skips remaining issues on TestInfrastructureError to avoid cascades", async () => {
  const ws = makeWorkspace();
  commitInitial(ws);
  const orch = new StubAutoInfraOrchestrator(ws);
  const res = await orch.runAuto({ destructiveReset: false });
  assert.equal(res.failed, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.status, "failed");
});
