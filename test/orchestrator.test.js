import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
