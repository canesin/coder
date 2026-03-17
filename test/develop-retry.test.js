import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointPathFor } from "../src/state/machine-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  backupKeyFor,
  runDevelopPipeline,
  runWithMachineRetry,
} from "../src/workflows/develop.workflow.js";

const DEFAULT_MACHINE_RETRIES = 2;

function makeCtx(overrides = {}) {
  const logEvents = [];
  return {
    workspaceDir: "/tmp/test",
    artifactsDir: "/tmp/test/.coder/artifacts",
    cancelToken: { cancelled: false, paused: false },
    log: (e) => logEvents.push(e),
    config: {
      workflow: {
        maxMachineRetries: DEFAULT_MACHINE_RETRIES,
        retryBackoffMs: 0,
      },
    },
    agentPool: null,
    secrets: {},
    scratchpadDir: "/tmp/test/.coder/scratchpad",
    logEvents,
    ...overrides,
  };
}

test("runWithMachineRetry: succeeds on first try", async () => {
  const ctx = makeCtx();
  let calls = 0;
  const fn = async () => {
    calls++;
    return { status: "completed", results: [] };
  };

  const result = await runWithMachineRetry(fn, {
    maxRetries: DEFAULT_MACHINE_RETRIES,
    backoffMs: 0,
    ctx,
  });

  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.equal(ctx.logEvents.length, 0);
});

test("runWithMachineRetry: succeeds after failure (within retries)", async () => {
  const ctx = makeCtx();
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) {
      return { status: "failed", error: "transient error" };
    }
    return { status: "completed", results: [] };
  };

  const result = await runWithMachineRetry(fn, {
    maxRetries: DEFAULT_MACHINE_RETRIES,
    backoffMs: 0,
    ctx,
  });

  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  const retryLogs = ctx.logEvents.filter(
    (e) => e.event === "machine_retry_failed",
  );
  assert.equal(retryLogs.length, 2);
  assert.equal(retryLogs[0].attempt, 0);
  assert.equal(retryLogs[1].attempt, 1);
});

test("runWithMachineRetry: exhausts retries and returns failure", async () => {
  const ctx = makeCtx();
  let calls = 0;
  const fn = async () => {
    calls++;
    return { status: "failed", error: "persistent error" };
  };

  const result = await runWithMachineRetry(fn, {
    maxRetries: 2,
    backoffMs: 0,
    ctx,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "persistent error");
  assert.equal(calls, 3);

  const lastLog = ctx.logEvents[ctx.logEvents.length - 1];
  assert.equal(lastLog.event, "machine_retry_failed");
  assert.equal(lastLog.attempt, 2);
});

test("runWithMachineRetry: maxRetries: 0 disables retry", async () => {
  const ctx = makeCtx();
  let calls = 0;
  const fn = async () => {
    calls++;
    return { status: "failed", error: "oops" };
  };

  const result = await runWithMachineRetry(fn, {
    maxRetries: 0,
    backoffMs: 0,
    ctx,
  });

  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
});

test("runWithMachineRetry: respects cancellation (returns whatever status)", async () => {
  const ctx = makeCtx();
  let calls = 0;
  const fn = async () => {
    calls++;
    return { status: "cancelled", results: [] };
  };

  const result = await runWithMachineRetry(fn, {
    maxRetries: DEFAULT_MACHINE_RETRIES,
    backoffMs: 0,
    ctx,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
});

test("runWithMachineRetry: stops retrying when cancelled between attempts", async () => {
  const ctx = makeCtx();
  let calls = 0;
  const fn = async () => {
    calls++;
    // Cancel after first attempt
    if (calls === 1) ctx.cancelToken.cancelled = true;
    return { status: "failed", error: "should not retry" };
  };

  const result = await runWithMachineRetry(fn, {
    maxRetries: DEFAULT_MACHINE_RETRIES,
    backoffMs: 0,
    ctx,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
});

test("runDevelopPipeline: retries failed phase-3 machine sequence and succeeds", async () => {
  const ctx = makeCtx({
    config: {
      workflow: { maxMachineRetries: 2, retryBackoffMs: 0 },
    },
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-1", title: "Retry test" },
    repoPath: "/tmp/repo",
  };
  const originalRun = WorkflowRunner.prototype.run;
  let phase3Calls = 0;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-1",
        durationMs: 0,
      };
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
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    if (machineName === "develop.implementation") {
      phase3Calls++;
      if (phase3Calls < 3) {
        return {
          status: "failed",
          error: "Transient machine error",
          results: [{ status: "error", error: "Transient machine error" }],
          runId: "run-1",
          durationMs: 0,
        };
      }
      return {
        status: "completed",
        results: [
          { status: "ok", data: { implementation: "done" } },
          { status: "ok", data: { review: "done" } },
          { status: "ok", data: { pr: "done" } },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine sequence start: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "completed");
    assert.equal(phase3Calls, 3);
    assert.equal(
      ctx.logEvents.filter((e) => e.event === "machine_retry_failed").length,
      2,
    );
    assert.equal(
      ctx.logEvents.filter((e) => e.event === "machine_retry_attempt").length,
      2,
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
  }
});

test("runDevelopPipeline: injects quality-review failure details before retry", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-retry-feedback-"));
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  const critiquePath = path.join(artifactsDir, "PLANREVIEW.md");
  writeFileSync(critiquePath, "# Existing critique\n", "utf8");
  const issue = {
    source: "local",
    id: "ISSUE-2",
    title: "Retry feedback test",
    repo_path: "/tmp/repo",
  };
  writeFileSync(
    path.join(tmp, ".coder", "state.json"),
    JSON.stringify({
      selected: issue,
      steps: { wrotePlan: true, wroteCritique: true, implemented: true },
    }),
  );
  const staleRunId = "phase3-first";
  writeFileSync(
    checkpointPathFor(tmp, staleRunId),
    JSON.stringify({
      runId: staleRunId,
      workflow: "develop",
      steps: [
        {
          machine: "develop.implementation",
          status: "ok",
          data: {},
          durationMs: 0,
          completedAt: new Date().toISOString(),
        },
        {
          machine: "develop.quality_review",
          status: "error",
          error: "tests failed: 2 failing cases",
          durationMs: 0,
          completedAt: new Date().toISOString(),
        },
      ],
      currentStep: 2,
      updatedAt: new Date().toISOString(),
    }),
  );
  const loopState = {
    runId: "loop-1",
    issueQueue: [
      {
        source: issue.source,
        id: issue.id,
        title: issue.title,
        status: "in_progress",
        lastFailedRunId: staleRunId,
      },
    ],
  };

  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    config: {
      workflow: { maxMachineRetries: 1, retryBackoffMs: 0 },
    },
  });
  const opts = {
    issue,
    repoPath: "/tmp/repo",
    loopState,
    issueIndex: 0,
    resumeFromRunId: staleRunId,
  };

  const originalRun = WorkflowRunner.prototype.run;
  let phase3Calls = 0;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-2",
        durationMs: 0,
      };
    }

    if (machineName === "develop.planning") {
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "plan" } }],
        runId: "run-2",
        durationMs: 0,
      };
    }

    if (machineName === "develop.plan_review") {
      return {
        status: "completed",
        results: [
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-2",
        durationMs: 0,
      };
    }

    if (machineName === "develop.implementation") {
      phase3Calls++;
      if (phase3Calls === 1) {
        return {
          status: "failed",
          error: "quality review failed",
          results: [
            { machine: "develop.implementation", status: "ok", data: {} },
            {
              machine: "develop.quality_review",
              status: "error",
              error: "tests failed: 2 failing cases",
            },
          ],
          runId: staleRunId,
          durationMs: 0,
        };
      }
      return {
        status: "completed",
        results: [
          { machine: "develop.implementation", status: "ok", data: {} },
          { machine: "develop.quality_review", status: "ok", data: {} },
          {
            machine: "develop.pr_creation",
            status: "ok",
            data: { prUrl: "https://example.test/pr/2", branch: "feat/2" },
          },
        ],
        runId: "phase3-second",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine sequence start: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);
    assert.equal(result.status, "completed");
    assert.equal(phase3Calls, 2);

    const critique = readFileSync(critiquePath, "utf8");
    assert.match(critique, /## Retry Feedback/);
    assert.match(critique, /\*\*develop\.quality_review failed/);
    assert.match(critique, /tests failed: 2 failing cases/);

    const backupKey = backupKeyFor(issue);
    const backupStatePath = path.join(
      tmp,
      ".coder",
      "backups",
      backupKey,
      "state.json",
    );
    assert.ok(
      readFileSync(backupStatePath, "utf8").includes('"implemented": false'),
      "backup after quality_review failure must have implemented: false",
    );
    assert.equal(
      existsSync(checkpointPathFor(tmp, staleRunId)),
      false,
      "quality_review retry feedback should invalidate the stale phase-3 checkpoint",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: terminal quality-review failure still invalidates stale resume state", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-retry-terminal-"));
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  const critiquePath = path.join(artifactsDir, "PLANREVIEW.md");
  writeFileSync(critiquePath, "# Existing critique\n", "utf8");
  const issue = {
    source: "local",
    id: "ISSUE-3",
    title: "Terminal retry feedback test",
    repo_path: "/tmp/repo",
  };
  writeFileSync(
    path.join(tmp, ".coder", "state.json"),
    JSON.stringify({
      selected: issue,
      steps: { wrotePlan: true, wroteCritique: true, implemented: true },
    }),
  );
  const staleRunId = "phase3-terminal";
  writeFileSync(
    checkpointPathFor(tmp, staleRunId),
    JSON.stringify({
      runId: staleRunId,
      workflow: "develop",
      steps: [
        {
          machine: "develop.implementation",
          status: "ok",
          data: {},
          durationMs: 0,
          completedAt: new Date().toISOString(),
        },
        {
          machine: "develop.quality_review",
          status: "error",
          error: "tests failed: terminal case",
          durationMs: 0,
          completedAt: new Date().toISOString(),
        },
      ],
      currentStep: 2,
      updatedAt: new Date().toISOString(),
    }),
  );
  const loopState = {
    runId: "loop-2",
    issueQueue: [
      {
        source: issue.source,
        id: issue.id,
        title: issue.title,
        status: "in_progress",
        lastFailedRunId: staleRunId,
      },
    ],
  };

  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    config: {
      workflow: { maxMachineRetries: 0, retryBackoffMs: 0 },
    },
  });
  const opts = {
    issue,
    repoPath: "/tmp/repo",
    loopState,
    issueIndex: 0,
    resumeFromRunId: staleRunId,
  };

  const originalRun = WorkflowRunner.prototype.run;

  WorkflowRunner.prototype.run = async function runStub(steps) {
    const machineName = steps[0]?.machine?.name;

    if (machineName === "develop.issue_draft") {
      return {
        status: "completed",
        results: [{ status: "ok", data: {} }],
        runId: "run-3",
        durationMs: 0,
      };
    }

    if (machineName === "develop.planning") {
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "plan" } }],
        runId: "run-3",
        durationMs: 0,
      };
    }

    if (machineName === "develop.plan_review") {
      return {
        status: "completed",
        results: [
          { status: "ok", data: { verdict: "APPROVED", critiqueMd: "" } },
        ],
        runId: "run-3",
        durationMs: 0,
      };
    }

    if (machineName === "develop.implementation") {
      return {
        status: "failed",
        error: "quality review failed terminally",
        results: [
          { machine: "develop.implementation", status: "ok", data: {} },
          {
            machine: "develop.quality_review",
            status: "error",
            error: "tests failed: terminal case",
          },
        ],
        runId: staleRunId,
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine sequence start: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);
    assert.equal(result.status, "failed");

    // With maxMachineRetries: 0, retry feedback is not injected (no retry will follow)
    const critique = readFileSync(critiquePath, "utf8");
    assert.equal(
      critique,
      "# Existing critique\n",
      "critique should be unchanged when no retries are configured",
    );

    const backupKey = backupKeyFor(issue);
    const backupStatePath = path.join(
      tmp,
      ".coder",
      "backups",
      backupKey,
      "state.json",
    );
    assert.ok(
      readFileSync(backupStatePath, "utf8").includes('"implemented": false'),
      "terminal quality_review failure must persist implemented: false",
    );
    assert.equal(
      existsSync(checkpointPathFor(tmp, staleRunId)),
      false,
      "terminal quality_review failure should invalidate the stale phase-3 checkpoint",
    );
    assert.equal(loopState.issueQueue[0].lastFailedRunId, null);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});
