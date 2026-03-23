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
import { FailureMonitorSchema } from "../src/config.js";
import {
  fileRcaIssue,
  gatherFailureContext,
  runFailureRca,
} from "../src/workflows/failure-monitor.js";

function makeTmpWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "fm-test-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(tmp, ".coder", "logs"), { recursive: true });
  execSync("git init", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git config user.name Test", { cwd: tmp, stdio: "ignore" });
  writeFileSync(path.join(tmp, "dummy.txt"), "init\n");
  execSync("git add -A && git commit -m init", { cwd: tmp, stdio: "ignore" });
  return tmp;
}

function makeCtx(tmp, overrides = {}) {
  return {
    workspaceDir: tmp,
    cancelToken: { cancelled: false, paused: false },
    config: {
      workflow: {
        failureMonitor: {
          enabled: true,
          labels: ["coder-rca", "automated"],
          timeoutMs: 60_000,
          monitorBlockingDefers: false,
          ...overrides.failureMonitor,
        },
      },
    },
    agentPool: overrides.agentPool || {
      getAgent: () => ({
        agentName: "codex",
        agent: {
          executeWithRetry: async () => ({
            exitCode: 0,
            stdout: "### Root Cause\nTest failure\n### Suggested Fix\nFix it.",
            stderr: "",
          }),
        },
      }),
    },
    log: overrides.log || (() => {}),
    ...overrides,
  };
}

// --- Config schema tests ---

test("FailureMonitorSchema: parses defaults correctly", () => {
  const result = FailureMonitorSchema.parse({});
  assert.equal(result.enabled, false);
  assert.deepEqual(result.labels, ["coder-rca", "automated"]);
  assert.equal(result.timeoutMs, 300_000);
  assert.equal(result.monitorBlockingDefers, false);
});

test("FailureMonitorSchema: accepts custom values", () => {
  const result = FailureMonitorSchema.parse({
    enabled: true,
    labels: ["bug", "auto-rca"],
    timeoutMs: 120_000,
    monitorBlockingDefers: true,
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.labels, ["bug", "auto-rca"]);
  assert.equal(result.timeoutMs, 120_000);
  assert.equal(result.monitorBlockingDefers, true);
});

// --- gatherFailureContext tests ---

test("gatherFailureContext: reads all available artifacts", () => {
  const tmp = makeTmpWorkspace();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\nDetails");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\nSteps");
    writeFileSync(
      path.join(artifactsDir, "PLANREVIEW.md"),
      "# Review\nApproved",
    );
    writeFileSync(
      path.join(artifactsDir, "REVIEW_FINDINGS.md"),
      "# Findings\nBug",
    );

    const loopState = {
      currentStage: "develop.quality_review",
      activeAgent: "codex",
      issueQueue: [
        {
          error: "test failure",
          deferredReason: null,
          branch: "feat/test",
        },
      ],
    };

    const ctx = gatherFailureContext(tmp, { id: "#1" }, loopState, 0);
    assert.equal(ctx.error, "test failure");
    assert.equal(ctx.stage, "develop.quality_review");
    assert.ok(ctx.artifacts.issue.includes("Issue"));
    assert.ok(ctx.artifacts.plan.includes("Plan"));
    assert.ok(ctx.artifacts.planReview.includes("Review"));
    assert.ok(ctx.artifacts.reviewFindings.includes("Findings"));
    assert.equal(ctx.branch, "feat/test");
    assert.ok(ctx.gitLog.length > 0, "should have git log");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gatherFailureContext: works with no artifacts (early-stage failure)", () => {
  const tmp = makeTmpWorkspace();
  try {
    const loopState = {
      currentStage: "develop.issue_draft",
      issueQueue: [{ error: "draft failed", branch: null }],
    };

    const ctx = gatherFailureContext(tmp, { id: "#2" }, loopState, 0);
    assert.equal(ctx.error, "draft failed");
    assert.equal(ctx.artifacts.issue, null);
    assert.equal(ctx.artifacts.plan, null);
    assert.equal(ctx.branch, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gatherFailureContext: reads agent log tail", () => {
  const tmp = makeTmpWorkspace();
  try {
    const logPath = path.join(tmp, ".coder", "logs", "codex.jsonl");
    const logLines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ event: "line", n: i }),
    );
    writeFileSync(logPath, logLines.join("\n"));

    const loopState = {
      activeAgent: "codex",
      issueQueue: [{ error: "fail" }],
    };

    const ctx = gatherFailureContext(tmp, { id: "#3" }, loopState, 0);
    assert.ok(ctx.agentLogTail.length > 0);
    // Should only have last 50 lines
    assert.ok(ctx.agentLogTail.includes('"n":99'));
    assert.ok(!ctx.agentLogTail.includes('"n":0'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- runFailureRca tests ---

test("runFailureRca: skipped when disabled", async () => {
  const tmp = makeTmpWorkspace();
  try {
    const ctx = makeCtx(tmp, {
      failureMonitor: { enabled: false },
    });
    // Override config with disabled
    ctx.config.workflow.failureMonitor.enabled = false;

    const result = await runFailureRca(
      {
        issue: { id: "#1", title: "Test" },
        error: "fail",
        loopRunId: "abc123",
        loopState: { issueQueue: [{ error: "fail" }] },
        issueIndex: 0,
      },
      ctx,
    );
    assert.equal(result.skipped, true);
    assert.equal(result.issueUrl, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runFailureRca: skipped when cancelled", async () => {
  const tmp = makeTmpWorkspace();
  try {
    const ctx = makeCtx(tmp);
    ctx.cancelToken.cancelled = true;

    const result = await runFailureRca(
      {
        issue: { id: "#1", title: "Test" },
        error: "fail",
        loopRunId: "abc123",
        loopState: { issueQueue: [{ error: "fail" }] },
        issueIndex: 0,
      },
      ctx,
    );
    assert.equal(result.skipped, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runFailureRca: agent failure is non-blocking", async () => {
  const tmp = makeTmpWorkspace();
  try {
    const ctx = makeCtx(tmp, {
      agentPool: {
        getAgent: () => ({
          agentName: "codex",
          agent: {
            executeWithRetry: async () => {
              throw new Error("agent crashed");
            },
          },
        }),
      },
    });

    const result = await runFailureRca(
      {
        issue: { id: "#1", title: "Test" },
        error: "fail",
        loopRunId: "abc123",
        loopState: { issueQueue: [{ error: "fail" }] },
        issueIndex: 0,
      },
      ctx,
    );

    // Should not throw, should return error info
    assert.equal(result.issueUrl, null);
    assert.ok(result.error);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runFailureRca: persists RCA.md to artifacts and rcaAnalysis to loop state", async () => {
  const tmp = makeTmpWorkspace();
  try {
    const loopState = {
      runId: "run-1",
      issueQueue: [{ error: "compile error", status: "failed" }],
    };
    const ctx = makeCtx(tmp, {
      agentPool: {
        getAgent: () => ({
          agentName: "codex",
          agent: {
            executeWithRetry: async () => ({
              exitCode: 0,
              stdout: "### Root Cause\nMissing import\n### Suggested Fix\nAdd import.",
              stderr: "",
            }),
          },
        }),
      },
    });
    // Skip the gh issue create by making it non-GitHub
    ctx.config.workflow.issueSource = "github";

    const result = await runFailureRca(
      {
        issue: { source: "github", id: "#5", title: "Broken build" },
        error: "compile error",
        loopRunId: "run-1",
        loopState,
        issueIndex: 0,
      },
      ctx,
    );

    // RCA.md should be written to artifacts dir
    const rcaPath = path.join(tmp, ".coder", "artifacts", "RCA.md");
    assert.ok(existsSync(rcaPath), "RCA.md should be persisted");
    const rcaContent = readFileSync(rcaPath, "utf8");
    assert.ok(rcaContent.includes("Missing import"), "RCA content should include analysis");

    // Loop state should have rcaAnalysis
    assert.ok(loopState.issueQueue[0].rcaAnalysis, "rcaAnalysis should be in loop state");
    assert.ok(
      loopState.issueQueue[0].rcaAnalysis.includes("Missing import"),
      "rcaAnalysis should contain the analysis",
    );

    // Return value should include rcaAnalysis
    if (!result.error) {
      assert.ok(result.rcaAnalysis, "return value should include rcaAnalysis");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- fileRcaIssue tests ---

test("fileRcaIssue: throws on gh failure", () => {
  // Use a non-existent directory to force gh to fail
  assert.throws(
    () =>
      fileRcaIssue({
        repoRoot: "/tmp/nonexistent-repo-for-test",
        title: "[coder-rca] test",
        body: "test body",
        labels: ["coder-rca"],
      }),
    /gh issue create failed/,
  );
});
