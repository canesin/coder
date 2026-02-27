import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  runDevelopPipeline,
  runWithMachineRetry,
} from "../src/workflows/develop.workflow.js";

const DEFAULT_MACHINE_RETRIES = 3;

function makeCtx(overrides = {}) {
  const logEvents = [];
  return {
    workspaceDir: "/tmp/test",
    artifactsDir: "/tmp/test/.coder/artifacts",
    cancelToken: { cancelled: false, paused: false },
    log: (e) => logEvents.push(e),
    config: { workflow: { maxMachineRetries: DEFAULT_MACHINE_RETRIES } },
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

test("runDevelopPipeline: retries failed phase-3 machine sequence and succeeds", async () => {
  const ctx = makeCtx({
    config: { workflow: { maxMachineRetries: 2 } },
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-1", title: "Retry test" },
    repoPath: "/tmp/repo",
  };
  const originalRun = WorkflowRunner.prototype.run;
  const originalSetTimeout = globalThis.setTimeout;
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
    globalThis.setTimeout = (fn, _ms, ...args) => {
      fn(...args);
      return 0;
    };
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
    globalThis.setTimeout = originalSetTimeout;
  }
});
