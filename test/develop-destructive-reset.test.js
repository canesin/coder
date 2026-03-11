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
  const tmp = mkdtempSync(path.join(os.tmpdir(), "destructive-reset-"));
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
      `# ${issue.id} — ${issue.title}\n\nDetails.`,
    );
  }
  return dir;
}

function makeCtx(workspaceDir, overrides = {}) {
  const logEvents = [];
  return {
    workspaceDir,
    repoPath: ".",
    artifactsDir: path.join(workspaceDir, ".coder", "artifacts"),
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
    cancelToken: { cancelled: false, paused: false },
    log: (event) => logEvents.push(event),
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
    ...overrides,
  };
}

function completedRunnerResult(runId = "run-test") {
  return {
    status: "completed",
    results: [
      {
        machine: "develop.pr_creation",
        status: "ok",
        data: { branch: "feat/test", prUrl: "https://example.test/pr" },
      },
    ],
    runId,
    durationMs: 0,
  };
}

test("destructiveReset retries failed/skipped issues but preserves completed", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
      { id: "C", title: "Issue C", difficulty: 3 },
    ]);

    // Seed prior loop state: A=completed, B=failed, C=skipped
    await saveLoopState(ws, {
      runId: "prior-run",
      goal: "prior",
      status: "completed",
      projectFilter: null,
      maxIssues: null,
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "completed",
          branch: "feat/A",
          prUrl: "https://example.test/pr/A",
          error: null,
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: "2025-01-01T00:01:00.000Z",
          dependsOn: [],
        },
        {
          source: "local",
          id: "B",
          title: "Issue B",
          status: "failed",
          branch: null,
          prUrl: null,
          error: "quality review failed",
          startedAt: "2025-01-01T00:02:00.000Z",
          completedAt: null,
          dependsOn: [],
        },
        {
          source: "local",
          id: "C",
          title: "Issue C",
          status: "skipped",
          branch: null,
          prUrl: null,
          error: "Skipped: prior issue failed",
          startedAt: null,
          completedAt: "2025-01-01T00:03:00.000Z",
          dependsOn: [],
        },
      ],
      currentIndex: 0,
      currentStage: null,
      currentStageStartedAt: null,
      lastHeartbeatAt: null,
      runnerPid: null,
      activeAgent: null,
      startedAt: "2025-01-01T00:00:00.000Z",
      completedAt: "2025-01-01T00:04:00.000Z",
    });

    const processedIds = [];

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (machineName === "develop.issue_draft") {
        const issueId = steps[0]?.inputMapper?.()?.issue?.id;
        processedIds.push(issueId);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-reset",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-reset");
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: true,
      },
      ctx,
    );

    // A was completed in prior run → should NOT be re-processed
    assert.ok(
      !processedIds.includes("A"),
      "completed issue A should be skipped",
    );
    // B was failed → should be retried
    assert.ok(processedIds.includes("B"), "failed issue B should be retried");
    // C was skipped → should be retried
    assert.ok(processedIds.includes("C"), "skipped issue C should be retried");

    // Final tallies: A preserved + B,C now completed
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((q) => q.id === "A");
    const issueB = finalState.issueQueue.find((q) => q.id === "B");
    const issueC = finalState.issueQueue.find((q) => q.id === "C");
    assert.equal(issueA.status, "completed");
    assert.equal(issueB.status, "completed");
    assert.equal(issueC.status, "completed");
    // B and C should have cleared their prior errors
    assert.equal(issueB.error, null);
    assert.equal(issueC.error, null);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("without destructiveReset, failed/skipped issues are preserved from prior run", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
    ]);

    // Seed prior loop state: A=completed, B=failed
    await saveLoopState(ws, {
      runId: "prior-run",
      goal: "prior",
      status: "completed",
      projectFilter: null,
      maxIssues: null,
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "completed",
          branch: "feat/A",
          prUrl: "https://example.test/pr/A",
          error: null,
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: "2025-01-01T00:01:00.000Z",
          dependsOn: [],
        },
        {
          source: "local",
          id: "B",
          title: "Issue B",
          status: "failed",
          branch: null,
          prUrl: null,
          error: "quality review failed",
          startedAt: "2025-01-01T00:02:00.000Z",
          completedAt: null,
          dependsOn: [],
        },
      ],
      currentIndex: 0,
      currentStage: null,
      currentStageStartedAt: null,
      lastHeartbeatAt: null,
      runnerPid: null,
      activeAgent: null,
      startedAt: "2025-01-01T00:00:00.000Z",
      completedAt: "2025-01-01T00:04:00.000Z",
    });

    const processedIds = [];

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (machineName === "develop.issue_draft") {
        processedIds.push(steps[0]?.inputMapper?.()?.issue?.id);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-no-reset",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-no-reset");
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    // Neither A (completed) nor B (failed) should be re-processed
    assert.equal(processedIds.length, 0);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);

    const finalState = await loadLoopState(ws);
    const issueB = finalState.issueQueue.find((q) => q.id === "B");
    assert.equal(issueB.status, "failed");
    assert.equal(issueB.error, "quality review failed");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});
