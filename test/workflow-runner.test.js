import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineMachine } from "../src/machines/_base.js";
import { WorkflowRunner } from "../src/workflows/_base.js";

function makeCtx(overrides = {}) {
  return {
    workspaceDir: "/tmp/test-workspace",
    repoPath: ".",
    config: {},
    agentPool: null,
    log: () => {},
    cancelToken: { cancelled: false, paused: false },
    secrets: {},
    artifactsDir: "/tmp/test-workspace/.coder/artifacts",
    scratchpadDir: "/tmp/test-workspace/.coder/scratchpad",
    ...overrides,
  };
}

const addMachine = defineMachine({
  name: "test.add",
  description: "Adds numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  async execute(input) {
    return { status: "ok", data: { sum: input.a + input.b } };
  },
});

const doubleMachine = defineMachine({
  name: "test.double",
  description: "Doubles the sum from previous step",
  inputSchema: z.object({ value: z.number() }),
  async execute(input) {
    return { status: "ok", data: { result: input.value * 2 } };
  },
});

const failMachine = defineMachine({
  name: "test.fail",
  description: "Always fails",
  inputSchema: z.object({}),
  async execute() {
    throw new Error("intentional failure");
  },
});

test("WorkflowRunner: runs sequential steps with inputMapper", async () => {
  const ctx = makeCtx();
  const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });

  const result = await runner.run(
    [
      {
        machine: addMachine,
        inputMapper: () => ({ a: 3, b: 4 }),
      },
      {
        machine: doubleMachine,
        inputMapper: (prev) => ({ value: prev.data.sum }),
      },
    ],
    {},
  );

  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].data.sum, 7);
  assert.equal(result.results[1].data.result, 14);
  assert.ok(result.durationMs >= 0);
  assert.ok(result.runId.length > 0);
});

test("WorkflowRunner: stops on non-optional error", async () => {
  const ctx = makeCtx();
  const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });

  const result = await runner.run(
    [
      { machine: failMachine, inputMapper: () => ({}) },
      { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
    ],
    {},
  );

  assert.equal(result.status, "failed");
  assert.equal(result.results.length, 1);
  assert.match(result.error, /intentional failure/);
});

test("WorkflowRunner: skips optional step errors", async () => {
  const ctx = makeCtx();
  const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });

  const result = await runner.run(
    [
      { machine: failMachine, inputMapper: () => ({}), optional: true },
      { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
    ],
    {},
  );

  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, "error");
  assert.equal(result.results[1].data.sum, 3);
});

test("WorkflowRunner: respects cancel token", async () => {
  const ctx = makeCtx();
  ctx.cancelToken.cancelled = true;
  const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });

  const result = await runner.run(
    [{ machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) }],
    {},
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.results.length, 0);
});

test("WorkflowRunner: calls onStageChange and onCheckpoint", async () => {
  const ctx = makeCtx();
  const stages = [];
  const checkpoints = [];

  const runner = new WorkflowRunner({
    name: "test",
    workflowContext: ctx,
    onStageChange: (s) => stages.push(s),
    onCheckpoint: (i, r) => checkpoints.push({ i, status: r.status }),
  });

  await runner.run(
    [
      { machine: addMachine, inputMapper: () => ({ a: 5, b: 5 }) },
      {
        machine: doubleMachine,
        inputMapper: (prev) => ({ value: prev.data.sum }),
      },
    ],
    {},
  );

  assert.deepEqual(stages, ["test.add", "test.double"]);
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(checkpoints[0], { i: 0, status: "ok" });
  assert.deepEqual(checkpoints[1], { i: 1, status: "ok" });
});
