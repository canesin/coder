import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planReviewMachine from "../src/machines/develop/plan-review.machine.js";
import { loadState, saveState } from "../src/state/workflow-state.js";

function makeGitWorkspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "plan-review-res-"));
  const repoRoot = path.join(ws, "repo");
  mkdirSync(repoRoot, { recursive: true });
  execSync("git init -b main", { cwd: repoRoot, stdio: "ignore" });
  execSync("git config user.email t@t.com", { cwd: repoRoot, stdio: "ignore" });
  execSync("git config user.name T", { cwd: repoRoot, stdio: "ignore" });
  writeFileSync(path.join(repoRoot, "README.md"), "# r\n");
  execSync("git add README.md && git commit -m init", {
    cwd: repoRoot,
    stdio: "ignore",
  });
  const artifactsDir = path.join(ws, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n\nBody.");
  return { ws, repoRoot, artifactsDir };
}

test("plan review: nonzero exit logs plan_review_execute_failed once (not critique_missing)", async () => {
  const { ws, repoRoot, artifactsDir } = makeGitWorkspace();
  try {
    await saveState(ws, {
      selected: { source: "local", id: "1", title: "T" },
      repoPath: path.relative(ws, repoRoot) || ".",
      steps: { wroteIssue: true, wrotePlan: true },
      branch: "main",
    });

    const logEvents = [];
    const mockAgent = {
      async execute() {
        return { exitCode: 1, stdout: "out", stderr: "err" };
      },
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: {
        getAgent: () => ({ agentName: "claude", agent: mockAgent }),
      },
      log: (e) => logEvents.push(e),
      config: {
        workflow: {
          timeouts: { planReview: 60_000 },
          wip: { push: false },
        },
      },
    };

    const nzResult = await planReviewMachine.run({ round: 0 }, ctx);
    assert.equal(nzResult.status, "error");

    const failed = logEvents.filter(
      (e) => e.event === "plan_review_execute_failed",
    );
    assert.equal(failed.length, 1, "exactly one plan_review_execute_failed");
    assert.equal(failed[0].exitCode, 1);
    assert.equal(failed[0].stdoutLen, 3);
    assert.equal(failed[0].stderrLen, 3);
    assert.ok(
      !logEvents.some((e) => e.event === "critique_missing_after_review"),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("plan review: empty first output clears session; retry uses sessionId create path", async () => {
  const { ws, repoRoot, artifactsDir } = makeGitWorkspace();
  try {
    await saveState(ws, {
      selected: { source: "local", id: "1", title: "T" },
      repoPath: path.relative(ws, repoRoot) || ".",
      steps: { wroteIssue: true, wrotePlan: true },
      branch: "main",
      planningSessionId: "00000000-0000-4000-8000-000000000001",
      planReviewSessionId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      planReviewAgentName: "claude",
    });

    const logEvents = [];
    const executeOpts = [];
    const prompts = [];
    let call = 0;
    const critiquePath = path.join(artifactsDir, "PLANREVIEW.md");
    const planPath = path.join(artifactsDir, "PLAN.md");

    const mockAgent = {
      async execute(prompt, opts) {
        prompts.push(prompt);
        executeOpts.push({ ...opts });
        call++;
        if (call === 1) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        writeFileSync(
          critiquePath,
          "## Critical Issues\n\nNone.\n\n## Verdict\nAPPROVED\n",
          "utf8",
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: {
        getAgent: () => ({ agentName: "claude", agent: mockAgent }),
      },
      log: (e) => logEvents.push(e),
      config: {
        workflow: {
          timeouts: { planReview: 60_000 },
          wip: { push: false },
        },
      },
    };

    const result = await planReviewMachine.run({ round: 1 }, ctx);
    assert.equal(result.status, "ok");
    assert.ok(existsSync(critiquePath));

    assert.ok(logEvents.some((e) => e.event === "critique_retry_empty_output"));
    assert.ok(
      logEvents.some((e) => e.event === "critique_retry_fresh_session"),
    );
    assert.ok(
      !logEvents.some((e) => e.event === "critique_missing_after_review"),
    );

    assert.equal(executeOpts.length, 2);
    assert.ok(executeOpts[0].resumeId || executeOpts[0].sessionId);
    assert.ok(
      executeOpts[1].sessionId,
      "retry after cleared planReviewSessionId must use sessionId (fresh session)",
    );
    assert.ok(!executeOpts[1].resumeId, "retry must not resume prior session");

    assert.ok(
      prompts[1].includes(planPath) || prompts[1].includes("PLAN.md"),
      "retry prompt must reference the plan file for fresh-session context",
    );
    assert.ok(
      /Read the implementation plan/i.test(prompts[1]),
      "retry prompt must instruct reading the plan",
    );

    const state = await loadState(ws);
    assert.ok(
      state.planReviewSessionId,
      "new session id persisted after retry",
    );
    assert.notEqual(
      state.planReviewSessionId,
      "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("plan review: retry when sessionsDisabled logs sessionless (not fresh_session)", async () => {
  const { ws, repoRoot, artifactsDir } = makeGitWorkspace();
  try {
    await saveState(ws, {
      selected: { source: "local", id: "1", title: "T" },
      repoPath: path.relative(ws, repoRoot) || ".",
      steps: { wroteIssue: true, wrotePlan: true },
      branch: "main",
      sessionsDisabled: true,
      planReviewSessionId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      planReviewAgentName: "claude",
    });

    const logEvents = [];
    const executeOpts = [];
    let call = 0;
    const critiquePath = path.join(artifactsDir, "PLANREVIEW.md");

    const mockAgent = {
      async execute(_prompt, opts) {
        executeOpts.push({ ...opts });
        call++;
        if (call === 1) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        writeFileSync(
          critiquePath,
          "## Critical Issues\n\nNone.\n\n## Verdict\nAPPROVED\n",
          "utf8",
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: {
        getAgent: () => ({ agentName: "claude", agent: mockAgent }),
      },
      log: (e) => logEvents.push(e),
      config: {
        workflow: {
          timeouts: { planReview: 60_000 },
          wip: { push: false },
        },
      },
    };

    const result = await planReviewMachine.run({ round: 0 }, ctx);
    assert.equal(result.status, "ok");

    assert.ok(logEvents.some((e) => e.event === "critique_retry_sessionless"));
    assert.ok(
      !logEvents.some((e) => e.event === "critique_retry_fresh_session"),
    );
    assert.equal(executeOpts.length, 2);
    assert.ok(!executeOpts[0].sessionId && !executeOpts[0].resumeId);
    assert.ok(!executeOpts[1].sessionId && !executeOpts[1].resumeId);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("plan review: thrown error with err.stdout/stderr logs stream lengths", async () => {
  const { ws, repoRoot, artifactsDir } = makeGitWorkspace();
  try {
    await saveState(ws, {
      selected: { source: "local", id: "1", title: "T" },
      repoPath: path.relative(ws, repoRoot) || ".",
      steps: { wroteIssue: true, wrotePlan: true },
      branch: "main",
    });

    const logEvents = [];
    const mockAgent = {
      async execute() {
        const e = new Error("sandbox boom");
        e.stdout = "hello-out";
        e.stderr = "e";
        throw e;
      },
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: {
        getAgent: () => ({ agentName: "claude", agent: mockAgent }),
      },
      log: (e) => logEvents.push(e),
      config: {
        workflow: {
          timeouts: { planReview: 60_000 },
          wip: { push: false },
        },
      },
    };

    const result = await planReviewMachine.run({ round: 0 }, ctx);
    assert.equal(result.status, "error");

    const failed = logEvents.find(
      (e) => e.event === "plan_review_execute_failed",
    );
    assert.ok(failed);
    assert.equal(failed.stdoutLen, 9);
    assert.equal(failed.stderrLen, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("plan review: exit 0 missing file and empty stdout logs critique_missing_after_review", async () => {
  const { ws, repoRoot, artifactsDir } = makeGitWorkspace();
  try {
    await saveState(ws, {
      selected: { source: "local", id: "1", title: "T" },
      repoPath: path.relative(ws, repoRoot) || ".",
      steps: { wroteIssue: true, wrotePlan: true },
      branch: "main",
    });

    const logEvents = [];
    let call = 0;
    const mockAgent = {
      async execute() {
        call++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const ctx = {
      workspaceDir: ws,
      artifactsDir,
      agentPool: {
        getAgent: () => ({ agentName: "claude", agent: mockAgent }),
      },
      log: (e) => logEvents.push(e),
      config: {
        workflow: {
          timeouts: { planReview: 60_000 },
          wip: { push: false },
        },
      },
    };

    const result = await planReviewMachine.run({ round: 0 }, ctx);
    assert.equal(result.status, "error");
    assert.equal(call, 2);

    const missing = logEvents.filter(
      (e) => e.event === "critique_missing_after_review",
    );
    assert.equal(missing.length, 1);
    assert.ok(missing[0].critiquePath.includes("PLANREVIEW.md"));
    assert.ok(missing[0].planPath.includes("PLAN.md"));
    assert.equal(missing[0].stdoutLen, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
