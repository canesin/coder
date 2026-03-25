import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadLoopState,
  saveLoopState,
  statePathFor,
} from "../src/state/workflow-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import { runDevelopLoop } from "../src/workflows/develop.workflow.js";

function makeTmpWorkspace() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "fix-plan-"));
  const tmp = path.join(parent, "ws");
  mkdirSync(tmp);
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "logs"), { recursive: true });
  execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git commit --allow-empty -m init", { cwd: tmp, stdio: "ignore" });
  const bare = path.join(parent, "bare.git");
  execSync(`git init --bare ${bare}`, { stdio: "ignore" });
  execSync(`git remote add origin ${bare}`, { cwd: tmp, stdio: "ignore" });
  execSync("git push -u origin main", { cwd: tmp, stdio: "ignore" });
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

test("infra failure with infraDetection enabled yields deferred and run status blocked", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      if (machineName === "develop.implementation") {
        return {
          status: "failed",
          error: "ECONNREFUSED: connection refused to 127.0.0.1:5432",
          results: [],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          infraDetection: true,
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.deferred, 1);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((q) => q.id === "A");
    assert.equal(issueA.status, "deferred");
    assert.equal(issueA.deferredReason, "infra");
    assert.match(issueA.error, /ECONNREFUSED|connection refused/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("infra failure with infraDetection disabled yields failed not deferred", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      if (machineName === "develop.implementation") {
        return {
          status: "failed",
          error: "ECONNREFUSED: connection refused",
          results: [],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          infraDetection: false,
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result.status, "failed");
    assert.equal(result.failed, 1);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((q) => q.id === "A");
    assert.equal(issueA.status, "failed");
    assert.equal(issueA.deferredReason, undefined);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("infra/plan_blocked deferred issues are excluded from same-run retry pass", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;
  const processedIds = [];
  let implementationCallCount = 0;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      const issueId = steps[0]?.inputMapper?.()?.issue?.id;
      if (machineName === "develop.issue_draft") {
        processedIds.push(issueId);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      if (machineName === "develop.implementation") {
        implementationCallCount++;
        if (implementationCallCount === 1) {
          return {
            status: "failed",
            error: "ECONNREFUSED: connection refused",
            results: [],
            runId: "run-1",
            durationMs: 0,
          };
        }
      }
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          infraDetection: true,
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((q) => q.id === "A");
    const issueB = finalState.issueQueue.find((q) => q.id === "B");
    assert.equal(issueA.status, "deferred");
    assert.equal(issueA.deferredReason, "infra");
    assert.equal(issueB.status, "completed");
    assert.equal(result.deferred, 1);
    assert.equal(
      processedIds.filter((id) => id === "A").length,
      1,
      "A should not be retried in deferred pass (infra excluded)",
    );
    const deferredRetryLog = ctx.logEvents.find(
      (e) => e.event === "deferred_retry_pass",
    );
    assert.ok(
      !deferredRetryLog?.ids?.includes("A"),
      "deferred retry pass must exclude infra-deferred issue A",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("preflight command check fails before loop processes any issue", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;
  let pipelineStarted = false;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub() {
      pipelineStarted = true;
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          preflight: {
            checks: [{ type: "command", cmd: "false" }],
          },
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /Pre-flight check failed|command failed/);
    assert.equal(pipelineStarted, false);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("preflight command check passes and loop proceeds", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          preflight: {
            checks: [{ type: "command", cmd: "true" }],
          },
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result.status, "completed");
    assert.equal(result.completed, 1);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("preflight tcp check fails when port refuses", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;
  let pipelineStarted = false;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub() {
      pipelineStarted = true;
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          preflight: {
            checks: [{ type: "tcp", host: "127.0.0.1", port: 65534 }],
          },
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /Pre-flight|TCP|refused|timed out/);
    assert.equal(pipelineStarted, false);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("preflight tcp check passes when port accepts", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;
  const server = createServer(() => {});
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = server.address().port;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
          preflight: {
            checks: [{ type: "tcp", host: "127.0.0.1", port }],
          },
        },
      },
    });

    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result.status, "completed");
    assert.equal(result.completed, 1);
  } finally {
    server.close();
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("git_tracking deferred when git pull fails with stale upstream ref", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "fix-plan-stale-ref-"));
  const bareDir = path.join(tmp, "bare");
  const ws = path.join(tmp, "ws");
  const originalRun = WorkflowRunner.prototype.run;

  try {
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(ws, { recursive: true });
    mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
    mkdirSync(path.join(ws, ".coder", "logs"), { recursive: true });

    execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });
    execSync("git init -b main", { cwd: ws, stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd: ws,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test User'", { cwd: ws, stdio: "ignore" });
    execSync("git commit --allow-empty -m init", { cwd: ws, stdio: "ignore" });
    execSync(`git remote add origin ${bareDir}`, { cwd: ws, stdio: "ignore" });
    execSync("git push -u origin main", { cwd: ws, stdio: "ignore" });

    const mainRef = path.join(bareDir, "refs", "heads", "main");
    if (existsSync(mainRef)) rmSync(mainRef);

    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-1");
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

    assert.equal(result.status, "blocked");
    assert.equal(result.deferred, 1);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((q) => q.id === "A");
    assert.equal(issueA.status, "deferred");
    assert.equal(issueA.deferredReason, "git_tracking");
    assert.match(issueA.error, /upstream ref not found|set-upstream-to/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("start after blocked run processes deferred issues (blocked treated as terminal)", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;
  const processedIds = [];

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    await saveLoopState(ws, {
      runId: "prior-blocked-run",
      goal: "test",
      status: "blocked",
      projectFilter: null,
      maxIssues: null,
      issueQueue: [
        {
          source: "local",
          id: "A",
          title: "Issue A",
          status: "deferred",
          deferredReason: "git_tracking",
          error: "Upstream ref not found",
          branch: null,
          prUrl: null,
          startedAt: "2025-01-01T00:00:00.000Z",
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
      completedAt: "2025-01-01T00:01:00.000Z",
    });

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      const issueId = steps[0]?.inputMapper?.()?.issue?.id;
      if (machineName === "develop.issue_draft") {
        processedIds.push(issueId);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-2",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-2");
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

    assert.equal(result.status, "completed");
    assert.equal(result.completed, 1);
    assert.ok(
      processedIds.includes("A"),
      "blocked-run deferred issue A should be retried on next start",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("planReviewExhausted defer preserves state; next start retries and completes", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;
  const processedIds = [];

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      const issueId = steps[0]?.inputMapper?.()?.issue?.id;
      if (machineName === "develop.issue_draft") {
        processedIds.push(issueId);
      }
      if (machineName === "develop.planning") {
        return {
          status: "completed",
          results: [{ status: "ok", data: { planMd: "plan" } }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      if (machineName === "develop.plan_review") {
        return {
          status: "completed",
          results: [
            {
              status: "ok",
              data: {
                verdict: "REJECT",
                critiqueMd: "fundamentally unsound",
              },
            },
          ],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          maxPlanRevisions: 2,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
        },
      },
    });

    const result1 = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result1.status, "blocked");
    assert.equal(result1.deferred, 1);

    const stateAfterDefer = await loadLoopState(ws);
    const issueA = stateAfterDefer.issueQueue.find((q) => q.id === "A");
    assert.equal(issueA.status, "deferred");
    assert.equal(issueA.deferredReason, "plan_blocked");

    assert.ok(
      existsSync(statePathFor(ws)),
      "state.json must exist after planReviewExhausted defer (no reset)",
    );

    processedIds.length = 0;
    WorkflowRunner.prototype.run = async function runStub2(steps) {
      const machineName = steps[0]?.machine?.name;
      const issueId = steps[0]?.inputMapper?.()?.issue?.id;
      if (machineName === "develop.issue_draft") {
        processedIds.push(issueId);
      }
      if (
        machineName === "develop.planning" ||
        machineName === "develop.plan_review"
      ) {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-2",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-2");
    };

    const result2 = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        destructiveReset: false,
      },
      ctx,
    );

    assert.equal(result2.status, "completed");
    assert.equal(result2.completed, 1);
    assert.ok(
      processedIds.includes("A"),
      "plan_blocked deferred issue A should be retried and completed on next start",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(path.dirname(ws), { recursive: true, force: true });
  }
});

test("hard failure when git pull --ff-only fails with non-stale error", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "fix-plan-pull-fail-"));
  const bareDir = path.join(tmp, "bare");
  const ws = path.join(tmp, "ws");
  const clone2 = path.join(tmp, "clone2");
  const originalRun = WorkflowRunner.prototype.run;

  try {
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(ws, { recursive: true });
    mkdirSync(clone2, { recursive: true });
    mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
    mkdirSync(path.join(ws, ".coder", "logs"), { recursive: true });

    execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });
    execSync("git init -b main", { cwd: ws, stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd: ws,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test User'", { cwd: ws, stdio: "ignore" });
    execSync("git commit --allow-empty -m init", { cwd: ws, stdio: "ignore" });
    execSync(`git remote add origin ${bareDir}`, { cwd: ws, stdio: "ignore" });
    execSync("git push -u origin main", { cwd: ws, stdio: "ignore" });

    // Push a diverging commit via a second clone
    execSync(`git clone ${bareDir} ${clone2}`, { stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd: clone2,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test User'", {
      cwd: clone2,
      stdio: "ignore",
    });
    execSync("git commit --allow-empty -m 'remote diverge'", {
      cwd: clone2,
      stdio: "ignore",
    });
    execSync("git push", { cwd: clone2, stdio: "ignore" });

    // Create a local commit in ws that diverges from the remote
    execSync("git commit --allow-empty -m 'local diverge'", {
      cwd: ws,
      stdio: "ignore",
    });

    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
    ]);

    let runCalled = false;
    WorkflowRunner.prototype.run = async function runStub() {
      runCalled = true;
      return completedRunnerResult("run-1");
    };

    const ctx = makeCtx(ws);
    await assert.rejects(
      runDevelopLoop(
        {
          issueSource: "local",
          localIssuesDir: issuesDir,
          destructiveReset: false,
        },
        ctx,
      ),
      /Git pull failed/,
    );

    // Verify loop state is persisted as failed
    const loopState = await loadLoopState(ws);
    assert.equal(loopState.status, "failed");
    assert.ok(loopState.completedAt, "loop should have completedAt timestamp");
    assert.equal(loopState.issueQueue[0].status, "failed");
    assert.match(loopState.issueQueue[0].error, /Git pull failed/);

    // Verify planning/implementation never started
    assert.equal(runCalled, false, "WorkflowRunner.run should not be called");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});
