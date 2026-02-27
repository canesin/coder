import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLoopState, saveLoopState } from "../src/state/workflow-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import { runDevelopLoop } from "../src/workflows/develop.workflow.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "gh118-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "logs"), { recursive: true });
  execSync("git init && git commit --allow-empty -m init", {
    cwd: tmp,
    stdio: "ignore",
  });
  return tmp;
}

function writeLocalManifest(ws, issues) {
  const dir = path.join(ws, ".coder", "local-issues");
  const issuesSubdir = path.join(dir, "issues");
  mkdirSync(issuesSubdir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      issues: issues.map((iss) => ({
        id: iss.id,
        file: `issues/${iss.id}.md`,
        title: iss.title,
        difficulty: iss.difficulty || 3,
        dependsOn: iss.dependsOn || [],
      })),
    }),
  );
  for (const iss of issues) {
    writeFileSync(
      path.join(issuesSubdir, `${iss.id}.md`),
      `# ${iss.id} — ${iss.title}\n\nDetails.`,
    );
  }
  return dir;
}

function makeCtx(workspaceDir) {
  const logEvents = [];
  return {
    workspaceDir,
    repoPath: ".",
    artifactsDir: path.join(workspaceDir, ".coder", "artifacts"),
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
    cancelToken: { cancelled: false, paused: false },
    log: (e) => logEvents.push(e),
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
    logEvents,
  };
}

function successfulPipelineStub(steps) {
  const name = steps[0]?.machine?.name;
  if (name === "develop.issue_draft") {
    return { status: "completed", results: [{ status: "ok", data: {} }] };
  }
  if (name === "develop.planning") {
    return {
      status: "completed",
      results: [{ status: "ok", data: { planMd: "plan" } }],
    };
  }
  if (name === "develop.plan_review") {
    return {
      status: "completed",
      results: [
        { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
      ],
    };
  }
  if (name === "develop.implementation") {
    return {
      status: "completed",
      results: [
        { status: "ok", data: {} },
        { status: "ok", data: {} },
        {
          status: "ok",
          data: { branch: "feat/issue-b", prUrl: "https://github.com/test/2" },
        },
      ],
    };
  }
  return { status: "completed", results: [] };
}

test("prior completed issue is not re-processed, dependency resolves for B", async () => {
  const ws = makeTmpWorkspace();
  const originalWfRun = WorkflowRunner.prototype.run;
  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1, dependsOn: [] },
      { id: "B", title: "Issue B", difficulty: 2, dependsOn: ["A"] },
    ]);

    saveLoopState(ws, {
      runId: "prior-run",
      status: "completed",
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "completed",
          branch: "feat/issue-a",
          prUrl: "https://github.com/test/1",
          error: null,
          baseBranch: null,
          dependsOn: [],
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T01:00:00.000Z",
        },
      ],
    });

    const issueDraftCalls = [];
    WorkflowRunner.prototype.run = async (steps) => {
      const name = steps[0]?.machine?.name;
      if (name === "develop.issue_draft") {
        issueDraftCalls.push(steps[0]?.inputMapper?.()?.issue?.id);
      }
      return successfulPipelineStub(steps);
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    // A must NOT be re-processed — only B should enter the pipeline
    assert.deepEqual(issueDraftCalls, ["B"], "only B should enter pipeline");
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);

    const resultA = result.results.find((r) => r.id === "A");
    const resultB = result.results.find((r) => r.id === "B");
    assert.equal(resultA.status, "completed");
    assert.equal(resultB.status, "completed");

    const deferred = ctx.logEvents.filter((e) => e.event === "issue_deferred");
    assert.equal(deferred.length, 0, "B should not be deferred");

    const finalLoop = loadLoopState(ws);
    const qA = finalLoop.issueQueue.find((q) => q.id === "A");
    const qB = finalLoop.issueQueue.find((q) => q.id === "B");
    assert.equal(qA.status, "completed");
    assert.equal(qB.status, "completed");
  } finally {
    WorkflowRunner.prototype.run = originalWfRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("prior failed issue is not re-processed, dependent is skipped", async () => {
  const ws = makeTmpWorkspace();
  const originalWfRun = WorkflowRunner.prototype.run;
  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1, dependsOn: [] },
      { id: "B", title: "Issue B", difficulty: 2, dependsOn: ["A"] },
    ]);

    saveLoopState(ws, {
      runId: "prior-run",
      status: "completed",
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "failed",
          branch: null,
          prUrl: null,
          error: "build failed",
          baseBranch: null,
          dependsOn: [],
        },
      ],
    });

    const pipelineCalls = [];
    WorkflowRunner.prototype.run = async (steps) => {
      pipelineCalls.push(steps[0]?.machine?.name);
      return successfulPipelineStub(steps);
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    assert.equal(pipelineCalls.length, 0, "no pipeline calls expected");
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);

    const resultA = result.results.find((r) => r.id === "A");
    const resultB = result.results.find((r) => r.id === "B");
    assert.equal(resultA.status, "failed");
    assert.equal(resultB.status, "skipped");
  } finally {
    WorkflowRunner.prototype.run = originalWfRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("closed prior dependency not in issue list still resolves", async () => {
  const ws = makeTmpWorkspace();
  const originalWfRun = WorkflowRunner.prototype.run;
  try {
    // Only B in manifest — A has been merged/closed
    const issuesDir = writeLocalManifest(ws, [
      { id: "B", title: "Issue B", difficulty: 2, dependsOn: ["A"] },
    ]);

    saveLoopState(ws, {
      runId: "prior-run",
      status: "completed",
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "completed",
          branch: "feat/issue-a",
          prUrl: "https://github.com/test/1",
          error: null,
          baseBranch: null,
          dependsOn: [],
        },
      ],
    });

    const pipelineCalls = [];
    WorkflowRunner.prototype.run = async (steps) => {
      pipelineCalls.push(steps[0]?.machine?.name);
      return successfulPipelineStub(steps);
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    assert.ok(pipelineCalls.length > 0, "B should trigger pipeline");
    assert.equal(result.completed, 1);

    const deferred = ctx.logEvents.filter((e) => e.event === "issue_deferred");
    assert.equal(deferred.length, 0, "B should not be deferred");

    const resultB = result.results.find((r) => r.id === "B");
    assert.equal(resultB.status, "completed");
  } finally {
    WorkflowRunner.prototype.run = originalWfRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("fresh run with no prior state processes all issues", async () => {
  const ws = makeTmpWorkspace();
  const originalWfRun = WorkflowRunner.prototype.run;
  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1, dependsOn: [] },
      { id: "B", title: "Issue B", difficulty: 2, dependsOn: [] },
    ]);

    const pipelineCalls = [];
    WorkflowRunner.prototype.run = async (steps) => {
      pipelineCalls.push(steps[0]?.machine?.name);
      return successfulPipelineStub(steps);
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
  } finally {
    WorkflowRunner.prototype.run = originalWfRun;
    rmSync(ws, { recursive: true, force: true });
  }
});
