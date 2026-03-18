import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { z } from "zod";
import {
  CancelledError,
  checkCancel,
  defineMachine,
} from "../src/machines/_base.js";
import { WorkflowRunner } from "../src/workflows/_base.js";

function makeMachine(name, fn) {
  return defineMachine({
    name,
    description: `test machine: ${name}`,
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      return fn(ctx);
    },
  });
}

function makeCtx(tmp, overrides = {}) {
  const logEvents = [];
  return {
    workspaceDir: tmp,
    artifactsDir: path.join(tmp, ".coder", "artifacts"),
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    cancelToken: { cancelled: false, paused: false },
    log: (e) => logEvents.push(e),
    config: { workflow: {} },
    agentPool: null,
    secrets: {},
    logEvents,
    ...overrides,
  };
}

describe("WorkflowRunner per-step retry", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "runner-retry-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("succeeds on first try — no retry", async () => {
    const ctx = makeCtx(tmp);
    let calls = 0;
    const machine = makeMachine("test.ok", () => {
      calls++;
      return { status: "ok", data: { result: "done" } };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 2,
        backoffMs: 0,
      },
    ]);

    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    assert.equal(
      ctx.logEvents.filter((e) => e.event === "step_retry_attempt").length,
      0,
    );
  });

  it("retries on error and succeeds", async () => {
    const ctx = makeCtx(tmp);
    let calls = 0;
    const machine = makeMachine("test.retry_ok", () => {
      calls++;
      if (calls < 3) return { status: "error", error: "transient" };
      return { status: "ok", data: {} };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 3,
        backoffMs: 0,
      },
    ]);

    assert.equal(result.status, "completed");
    assert.equal(calls, 3);
    assert.equal(
      ctx.logEvents.filter((e) => e.event === "step_retry_failed").length,
      2,
    );
  });

  it("exhausts retries and returns failure", async () => {
    const ctx = makeCtx(tmp);
    let calls = 0;
    const machine = makeMachine("test.fail", () => {
      calls++;
      return { status: "error", error: "persistent" };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 2,
        backoffMs: 0,
      },
    ]);

    assert.equal(result.status, "failed");
    assert.equal(result.error, "persistent");
    assert.equal(calls, 3); // initial + 2 retries
  });

  it("cancellation between retries returns cancelled", async () => {
    const ctx = makeCtx(tmp);
    let calls = 0;
    const machine = makeMachine("test.cancel_retry", (ctx) => {
      calls++;
      ctx.cancelToken.cancelled = true;
      return { status: "error", error: "will be cancelled" };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 3,
        backoffMs: 0,
      },
    ]);

    assert.equal(result.status, "cancelled");
    assert.equal(calls, 1);
  });

  it("CancelledError from checkCancel returns cancelled (not error)", async () => {
    const ctx = makeCtx(tmp);
    ctx.cancelToken.cancelled = true;
    const machine = makeMachine("test.cancelled_error", (ctx) => {
      checkCancel(ctx); // should throw CancelledError
      return { status: "ok", data: {} };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
      },
    ]);

    assert.equal(result.status, "cancelled");
  });

  it("per-step maxRetries: 0 overrides config default", async () => {
    const ctx = makeCtx(tmp, {
      config: { workflow: { maxMachineRetries: 5 } },
    });
    let calls = 0;
    const machine = makeMachine("test.no_retry", () => {
      calls++;
      return { status: "error", error: "no retry" };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 0,
        backoffMs: 0,
      },
    ]);

    assert.equal(result.status, "failed");
    assert.equal(calls, 1);
  });

  it("uses config maxMachineRetries when step has no override", async () => {
    const ctx = makeCtx(tmp, {
      config: { workflow: { maxMachineRetries: 2, retryBackoffMs: 0 } },
    });
    let calls = 0;
    const machine = makeMachine("test.config_retry", () => {
      calls++;
      if (calls < 3) return { status: "error", error: "transient" };
      return { status: "ok", data: {} };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        // no maxRetries — should use config.workflow.maxMachineRetries = 2
      },
    ]);

    assert.equal(result.status, "completed");
    assert.equal(calls, 3);
  });

  it("onFailedAttempt callback fires on each failure", async () => {
    const ctx = makeCtx(tmp);
    let calls = 0;
    const failedAttempts = [];
    const machine = makeMachine("test.callback", () => {
      calls++;
      if (calls < 3) return { status: "error", error: `fail-${calls}` };
      return { status: "ok", data: {} };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 3,
        backoffMs: 0,
        onFailedAttempt: (info) => failedAttempts.push(info),
      },
    ]);

    assert.equal(result.status, "completed");
    assert.equal(failedAttempts.length, 2);
    assert.equal(failedAttempts[0].attempt, 0);
    assert.equal(failedAttempts[0].result.error, "fail-1");
    assert.equal(failedAttempts[1].attempt, 1);
    assert.equal(failedAttempts[1].result.error, "fail-2");
  });

  it("does not retry on cancelled status from machine", async () => {
    const ctx = makeCtx(tmp);
    let calls = 0;
    const machine = makeMachine("test.cancelled_status", () => {
      calls++;
      return { status: "cancelled", error: "user cancelled" };
    });

    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    });
    const result = await runner.run([
      {
        machine,
        inputMapper: () => ({}),
        maxRetries: 3,
        backoffMs: 0,
      },
    ]);

    assert.equal(result.status, "cancelled");
    assert.equal(calls, 1);
  });
});

describe("CancelledError", () => {
  it("is an instance of Error", () => {
    const err = new CancelledError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "CancelledError");
    assert.equal(err.message, "Run cancelled");
  });

  it("accepts custom message", () => {
    const err = new CancelledError("custom");
    assert.equal(err.message, "custom");
  });
});
