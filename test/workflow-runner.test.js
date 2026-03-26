import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { defineMachine } from "../src/machines/_base.js";
import { loadCheckpoint } from "../src/state/machine-state.js";
import { runHooks, WorkflowRunner } from "../src/workflows/_base.js";

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

test("WorkflowRunner: invokes ctx.onWorkflowStage with stage and optional activeAgent", async () => {
  const notifications = [];
  const ctx = makeCtx({
    onWorkflowStage: (p) => notifications.push(p),
  });
  const runner = new WorkflowRunner({
    name: "test",
    workflowContext: ctx,
    stageActiveAgent: (m) =>
      m === "test.add" ? "agent-a" : m === "test.double" ? "agent-b" : null,
  });

  await runner.run(
    [
      { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
      {
        machine: doubleMachine,
        inputMapper: (prev) => ({ value: prev.data.sum }),
      },
    ],
    {},
  );

  assert.deepEqual(notifications, [
    { stage: "test.add", activeAgent: "agent-a" },
    { stage: "test.double", activeAgent: "agent-b" },
  ]);
});

test("WorkflowRunner: runs machine_start and machine_complete hooks", async () => {
  const tmpFile = path.join(os.tmpdir(), `hook-test-${Date.now()}.txt`);
  try {
    const ctx = makeCtx({
      config: {
        workflow: {
          hooks: [
            {
              on: "machine_start",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', 'start\\n')"`,
            },
            {
              on: "machine_complete",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', 'complete\\n')"`,
            },
          ],
        },
      },
    });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });
    const result = await runner.run(
      [{ machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) }],
      {},
    );
    assert.equal(result.status, "completed");
    assert.ok(existsSync(tmpFile));
    const content = readFileSync(tmpFile, "utf8");
    assert.ok(content.includes("start"), "machine_start hook should have run");
    assert.ok(
      content.includes("complete"),
      "machine_complete hook should have run",
    );
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
});

test("WorkflowRunner: hook machine filter skips non-matching machines", async () => {
  const tmpFile = path.join(os.tmpdir(), `hook-filter-test-${Date.now()}.txt`);
  try {
    const ctx = makeCtx({
      config: {
        workflow: {
          hooks: [
            {
              on: "machine_complete",
              machine: "test\\.add",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', 'add\\n')"`,
            },
          ],
        },
      },
    });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });
    await runner.run(
      [
        { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
        {
          machine: doubleMachine,
          inputMapper: (prev) => ({ value: prev.data.sum }),
        },
      ],
      {},
    );
    assert.ok(existsSync(tmpFile));
    const lines = readFileSync(tmpFile, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1, "hook should run once, only for test.add");
    assert.equal(lines[0], "add");
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
});

test("WorkflowRunner: hook failure does not abort workflow", async () => {
  const ctx = makeCtx({
    config: {
      workflow: {
        hooks: [{ on: "machine_complete", run: "node -e 'process.exit(1)'" }],
      },
    },
  });
  const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });
  const result = await runner.run(
    [{ machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) }],
    {},
  );
  assert.equal(result.status, "completed");
  assert.equal(result.results[0].data.sum, 3);
});

test("WorkflowRunner: fires workflow_start and workflow_complete hooks", async () => {
  const tmpFile = path.join(os.tmpdir(), `wf-hook-test-${Date.now()}.txt`);
  try {
    const ctx = makeCtx({
      config: {
        workflow: {
          hooks: [
            {
              on: "workflow_start",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', 'wf_start\\n')"`,
            },
            {
              on: "workflow_complete",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', 'wf_complete\\n')"`,
            },
          ],
        },
      },
    });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });
    const result = await runner.run(
      [{ machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) }],
      {},
    );
    assert.equal(result.status, "completed");
    assert.ok(existsSync(tmpFile));
    const content = readFileSync(tmpFile, "utf8");
    assert.ok(
      content.includes("wf_start"),
      "workflow_start hook should have run",
    );
    assert.ok(
      content.includes("wf_complete"),
      "workflow_complete hook should have run",
    );
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
});

test("WorkflowRunner: fires workflow_failed hook on non-optional step failure", async () => {
  const tmpFile = path.join(os.tmpdir(), `wf-failed-hook-${Date.now()}.txt`);
  try {
    const ctx = makeCtx({
      config: {
        workflow: {
          hooks: [
            {
              on: "workflow_failed",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', process.env.CODER_HOOK_STATUS + '\\n')"`,
            },
          ],
        },
      },
    });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });
    const result = await runner.run(
      [{ machine: failMachine, inputMapper: () => ({}) }],
      {},
    );
    assert.equal(result.status, "failed");
    assert.ok(existsSync(tmpFile));
    const content = readFileSync(tmpFile, "utf8");
    assert.ok(
      content.includes("failed"),
      "workflow_failed hook should have run with status=failed",
    );
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
});

test("WorkflowRunner: workflow_complete hook receives CODER_HOOK_RUN_ID", async () => {
  const tmpFile = path.join(os.tmpdir(), `wf-runid-hook-${Date.now()}.txt`);
  try {
    const ctx = makeCtx({
      config: {
        workflow: {
          hooks: [
            {
              on: "workflow_complete",
              run: `node -e "require('fs').writeFileSync('${tmpFile}', process.env.CODER_HOOK_RUN_ID)"`,
            },
          ],
        },
      },
    });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });
    await runner.run(
      [{ machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) }],
      {},
    );
    assert.ok(existsSync(tmpFile));
    const runId = readFileSync(tmpFile, "utf8");
    assert.ok(runId.length > 0, "CODER_HOOK_RUN_ID should be non-empty");
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
});

test("runHooks is exported and callable directly", async () => {
  const tmpFile = path.join(os.tmpdir(), `run-hooks-export-${Date.now()}.txt`);
  try {
    const ctx = makeCtx({
      config: {
        workflow: {
          hooks: [
            {
              on: "workflow_complete",
              run: `node -e "require('fs').appendFileSync('${tmpFile}', process.env.CODER_HOOK_EVENT + '\\n')"`,
            },
          ],
        },
      },
    });
    runHooks(ctx, "test-run-id", "workflow_complete", "myworkflow", {
      status: "completed",
    });
    assert.ok(existsSync(tmpFile));
    const content = readFileSync(tmpFile, "utf8");
    assert.ok(content.includes("workflow_complete"));
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
});

test("WorkflowRunner: persists checkpoint after each step", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "runner-checkpoint-"));
  mkdirSync(path.join(ws, ".coder"), { recursive: true });
  try {
    const ctx = makeCtx({ workspaceDir: ws });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });

    await runner.run(
      [
        { machine: addMachine, inputMapper: () => ({ a: 2, b: 3 }) },
        {
          machine: doubleMachine,
          inputMapper: (prev) => ({ value: prev.data.sum }),
        },
      ],
      {},
    );

    const checkpoint = loadCheckpoint(ws, runner.runId);
    assert.ok(checkpoint, "checkpoint should exist");
    assert.equal(checkpoint.workflow, "test");
    assert.equal(checkpoint.steps.length, 2);
    assert.equal(checkpoint.currentStep, 2);
    assert.equal(checkpoint.steps[0].machine, "test.add");
    assert.equal(checkpoint.steps[0].data.sum, 5);
    assert.equal(checkpoint.steps[1].machine, "test.double");
    assert.equal(checkpoint.steps[1].data.result, 10);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("WorkflowRunner: resumes from checkpoint when resumeFromRunId provided", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "wf-resume-"));
  mkdirSync(path.join(ws, ".coder"), { recursive: true });
  try {
    const ctx = makeCtx({ workspaceDir: ws });
    const runner = new WorkflowRunner({ name: "test", workflowContext: ctx });

    let failOnceInvoked = 0;
    const failThenSucceed = defineMachine({
      name: "test.failOnce",
      description: "Fails first time, succeeds second",
      inputSchema: z.object({}),
      async execute() {
        failOnceInvoked++;
        if (failOnceInvoked === 1) throw new Error("intentional");
        return { status: "ok", data: { done: true } };
      },
    });

    const first = await runner.run(
      [
        { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
        { machine: failThenSucceed, inputMapper: () => ({}) },
      ],
      {},
    );

    assert.equal(first.status, "failed");
    assert.equal(first.results.length, 2);
    const runId = runner.runId;

    const second = await runner.run(
      [
        { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
        { machine: failThenSucceed, inputMapper: () => ({}) },
      ],
      {},
      { resumeFromRunId: runId },
    );

    assert.equal(second.status, "completed");
    assert.equal(second.results.length, 2);
    assert.equal(second.results[1].data.done, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("WorkflowRunner: repeated resumes do not skip a previously failed step", async () => {
  const ws = path.join(os.tmpdir(), `wf-resume-repeat-${Date.now()}`);
  mkdirSync(path.join(ws, ".coder"), { recursive: true });
  try {
    const ctx = makeCtx({ workspaceDir: ws });
    let attempts = 0;
    const failTwiceThenSucceed = defineMachine({
      name: "test.failTwice",
      description: "Fails twice, then succeeds",
      inputSchema: z.object({}),
      async execute() {
        attempts++;
        if (attempts < 3) throw new Error(`intentional-${attempts}`);
        return { status: "ok", data: { attempts } };
      },
    });

    const steps = [
      { machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) },
      { machine: failTwiceThenSucceed, inputMapper: () => ({}) },
      {
        machine: doubleMachine,
        inputMapper: (prev) => ({ value: prev.data.attempts }),
      },
    ];

    const first = await new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    }).run(steps);
    assert.equal(first.status, "failed");

    const second = await new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    }).run(steps, {}, { resumeFromRunId: first.runId });
    assert.equal(second.status, "failed");

    const checkpointAfterSecond = loadCheckpoint(ws, first.runId);
    assert.ok(checkpointAfterSecond, "checkpoint should still exist");
    assert.equal(checkpointAfterSecond.steps.length, 2);
    assert.equal(checkpointAfterSecond.currentStep, 2);
    assert.equal(checkpointAfterSecond.steps[1].machine, "test.failTwice");
    assert.equal(checkpointAfterSecond.steps[1].status, "error");

    const third = await new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
    }).run(steps, {}, { resumeFromRunId: first.runId });
    assert.equal(third.status, "completed");
    assert.equal(third.results.length, 3);
    assert.equal(third.results[1].data.attempts, 3);
    assert.equal(third.results[2].data.result, 6);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("WorkflowRunner: calls onResumeSkipped when checkpoint missing and persists fresh runId", async () => {
  const ws = path.join(os.tmpdir(), `wf-resume-skip-${Date.now()}`);
  mkdirSync(path.join(ws, ".coder"), { recursive: true });
  try {
    const ctx = makeCtx({ workspaceDir: ws });
    const runIds = [];
    const runner = new WorkflowRunner({
      name: "test",
      workflowContext: ctx,
      onResumeSkipped: async (runId) => {
        runIds.push(runId);
      },
    });

    const result = await runner.run(
      [{ machine: addMachine, inputMapper: () => ({ a: 1, b: 2 }) }],
      {},
      { resumeFromRunId: "nonexistent-run-id" },
    );

    assert.equal(result.status, "completed");
    assert.equal(runIds.length, 1);
    assert.equal(runIds[0], runner.runId);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
