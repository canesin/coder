import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startWorkflowActor } from "../src/mcp/tools/workflows.js";
import {
  loadLoopState,
  workflowStatePathFor,
} from "../src/state/workflow-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import { runDevelopLoop } from "../src/workflows/develop.workflow.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "runid-test-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "logs"), { recursive: true });
  execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: tmp, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: tmp, stdio: "ignore" });
  const bare = mkdtempSync(path.join(os.tmpdir(), "runid-test-bare-"));
  execSync("git init --bare", { cwd: bare, stdio: "ignore" });
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

test("develop loop uses ctx.runId when provided", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "X", title: "Issue X", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async () => completedRunnerResult("run-ctx");

    // Seed stale loop-state on disk
    writeFileSync(
      path.join(ws, ".coder", "loop-state.json"),
      JSON.stringify({ runId: "stale-run", status: "completed" }),
    );

    const ctx = makeCtx(ws, { runId: "launcher-run" });
    await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    const final = await loadLoopState(ws);
    assert.equal(
      final.runId,
      "launcher-run",
      "loop must use ctx.runId when provided",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("develop loop generates fresh runId when ctx.runId is absent", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "Y", title: "Issue Y", difficulty: 1 },
    ]);

    WorkflowRunner.prototype.run = async () =>
      completedRunnerResult("run-fresh");

    // Seed stale loop-state on disk
    writeFileSync(
      path.join(ws, ".coder", "loop-state.json"),
      JSON.stringify({ runId: "stale-run", status: "completed" }),
    );

    const ctx = makeCtx(ws);
    await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    const final = await loadLoopState(ws);
    assert.notEqual(
      final.runId,
      "stale-run",
      "loop must NOT reuse stale runId from disk",
    );
    assert.notEqual(final.runId, undefined, "runId must not be undefined");
    assert.ok(
      typeof final.runId === "string" && final.runId.length === 8,
      "fresh runId must be an 8-char UUID slice",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("startWorkflowActor passes guardRunId to workflow snapshot", async () => {
  const ws = makeTmpWorkspace();

  try {
    const actor = startWorkflowActor({
      runId: "old-run",
      workspaceDir: ws,
      workflow: "develop",
      goal: "test goal",
      initialAgent: "test",
    });

    // Wait for initial snapshot write to settle
    await new Promise((r) => setTimeout(r, 100));

    // Overwrite disk with a newer run's state
    const statePath = workflowStatePathFor(ws);
    writeFileSync(
      statePath,
      JSON.stringify({
        runId: "new-run",
        workflow: "develop",
        value: "running",
        context: {},
      }),
    );

    // Trigger a state change on the old actor — this fires the subscribe callback
    actor.send({ type: "HEARTBEAT", at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 100));

    // The old actor must NOT clobber the newer run's state
    const diskState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(
      diskState.runId,
      "new-run",
      "stale actor must not overwrite newer run's workflow-state.json",
    );

    actor.stop();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
