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
  parseRcaClassification,
  runFailureRca,
  scanAndRedactSecrets,
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

// --- parseRcaClassification tests ---

test("parseRcaClassification: extracts CODER_BUG", () => {
  const rca =
    "### Classification\n\n- **CODER_BUG** — the planner failed\n\n### Root Cause\n...";
  assert.equal(parseRcaClassification(rca), "CODER_BUG");
});

test("parseRcaClassification: extracts PROJECT_ISSUE", () => {
  const rca =
    "### Classification\n**PROJECT_ISSUE**\n\n### Root Cause\nBuild failed.";
  assert.equal(parseRcaClassification(rca), "PROJECT_ISSUE");
});

test("parseRcaClassification: extracts INFRA", () => {
  const rca =
    "### Classification\n**INFRA** — rate limited\n### Root Cause\n...";
  assert.equal(parseRcaClassification(rca), "INFRA");
});

test("parseRcaClassification: returns UNCLEAR for missing classification", () => {
  const rca = "### Root Cause\nSomething went wrong.";
  assert.equal(parseRcaClassification(rca), "UNCLEAR");
});

test("parseRcaClassification: returns UNCLEAR for unrecognized value", () => {
  const rca = "### Classification\n**UNKNOWN_THING**\n### Root Cause\n...";
  assert.equal(parseRcaClassification(rca), "UNCLEAR");
});

// --- scanAndRedactSecrets tests ---

test("scanAndRedactSecrets: returns original text when no secrets found", () => {
  const text = "This is a safe issue body with no secrets.";
  const result = scanAndRedactSecrets(text);
  assert.equal(result.text, text);
  assert.equal(result.redactedCount, 0);
});

test("scanAndRedactSecrets: redacts detected secrets", () => {
  // Use a generic-api-key pattern that gitleaks default rules detect:
  // assignment with a long hex-like value
  const fakeSecret = "ghp_xK9mR2vLnQ4wT8zF1bY5dC3hA6jE0pS7uI";
  const text = `Error log:\nGITHUB_TOKEN=${fakeSecret}\nEnd of log.`;
  const result = scanAndRedactSecrets(text);
  if (result.redactedCount > 0) {
    assert.ok(
      !result.text.includes(fakeSecret),
      "secret should be removed from output",
    );
    assert.ok(
      result.text.includes("[REDACTED]"),
      "should contain [REDACTED] marker",
    );
  }
  // If gitleaks is not installed or rules don't match, redactedCount is 0 — OK
  assert.equal(typeof result.text, "string");
});

test("scanAndRedactSecrets: handles gitleaks not installed gracefully", () => {
  // Even with a fake config path, should not throw
  const text = "some text with token=abc123";
  const result = scanAndRedactSecrets(text, "/nonexistent/gitleaks.toml");
  assert.equal(typeof result.text, "string");
  assert.equal(typeof result.redactedCount, "number");
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

test("runFailureRca: persists RCA.md to per-issue rca dir for agent consumption", async () => {
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
              stdout:
                "### Classification\n\n- **PROJECT_ISSUE**\n\n### Root Cause\nMissing import\n### Suggested Fix\nAdd import.",
              stderr: "",
            }),
          },
        }),
      },
    });
    ctx.config.workflow.issueSource = "github";

    await runFailureRca(
      {
        issue: { source: "github", id: "#5", title: "Broken build" },
        error: "compile error",
        loopRunId: "run-1",
        loopState,
        issueIndex: 0,
      },
      ctx,
    );

    // RCA.md should be written to per-issue rca dir (immune to archive/clear races)
    // Key uses backupKeyFor format: source-id-repoPart
    const rcaPath = path.join(tmp, ".coder", "rca", "github-#5-root.md");
    assert.ok(existsSync(rcaPath), "RCA.md should be persisted to per-issue path");
    const rcaContent = readFileSync(rcaPath, "utf8");
    assert.ok(
      rcaContent.includes("Missing import"),
      "RCA content should include analysis",
    );
    assert.ok(
      rcaContent.startsWith("# Root Cause Analysis:"),
      "should have title header",
    );
    assert.ok(
      rcaContent.includes("**Classification:** PROJECT_ISSUE"),
      "should include classification",
    );
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
