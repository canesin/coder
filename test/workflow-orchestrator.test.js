import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  developRuns,
  registerWorkflowOrchestratorTools,
  researchRuns,
} from "../src/mcp/tools/workflow-orchestrator.js";
import { CoderOrchestrator } from "../src/orchestrator.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-workflow-orch-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

function makeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _spec, handler) {
      handlers.set(name, handler);
    },
  };
}

test("coder_workflow start blocks concurrent run on same workspace", async () => {
  const ws = makeWorkspace();
  const server = makeServer();
  developRuns.clear();
  researchRuns.clear();

  let finishRun;
  const runDone = new Promise((resolve) => {
    finishRun = resolve;
  });

  const originalRunAuto = CoderOrchestrator.prototype.runAuto;
  CoderOrchestrator.prototype.runAuto = async function runAutoStub() {
    return runDone;
  };

  try {
    registerWorkflowOrchestratorTools(server, ws);
    const workflow = server.handlers.get("coder_workflow");
    assert.ok(workflow);

    const first = await workflow({
      action: "start",
      workflow: "develop",
      workspace: ws,
      goal: "test",
    });
    assert.equal(first.isError, undefined);
    const firstPayload = JSON.parse(first.content[0].text);
    assert.equal(firstPayload.status, "started");
    assert.equal(typeof firstPayload.runId, "string");

    const status = await workflow({
      action: "status",
      workflow: "develop",
      workspace: ws,
    });
    assert.equal(status.isError, undefined);
    const statusPayload = JSON.parse(status.content[0].text);
    assert.equal(statusPayload.workflowMachine.source, "memory");
    assert.equal(statusPayload.workflowMachine.state, "running");

    const second = await workflow({
      action: "start",
      workflow: "develop",
      workspace: ws,
      goal: "test-2",
    });
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /Workspace already has active run/i);

    finishRun({
      status: "completed",
      completed: 0,
      failed: 0,
      skipped: 0,
      results: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    CoderOrchestrator.prototype.runAuto = originalRunAuto;
    developRuns.clear();
    researchRuns.clear();
  }
});

test("coder_workflow events reads JSONL log with seq cursor", async () => {
  const ws = makeWorkspace();
  const server = makeServer();
  const logsDir = path.join(ws, ".coder", "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, "develop.jsonl"),
    [
      JSON.stringify({ event: "run_started" }),
      "not-json-line",
      JSON.stringify({ event: "run_finished" }),
    ].join("\n") + "\n",
    "utf8",
  );

  registerWorkflowOrchestratorTools(server, ws);
  const workflow = server.handlers.get("coder_workflow");
  assert.ok(workflow);

  const res = await workflow({
    action: "events",
    workflow: "develop",
    workspace: ws,
    afterSeq: 1,
    limit: 2,
  });
  assert.equal(res.isError, undefined);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.totalLines, 3);
  assert.equal(payload.nextSeq, 3);
  assert.equal(payload.events.length, 2);
  assert.equal(payload.events[0].seq, 2);
  assert.equal(payload.events[0].raw, "not-json-line");
  assert.equal(payload.events[1].seq, 3);
  assert.equal(payload.events[1].event, "run_finished");
});

test("coder_workflow research start/status requires pointers and reports running", async () => {
  const ws = makeWorkspace();
  const server = makeServer();
  developRuns.clear();
  researchRuns.clear();

  let finishRun;
  const runDone = new Promise((resolve) => {
    finishRun = resolve;
  });

  const originalGenerate =
    CoderOrchestrator.prototype.generateIssuesFromPointers;
  CoderOrchestrator.prototype.generateIssuesFromPointers =
    async function generateIssuesStub() {
      return runDone;
    };

  try {
    registerWorkflowOrchestratorTools(server, ws);
    const workflow = server.handlers.get("coder_workflow");
    assert.ok(workflow);

    const missingPointers = await workflow({
      action: "start",
      workflow: "research",
      workspace: ws,
    });
    assert.equal(missingPointers.isError, true);
    assert.match(missingPointers.content[0].text, /pointers is required/i);

    const started = await workflow({
      action: "start",
      workflow: "research",
      workspace: ws,
      pointers: "idea pointers",
      repoPath: ".",
    });
    assert.equal(started.isError, undefined);
    const startedPayload = JSON.parse(started.content[0].text);
    assert.equal(startedPayload.status, "started");
    assert.equal(startedPayload.workflow, "research");

    const status = await workflow({
      action: "status",
      workflow: "research",
      workspace: ws,
    });
    assert.equal(status.isError, undefined);
    const statusPayload = JSON.parse(status.content[0].text);
    assert.equal(statusPayload.workflowMachine.source, "memory");
    assert.equal(statusPayload.workflowMachine.state, "running");
    assert.equal(statusPayload.runStatus, "running");

    finishRun({
      runId: startedPayload.runId,
      issues: [],
      manifestPath: ".coder/scratchpad/fake/manifest.json",
      pipelinePath: ".coder/scratchpad/fake/pipeline.json",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    CoderOrchestrator.prototype.generateIssuesFromPointers = originalGenerate;
    developRuns.clear();
    researchRuns.clear();
  }
});
