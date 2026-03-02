import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLoopState } from "../src/state/workflow-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import { runDevelopLoop } from "../src/workflows/develop.workflow.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stop-loop-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "logs"), { recursive: true });
  execSync("git init", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: tmp, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function writeLocalManifest(workspaceDir, issues) {
  const dir = path.join(workspaceDir, ".coder", "local-issues");
  const issuesSubdir = path.join(dir, "issues");
  mkdirSync(issuesSubdir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      issues: issues.map((issue) => ({
        id: issue.id,
        file: `issues/${issue.id}.md`,
        title: issue.title,
        difficulty: issue.difficulty || 3,
        dependsOn: issue.dependsOn || [],
      })),
    }),
  );
  for (const issue of issues) {
    writeFileSync(
      path.join(issuesSubdir, `${issue.id}.md`),
      `# ${issue.id} — ${issue.title}

Details.`,
    );
  }
  return dir;
}

function makeCtx(workspaceDir) {
  return {
    workspaceDir,
    repoPath: ".",
    artifactsDir: path.join(workspaceDir, ".coder", "artifacts"),
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
    cancelToken: { cancelled: false, paused: false },
    log: () => {},
    config: {
      workflow: {
        maxMachineRetries: 0,
        retryBackoffMs: 0,
        hooks: [],
        issueSource: "local",
        localIssuesDir: "",
      },
    },
    agentPool: null,
    secrets: {},
  };
}

test("should stop queue on issue failure: remaining pending issues are skipped", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
      { id: "C", title: "Issue C", difficulty: 3 },
    ]);
    const issueDraftCalls = [];
    let currentIssueId = null;

    WorkflowRunner.prototype.run = async (steps) => {
      const name = steps[0]?.machine?.name;
      if (name === "develop.issue_draft") {
        currentIssueId = steps[0]?.inputMapper?.()?.issue?.id;
        issueDraftCalls.push(currentIssueId);
      }
      if (currentIssueId === "A" && name === "develop.implementation") {
        return { status: "failed", error: "Simulated failure", results: [] };
      }
      return {
        status: "completed",
        results: [
          { status: "ok", data: { branch: "feat/issue", prUrl: "http://pr" } },
        ],
      };
    };

    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      makeCtx(ws),
    );

    assert.deepEqual(issueDraftCalls, ["A"]);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.completed, 0);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((issue) => issue.id === "A");
    const issueB = finalState.issueQueue.find((issue) => issue.id === "B");
    const issueC = finalState.issueQueue.find((issue) => issue.id === "C");
    assert.equal(issueA.status, "failed");
    assert.equal(issueB.status, "skipped");
    assert.equal(issueB.error, "Skipped: prior issue failed");
    assert.equal(issueC.status, "skipped");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("should not stop on issue failure when it is the last issue", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
    ]);
    let processingIssueId = null;

    WorkflowRunner.prototype.run = async (steps) => {
      const name = steps[0]?.machine?.name;
      if (name === "develop.issue_draft") {
        processingIssueId = steps[0]?.inputMapper?.()?.issue?.id;
      }
      if (processingIssueId === "B" && name === "develop.implementation") {
        return { status: "failed", error: "Simulated failure", results: [] };
      }
      return {
        status: "completed",
        results: [
          { status: "ok", data: { branch: "feat/issue", prUrl: "http://pr" } },
        ],
      };
    };

    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      makeCtx(ws),
    );

    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 0);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((issue) => issue.id === "A");
    const issueB = finalState.issueQueue.find((issue) => issue.id === "B");
    assert.equal(issueA.status, "completed");
    assert.equal(issueB.status, "failed");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});
