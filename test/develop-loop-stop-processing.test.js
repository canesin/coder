import assert from "node:assert/strict";
import { execSync } from "node:child_process";
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
import { loadLoopState } from "../src/state/workflow-state.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import { runDevelopLoop } from "../src/workflows/develop.workflow.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stop-loop-"));
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

test("hard failure aborts queue and emits issue_skipped hooks for auto-skipped items", async () => {
  const ws = makeTmpWorkspace();
  const hookLog = path.join(ws, "hook-events.log");
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
      { id: "C", title: "Issue C", difficulty: 3 },
    ]);
    const issueDraftCalls = [];
    let currentIssueId = null;

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (machineName === "develop.issue_draft") {
        currentIssueId = steps[0]?.inputMapper?.()?.issue?.id;
        issueDraftCalls.push(currentIssueId);
      }
      if (machineName === "develop.planning" || machineName === "develop.plan_review") {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-hard-fail",
          durationMs: 0,
        };
      }
      if (machineName === "develop.implementation" && currentIssueId === "A") {
        return {
          status: "failed",
          error: "fatal build failure",
          results: [
            { machine: "develop.implementation", status: "ok", data: {} },
            {
              machine: "develop.quality_review",
              status: "error",
              error: "fatal build failure",
            },
          ],
          runId: "run-hard-fail",
          durationMs: 0,
        };
      }
      return completedRunnerResult("run-hard-fail");
    };

    const hookCmd = `printf '%s\\n' \"$CODER_HOOK_ISSUE_ID\" >> ${JSON.stringify(hookLog)}`;
    const ctx = makeCtx(ws, {
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [{ on: "issue_skipped", run: hookCmd }],
          issueSource: "local",
          localIssuesDir: "",
        },
      },
    });
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    assert.deepEqual(issueDraftCalls, ["A"]);
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 2);

    const finalState = await loadLoopState(ws);
    const issueA = finalState.issueQueue.find((issue) => issue.id === "A");
    const issueB = finalState.issueQueue.find((issue) => issue.id === "B");
    const issueC = finalState.issueQueue.find((issue) => issue.id === "C");
    assert.equal(issueA.status, "failed");
    assert.equal(issueB.status, "skipped");
    assert.equal(issueC.status, "skipped");

    const hookIds = existsSync(hookLog)
      ? readFileSync(hookLog, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    assert.deepEqual(hookIds.sort(), ["B", "C"]);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("rate-limited failures defer and do not trigger queue abort", async () => {
  const ws = makeTmpWorkspace();
  const originalRun = WorkflowRunner.prototype.run;

  try {
    const issuesDir = writeLocalManifest(ws, [
      { id: "A", title: "Issue A", difficulty: 1 },
      { id: "B", title: "Issue B", difficulty: 2 },
    ]);
    const issueDraftCalls = [];
    let currentIssueId = null;
    const attempts = new Map();

    WorkflowRunner.prototype.run = async function runStub(steps) {
      const machineName = steps[0]?.machine?.name;
      if (machineName === "develop.issue_draft") {
        currentIssueId = steps[0]?.inputMapper?.()?.issue?.id;
        issueDraftCalls.push(currentIssueId);
      }
      if (machineName === "develop.planning" || machineName === "develop.plan_review") {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "run-rate-limit",
          durationMs: 0,
        };
      }
      if (machineName === "develop.implementation") {
        const nextAttempt = (attempts.get(currentIssueId) || 0) + 1;
        attempts.set(currentIssueId, nextAttempt);
        if (currentIssueId === "A" && nextAttempt === 1) {
          return {
            status: "failed",
            error: "429 rate limit exceeded",
            results: [
              {
                machine: "develop.quality_review",
                status: "error",
                error: "429 rate limit exceeded",
              },
            ],
            runId: "run-rate-limit",
            durationMs: 0,
          };
        }
      }
      return completedRunnerResult("run-rate-limit");
    };

    const ctx = makeCtx(ws);
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    assert.ok(issueDraftCalls.includes("B"));
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
    assert.equal(
      ctx.logEvents.some((event) => event.event === "loop_aborted_on_failure"),
      false,
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});
