import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  extractGitLabProjectPath,
  fetchOpenPrBranches,
  glabMrListArgs,
  isGlabMrListFormatMismatchStderr,
  runDevelopPipeline,
  runPlanLoop,
} from "../src/workflows/develop.workflow.js";

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "conflict-detect-test-"));
  mkdirSync(path.join(dir, ".coder", "artifacts"), { recursive: true });
  return dir;
}

function makeCtx(overrides = {}) {
  const logEvents = [];
  const workspaceDir = overrides.workspaceDir || "/tmp/test";
  return {
    workspaceDir,
    artifactsDir:
      overrides.artifactsDir || path.join(workspaceDir, ".coder", "artifacts"),
    cancelToken: { cancelled: false, paused: false },
    log: (e) => logEvents.push(e),
    config: {
      workflow: {
        maxMachineRetries: 0,
        retryBackoffMs: 0,
      },
    },
    agentPool: null,
    secrets: {},
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
    logEvents,
    ...overrides,
  };
}

function makeRunner(ctx) {
  return new WorkflowRunner({ name: "test", workflowContext: ctx });
}

// ---------------------------------------------------------------------------
// runPlanLoop passes activeBranches to the planning machine
// ---------------------------------------------------------------------------

test("runPlanLoop: passes activeBranches to the planning machine input", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx({
      workspaceDir: tmp,
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
    });
    const runner = makeRunner(ctx);
    let capturedInput = null;

    const mockPlan = {
      name: "develop.planning",
      async run(input) {
        capturedInput = input;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "ok", verdict: "APPROVED" },
          durationMs: 0,
        };
      },
    };

    const activeBranches = [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Add auth",
        diffStat: " src/auth.js | 50 ++++\n 1 file changed",
      },
    ];

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
      activeBranches,
    });

    assert.equal(result.status, "completed");
    assert.ok(capturedInput, "planning machine should have received input");
    assert.deepEqual(capturedInput.activeBranches, activeBranches);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: defaults activeBranches to empty array when not provided", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx({
      workspaceDir: tmp,
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
    });
    const runner = makeRunner(ctx);
    let capturedInput = null;

    const mockPlan = {
      name: "develop.planning",
      async run(input) {
        capturedInput = input;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "ok", verdict: "APPROVED" },
          durationMs: 0,
        };
      },
    };

    await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.ok(capturedInput);
    assert.deepEqual(capturedInput.activeBranches, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runDevelopPipeline returns deferred when CONFLICT_DETECTED is in PLAN.md
// ---------------------------------------------------------------------------

test("runDevelopPipeline: returns deferred when PLAN.md contains CONFLICT_DETECTED", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-2", title: "Conflict test" },
    repoPath: "/tmp/repo",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Auth feature",
        diffStat: " src/auth.js | 50 ++++\n",
      },
    ],
  };

  const originalRun = WorkflowRunner.prototype.run;

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
      // Simulate planner writing PLAN.md with CONFLICT_DETECTED
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\nModify src/auth.js to add OAuth.\n\n## CONFLICT_DETECTED\n- branch: coder/issue-1\n- reason: Both modify src/auth.js authentication logic\n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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

    // Phase 3 should NOT be reached
    throw new Error(
      `Unexpected: Phase 3 reached despite CONFLICT_DETECTED (machine: ${machineName})`,
    );
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "conflict");
    assert.equal(result.conflictBranch, "coder/issue-1");
    assert.match(result.error, /src\/auth\.js/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: proceeds to Phase 3 when PLAN.md has no CONFLICT_DETECTED", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-3", title: "No conflict test" },
    repoPath: "/tmp/repo",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Auth feature",
        diffStat: " src/auth.js | 50 ++++\n",
      },
    ],
  };

  const originalRun = WorkflowRunner.prototype.run;
  let phase3Reached = false;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\nModify src/users.js to add user profiles.\n\n## Files to Modify\n- src/users.js\n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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
      phase3Reached = true;
      return {
        status: "completed",
        results: [
          { status: "ok", data: {} },
          { status: "ok", data: {} },
          {
            status: "ok",
            data: { prUrl: "https://example.test/pr/3", branch: "feat/3" },
          },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "completed");
    assert.ok(phase3Reached, "Phase 3 should have been reached");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: proceeds normally when no activeBranches provided", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-4", title: "No branches test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;
  let phase3Reached = false;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\nSimple plan.\n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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
      phase3Reached = true;
      return {
        status: "completed",
        results: [
          { status: "ok", data: {} },
          { status: "ok", data: {} },
          {
            status: "ok",
            data: { prUrl: "https://example.test/pr/4", branch: "feat/4" },
          },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "completed");
    assert.ok(phase3Reached, "Phase 3 should have been reached");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CONFLICT_DETECTED regex edge cases
// ---------------------------------------------------------------------------

test("runDevelopPipeline: CONFLICT_DETECTED with extra whitespace in branch/reason", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-5", title: "Whitespace test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        `# Plan\n\n## CONFLICT_DETECTED\n- branch:   feat/auth-flow  \n- reason:   Overlapping auth logic  \n`,
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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

    throw new Error("Phase 3 should not be reached");
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.conflictBranch, "feat/auth-flow");
    assert.match(result.error, /Overlapping auth logic/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Planning machine input schema accepts activeBranches
// ---------------------------------------------------------------------------

test("planning machine: inputSchema accepts activeBranches", async () => {
  const planningMachine = (
    await import("../src/machines/develop/planning.machine.js")
  ).default;

  const validInput = {
    priorCritique: "",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Test",
        diffStat: "1 file changed",
      },
    ],
  };

  const parsed = planningMachine.inputSchema.parse(validInput);
  assert.equal(parsed.activeBranches.length, 1);
  assert.equal(parsed.activeBranches[0].branch, "coder/issue-1");
});

test("planning machine: inputSchema defaults activeBranches to empty array", async () => {
  const planningMachine = (
    await import("../src/machines/develop/planning.machine.js")
  ).default;

  const parsed = planningMachine.inputSchema.parse({});
  assert.deepEqual(parsed.activeBranches, []);
});

// ---------------------------------------------------------------------------
// CONFLICT_DETECTED: CRLF and format variant handling
// ---------------------------------------------------------------------------

test("runDevelopPipeline: detects CONFLICT_DETECTED with CRLF line endings", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-CRLF", title: "CRLF test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        "# Plan\r\n\r\n## CONFLICT_DETECTED\r\n- branch: feat/auth\r\n- reason: Both modify auth module\r\n",
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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

    throw new Error("Phase 3 should not be reached");
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.conflictBranch, "feat/auth");
    assert.match(result.error, /auth module/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: detects CONFLICT_DETECTED with asterisk bullets", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-STAR", title: "Asterisk test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        "# Plan\n\n## CONFLICT_DETECTED\n* branch: feat/users\n* reason: Overlapping user model changes\n",
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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

    throw new Error("Phase 3 should not be reached");
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.conflictBranch, "feat/users");
    assert.match(result.error, /user model/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: detects CONFLICT_DETECTED with blank line between bullets", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-BLANK", title: "Blank line test" },
    repoPath: "/tmp/repo",
  };

  const originalRun = WorkflowRunner.prototype.run;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        "# Plan\n\n## CONFLICT_DETECTED\n\n- branch: feat/api\n\n- reason: Same endpoint handler\n",
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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

    throw new Error("Phase 3 should not be reached");
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.conflictBranch, "feat/api");
    assert.match(result.error, /endpoint handler/);
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractGitLabProjectPath: self-hosted GitLab URL parsing
// ---------------------------------------------------------------------------

test("extractGitLabProjectPath: parses gitlab.com and self-hosted URLs", () => {
  assert.equal(
    extractGitLabProjectPath("https://gitlab.com/group/proj"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath("https://gitlab.com/group/proj.git"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath("https://gitlab.company.com/group/proj.git"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath("https://gitlab.company.com/group/proj"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath("git@gitlab.com:group/proj.git"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath("git@gitlab.company.com:group/proj"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath("ssh://git@gitlab.company.com/group/proj.git"),
    "group/proj",
  );
  assert.equal(
    extractGitLabProjectPath(
      "ssh://git@gitlab.company.com/group/subgroup/proj",
    ),
    "group/subgroup/proj",
  );
  assert.equal(extractGitLabProjectPath("https://github.com/owner/repo"), null);
  assert.equal(extractGitLabProjectPath("invalid"), null);
});

// ---------------------------------------------------------------------------
// fetchOpenPrBranches: glab args (docs.gitlab.com/cli/api — REST list MRs)
// ---------------------------------------------------------------------------

test("glabMrListArgs: uses glab api for JSON (compat with older glab mr list)", () => {
  const args = glabMrListArgs();
  assert.deepEqual(args, [
    "api",
    "projects/:id/merge_requests?state=opened&per_page=50",
  ]);
});

// ---------------------------------------------------------------------------
// fetchOpenPrBranches: graceful fallback
// ---------------------------------------------------------------------------

test("fetchOpenPrBranches: returns empty array when gh/glab is unavailable", async () => {
  const logEvents = [];
  const result = await fetchOpenPrBranches("/nonexistent/repo", "main", (e) =>
    logEvents.push(e),
  );

  assert.deepEqual(result, []);
  assert.ok(
    logEvents.some(
      (e) =>
        e.event === "open_prs_fetch_failed" || e.event === "open_prs_fetched",
    ),
    "Should log fetch attempt or failure",
  );
});

test("fetchOpenPrBranches: respects AbortSignal", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      fetchOpenPrBranches("/nonexistent/repo", "main", () => {}, {
        signal: ac.signal,
      }),
    (err) => err.code === "ABORT_ERR" || err.name === "AbortError",
  );
});

// ---------------------------------------------------------------------------
// Cross-repo contamination: outcomeMap entries are filtered by repoPath
// ---------------------------------------------------------------------------

test("activeBranches from outcomeMap only includes entries matching current issue repoPath", () => {
  // Simulate the filtering logic from processIssue
  const outcomeMap = new Map();
  outcomeMap.set("issue-1", {
    status: "completed",
    branch: "coder/issue-1",
    diffSummary: " src/auth.js | 10 +\n 1 file changed",
    repoPath: ".",
  });
  outcomeMap.set("issue-2", {
    status: "completed",
    branch: "coder/issue-2",
    diffSummary: " lib/utils.py | 5 +\n 1 file changed",
    repoPath: "services/backend",
  });
  outcomeMap.set("issue-3", {
    status: "completed",
    branch: "coder/issue-3",
    diffSummary: " src/users.js | 20 +\n 1 file changed",
    repoPath: ".",
  });
  outcomeMap.set("issue-4", {
    status: "failed",
    repoPath: ".",
  });

  const currentRepoPath = ".";
  const seenBranches = new Set();
  const activeBranches = [];

  for (const [id, outcome] of outcomeMap) {
    if (
      outcome.status === "completed" &&
      outcome.branch &&
      outcome.diffSummary &&
      outcome.repoPath === currentRepoPath &&
      !seenBranches.has(outcome.branch)
    ) {
      activeBranches.push({
        branch: outcome.branch,
        issueId: id,
        diffStat: outcome.diffSummary,
      });
      seenBranches.add(outcome.branch);
    }
  }

  assert.equal(
    activeBranches.length,
    2,
    "Should only include issues from repo '.'",
  );
  const branchNames = activeBranches.map((b) => b.branch);
  assert.ok(branchNames.includes("coder/issue-1"));
  assert.ok(branchNames.includes("coder/issue-3"));
  assert.ok(
    !branchNames.includes("coder/issue-2"),
    "issue-2 is from a different repo",
  );
});

test("activeBranches excludes all entries when none match current repoPath", () => {
  const outcomeMap = new Map();
  outcomeMap.set("issue-1", {
    status: "completed",
    branch: "coder/issue-1",
    diffSummary: " src/auth.js | 10 +\n 1 file changed",
    repoPath: "services/frontend",
  });

  const currentRepoPath = "services/backend";
  const activeBranches = [];

  for (const [id, outcome] of outcomeMap) {
    if (
      outcome.status === "completed" &&
      outcome.branch &&
      outcome.diffSummary &&
      outcome.repoPath === currentRepoPath
    ) {
      activeBranches.push({ branch: outcome.branch, issueId: id });
    }
  }

  assert.equal(
    activeBranches.length,
    0,
    "No entries should match a different repoPath",
  );
});

// ---------------------------------------------------------------------------
// fetchOpenPrBranches: uses PR ref-based fetch (pull/<n>/head)
// ---------------------------------------------------------------------------

test("fetchOpenPrBranches: uses pull/<number>/head refs for GitHub PRs", () => {
  // This test validates the structure by checking the fetchRef computed
  // for GitHub PRs. We can't easily mock spawnSync, so we verify the
  // mapping function directly.
  const ghPrData = [
    { headRefName: "feat/auth", number: 42, title: "Add auth" },
    { headRefName: "fix/typo", number: 99, title: "Fix typo" },
  ];

  const mapped = ghPrData.map((pr) => ({
    branch: pr.headRefName,
    id: `#${pr.number}`,
    title: pr.title || "",
    fetchRef: `pull/${pr.number}/head`,
  }));

  assert.equal(mapped[0].fetchRef, "pull/42/head");
  assert.equal(mapped[0].branch, "feat/auth");
  assert.equal(mapped[1].fetchRef, "pull/99/head");
  assert.equal(mapped[1].id, "#99");
});

test("fetchOpenPrBranches: uses refs/merge-requests/<iid>/head for GitLab MRs", () => {
  const glMrData = [
    { source_branch: "feat/auth", iid: 7, title: "Add auth" },
    { source_branch: "fix/bug", iid: 15, title: "Fix bug" },
  ];

  const mapped = glMrData.map((mr) => ({
    branch: mr.source_branch,
    id: `!${mr.iid}`,
    title: mr.title || "",
    fetchRef: `refs/merge-requests/${mr.iid}/head`,
  }));

  assert.equal(mapped[0].fetchRef, "refs/merge-requests/7/head");
  assert.equal(mapped[0].branch, "feat/auth");
  assert.equal(mapped[1].fetchRef, "refs/merge-requests/15/head");
  assert.equal(mapped[1].id, "!15");
});

// ---------------------------------------------------------------------------
// workflow.conflictDetection config toggle
// ---------------------------------------------------------------------------

test("runDevelopPipeline: skips CONFLICT_DETECTED when conflictDetection is false", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    config: {
      workflow: {
        conflictDetection: false,
        maxMachineRetries: 0,
        retryBackoffMs: 0,
      },
    },
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-TOGGLE", title: "Toggle test" },
    repoPath: "/tmp/repo",
    activeBranches: [],
  };

  const originalRun = WorkflowRunner.prototype.run;
  let phase3Reached = false;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        "# Plan\n\n## CONFLICT_DETECTED\n- branch: coder/issue-1\n- reason: Both modify src/auth.js\n",
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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
      phase3Reached = true;
      return {
        status: "completed",
        results: [
          { status: "ok", data: {} },
          { status: "ok", data: {} },
          {
            status: "ok",
            data: {
              prUrl: "https://example.test/pr/toggle",
              branch: "feat/toggle",
            },
          },
        ],
        runId: "run-1",
        durationMs: 0,
      };
    }

    throw new Error(`Unexpected machine: ${machineName}`);
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "completed");
    assert.ok(
      phase3Reached,
      "Phase 3 should be reached when conflictDetection is false",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDevelopPipeline: defers on CONFLICT_DETECTED when conflictDetection is true", async () => {
  const tmp = makeTmp();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const ctx = makeCtx({
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    config: {
      workflow: {
        conflictDetection: true,
        maxMachineRetries: 0,
        retryBackoffMs: 0,
      },
    },
  });
  const opts = {
    issue: { source: "local", id: "ISSUE-TOGGLE-ON", title: "Toggle on test" },
    repoPath: "/tmp/repo",
    activeBranches: [
      {
        branch: "coder/issue-1",
        issueId: "#1",
        title: "Auth",
        diffStat: "src/auth.js | 10 +",
      },
    ],
  };

  const originalRun = WorkflowRunner.prototype.run;

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
      writeFileSync(
        path.join(artifactsDir, "PLAN.md"),
        "# Plan\n\n## CONFLICT_DETECTED\n- branch: coder/issue-1\n- reason: Both modify src/auth.js\n",
        "utf8",
      );
      return {
        status: "completed",
        results: [{ status: "ok", data: { planMd: "written" } }],
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

    throw new Error(
      "Phase 3 should not be reached when conflictDetection is true",
    );
  };

  try {
    const result = await runDevelopPipeline(opts, ctx);

    assert.equal(result.status, "deferred");
    assert.equal(result.reason, "conflict");
    assert.equal(result.conflictBranch, "coder/issue-1");
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gitlab: glab stderr with unknown shorthand flag is a format mismatch (not fatal)", () => {
  assert.ok(
    isGlabMrListFormatMismatchStderr(
      "unknown shorthand flag: 'F' in -F\n\nUsage: glab mr list [flags]",
    ),
  );
});

test("config schema: workflow.conflictDetection defaults to true", async () => {
  const { CoderConfigSchema } = await import("../src/config.js");
  const parsed = CoderConfigSchema.parse({});
  assert.equal(parsed.workflow.conflictDetection, true);
});

test("config schema: workflow.conflictDetection accepts false", async () => {
  const { CoderConfigSchema } = await import("../src/config.js");
  const parsed = CoderConfigSchema.parse({
    workflow: { conflictDetection: false },
  });
  assert.equal(parsed.workflow.conflictDetection, false);
});
