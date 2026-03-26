import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRepoRoot } from "../src/machines/develop/_shared.js";
import {
  archiveFailureArtifacts,
  reconcileSteps,
} from "../src/state/issue-backup.js";
import {
  backupKeyFor,
  ensureCleanLoopStart,
  prepareForIssue,
  resetForNextIssue,
} from "../src/workflows/develop.workflow.js";

function makeTmpRepo() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "loop-cleanup-test-"));
  mkdirSync(path.join(tmp, ".coder", "artifacts"), { recursive: true });
  execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: tmp,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: tmp, stdio: "ignore" });
  writeFileSync(path.join(tmp, "README.md"), "# test\n");
  execSync("git add -A && git commit -m init", { cwd: tmp, stdio: "ignore" });
  return tmp;
}

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: stale state.json
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: removes stale state.json", async () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ steps: { wroteIssue: true, wrotePlan: true } }),
    );

    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.ok(!existsSync(statePath), "state.json should be deleted");
    assert.equal(logEvents.length, 1);
    assert.equal(logEvents[0].event, "loop_startup_cleanup");
    assert.equal(logEvents[0].state, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: stale artifact files
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: removes stale artifact files", async () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Old issue");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Old plan");
    writeFileSync(path.join(artifactsDir, "PLANREVIEW.md"), "# Old critique");

    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.ok(!existsSync(path.join(artifactsDir, "ISSUE.md")));
    assert.ok(!existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(!existsSync(path.join(artifactsDir, "PLANREVIEW.md")));
    assert.equal(logEvents[0].event, "loop_startup_cleanup");
    assert.equal(logEvents[0].artifacts, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: wrong branch
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: switches back to default branch from issue branch", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-42", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "new-file.js"), "console.log('hi');\n");
    execSync("git add -A && git commit -m 'issue work'", {
      cwd: tmp,
      stdio: "ignore",
    });

    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(branch, "main");
    assert.equal(logEvents[0].event, "loop_startup_cleanup");
    assert.equal(logEvents[0].branch, true);
    assert.equal(logEvents[0].previousBranch, "coder/issue-42");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: dirty worktree on default branch
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: cleans dirty worktree on default branch", async () => {
  const tmp = makeTmpRepo();
  try {
    writeFileSync(path.join(tmp, "untracked.txt"), "leftover");
    writeFileSync(path.join(tmp, "README.md"), "modified content");

    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.ok(
      !existsSync(path.join(tmp, "untracked.txt")),
      "untracked file should be removed",
    );
    const status = execSync("git status --porcelain", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    const nonCoderLines = status
      .split("\n")
      .filter((l) => l.trim() && !l.slice(3).startsWith(".coder/"));
    assert.equal(nonCoderLines.length, 0, "worktree should be clean");
    assert.equal(logEvents[0].worktree, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: wrong branch + uncommitted changes
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: recovers from wrong branch with uncommitted changes", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-99", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "wip.js"), "// work in progress");

    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(branch, "main");
    assert.ok(!existsSync(path.join(tmp, "wip.js")));
    assert.equal(logEvents[0].branch, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: no-op when clean
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: no-op when workspace is already clean", async () => {
  const tmp = makeTmpRepo();
  try {
    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.equal(logEvents.length, 0, "should not log when nothing to clean");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: preserves .coder/ directory
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: preserves .coder/ directory contents", async () => {
  const tmp = makeTmpRepo();
  try {
    const loopStatePath = path.join(tmp, ".coder", "loop-state.json");
    writeFileSync(
      loopStatePath,
      JSON.stringify({ status: "running", issueQueue: [] }),
    );

    writeFileSync(path.join(tmp, "untracked.txt"), "leftover");

    const logEvents = [];
    await ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.ok(existsSync(loopStatePath), "loop-state.json should be preserved");
    assert.ok(!existsSync(path.join(tmp, "untracked.txt")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: failure paths
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: throws when checkout to default branch fails", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-1", { cwd: tmp, stdio: "ignore" });

    const logEvents = [];
    await assert.rejects(
      () =>
        ensureCleanLoopStart(tmp, tmp, "nonexistent-branch", (e) =>
          logEvents.push(e),
        ),
      /could not checkout nonexistent-branch/,
    );
    assert.ok(
      logEvents.some((e) => e.event === "loop_startup_cleanup_failed"),
      "should log cleanup failure",
    );
    assert.equal(
      logEvents.find((e) => e.event === "loop_startup_cleanup_failed").step,
      "checkout_default_branch",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: does not emit success log when checkout fails", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-2", { cwd: tmp, stdio: "ignore" });

    const logEvents = [];
    try {
      await ensureCleanLoopStart(tmp, tmp, "nonexistent-branch", (e) =>
        logEvents.push(e),
      );
    } catch {
      // expected
    }
    assert.ok(
      !logEvents.some((e) => e.event === "loop_startup_cleanup"),
      "should not emit success log on failure",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: WIP auto-commit on known agent branches
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: auto-commits WIP on known agent branch", async () => {
  const tmp = makeTmpRepo();
  try {
    const branchName = "feat/add-auth_GH_42";
    execSync(`git checkout -b ${branchName}`, { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "wip.js"), "// work in progress");

    const logEvents = [];
    const knownBranches = new Set([branchName]);
    await ensureCleanLoopStart(
      tmp,
      tmp,
      "main",
      (e) => logEvents.push(e),
      knownBranches,
    );

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(currentBranch, "main", "should switch to default branch");

    // Verify WIP was committed on the agent branch, not discarded
    const wipLog = execSync(`git log ${branchName} --oneline -1`, {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.ok(
      wipLog.includes("wip: interrupted work"),
      `WIP commit should exist on ${branchName}, got: ${wipLog}`,
    );

    assert.equal(logEvents[0].event, "loop_startup_cleanup");
    assert.equal(logEvents[0].wipCommitted, true);
    assert.equal(logEvents[0].branch, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: discards dirty files on unknown branch", async () => {
  const tmp = makeTmpRepo();
  try {
    const branchName = "user/personal-branch";
    execSync(`git checkout -b ${branchName}`, { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "wip.js"), "// personal changes");

    const logEvents = [];
    const knownBranches = new Set(["feat/other-issue_GH_99"]);
    await ensureCleanLoopStart(
      tmp,
      tmp,
      "main",
      (e) => logEvents.push(e),
      knownBranches,
    );

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(currentBranch, "main");

    // Verify changes were discarded, not committed
    const branchLog = execSync(`git log ${branchName} --oneline`, {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.ok(
      !branchLog.includes("wip:"),
      "should NOT auto-commit on unknown branch",
    );

    assert.equal(logEvents[0].wipCommitted, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: with resume enabled preserves state and artifacts", async () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(
      statePath,
      JSON.stringify({ steps: { wroteIssue: true, wrotePlan: true } }),
    );
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Test");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan");

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
    };
    await ensureCleanLoopStart(
      tmp,
      tmp,
      "main",
      (e) => logEvents.push(e),
      new Set(),
      {
        ctx,
        issues: [],
        destructiveReset: false,
      },
    );

    assert.ok(existsSync(statePath), "state.json should be preserved");
    assert.ok(existsSync(path.join(artifactsDir, "ISSUE.md")));
    assert.ok(existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(
      logEvents.some((e) => e.event === "loop_startup_resume_preserved"),
      "should emit loop_startup_resume_preserved",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: prunes orphan backups only when resume enabled", async () => {
  const tmp = makeTmpRepo();
  try {
    const orphanBackup = path.join(tmp, ".coder", "backups", "github-99-root");
    mkdirSync(path.join(orphanBackup, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(orphanBackup, "state.json"),
      JSON.stringify({ selected: { source: "github", id: "99" } }),
    );

    const ctxWithResume = {
      config: { workflow: { resumeStepState: true } },
    };
    const ctxNoResume = {
      config: { workflow: { resumeStepState: false } },
    };

    await ensureCleanLoopStart(tmp, tmp, "main", () => {}, new Set(), {
      ctx: ctxWithResume,
      issues: [{ source: "github", id: "40", repo_path: "." }],
      destructiveReset: false,
    });
    assert.ok(
      !existsSync(orphanBackup),
      "orphan should be pruned when resume enabled",
    );

    mkdirSync(path.join(orphanBackup, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(orphanBackup, "state.json"),
      JSON.stringify({ selected: { source: "github", id: "99" } }),
    );
    await ensureCleanLoopStart(tmp, tmp, "main", () => {}, new Set(), {
      ctx: ctxNoResume,
      issues: [{ source: "github", id: "40", repo_path: "." }],
      destructiveReset: false,
    });
    assert.ok(
      existsSync(orphanBackup),
      "orphan should be kept when resume disabled",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: preserves legacy monorepo backup keys during prune", async () => {
  const tmp = makeTmpRepo();
  try {
    const legacyBackupKey = "github-42-root";
    const legacyBackupDir = path.join(
      tmp,
      ".coder",
      "backups",
      legacyBackupKey,
    );
    mkdirSync(path.join(legacyBackupDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(legacyBackupDir, "state.json"),
      JSON.stringify({
        selected: { source: "github", id: "42", repo_path: "." },
        steps: { wrotePlan: true },
      }),
    );
    writeFileSync(
      path.join(legacyBackupDir, "artifacts", "PLAN.md"),
      "# Legacy plan",
    );

    const ctxWithResume = {
      config: { workflow: { resumeStepState: true } },
    };
    await ensureCleanLoopStart(tmp, tmp, "main", () => {}, new Set(), {
      ctx: ctxWithResume,
      issues: [{ source: "github", id: "42", repo_path: "packages/foo" }],
      destructiveReset: false,
    });

    assert.ok(
      existsSync(legacyBackupDir),
      "legacy monorepo backup (root key) must be preserved for prepareForIssue to restore",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: with resumeStepState false deletes state and artifacts", async () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(
      statePath,
      JSON.stringify({ steps: { wroteIssue: true, wrotePlan: true } }),
    );
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan");

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: false } },
    };
    await ensureCleanLoopStart(
      tmp,
      tmp,
      "main",
      (e) => logEvents.push(e),
      new Set(),
      {
        ctx,
        issues: [],
        destructiveReset: false,
      },
    );

    assert.ok(!existsSync(statePath), "state.json should be deleted");
    assert.ok(!existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(
      logEvents.some((e) => e.event === "loop_startup_cleanup"),
      "should emit loop_startup_cleanup",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// prepareForIssue: step-level resume
// ---------------------------------------------------------------------------

test("prepareForIssue: resumes from current state when issue matches", async () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    const issue = { source: "github", id: "42", title: "Test" };
    writeFileSync(
      statePath,
      JSON.stringify({
        selected: { source: "github", id: "42", title: "Test" },
        steps: { wroteIssue: true, wrotePlan: true },
      }),
    );
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan");

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    assert.ok(existsSync(statePath), "state should be preserved");
    assert.ok(existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_detected" && e.from === "current",
      ),
      "should emit loop_resume_detected from current",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: restores from backup when backup exists and is consistent", async () => {
  const tmp = makeTmpRepo();
  try {
    const issue = { source: "github", id: "40", title: "Restore me" };
    const backupKey = "github-40-root";
    const backupDir = path.join(tmp, ".coder", "backups", backupKey);
    mkdirSync(path.join(backupDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(backupDir, "state.json"),
      JSON.stringify({
        selected: { source: "github", id: "40", title: "Restore me" },
        steps: { wroteIssue: true, wrotePlan: true },
      }),
    );
    writeFileSync(
      path.join(backupDir, "artifacts", "ISSUE.md"),
      "# Backup issue",
    );
    writeFileSync(
      path.join(backupDir, "artifacts", "PLAN.md"),
      "# Backup plan",
    );

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    assert.ok(existsSync(statePath), "state should be restored");
    assert.ok(existsSync(path.join(artifactsDir, "ISSUE.md")));
    assert.ok(existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_detected" && e.from === "backup",
      ),
      "should emit loop_resume_detected from backup",
    );
    assert.ok(!existsSync(backupDir), "backup should be consumed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("archiveFailureArtifacts: copies all artifacts to .coder/failures/", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue #34\n");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n");
    writeFileSync(
      path.join(artifactsDir, "PLANREVIEW.md"),
      "## Verdict\nREJECT\n\n## Critique\nToo vague.",
    );
    writeFileSync(
      path.join(artifactsDir, "REVIEW_FINDINGS.md"),
      "# Findings\nBug found.",
    );

    archiveFailureArtifacts(
      tmp,
      { source: "gitlab", id: "#34" },
      "plan_review_exhausted",
      { stage: "plan_review" },
    );

    const failuresDir = path.join(tmp, ".coder", "failures");
    assert.ok(existsSync(failuresDir));
    const entries = readdirSync(failuresDir);
    assert.ok(entries.length >= 1, "should have at least one archive dir");
    const archiveDir = path.join(failuresDir, entries[0]);
    assert.ok(entries[0].includes("34"), "archive dir should include issue id");
    assert.ok(existsSync(path.join(archiveDir, "PLAN.md")));
    assert.ok(existsSync(path.join(archiveDir, "PLANREVIEW.md")));
    assert.ok(existsSync(path.join(archiveDir, "ISSUE.md")));
    assert.ok(existsSync(path.join(archiveDir, "REVIEW_FINDINGS.md")));
    assert.ok(existsSync(path.join(archiveDir, "reason.txt")));
    const reasonTxt = readFileSync(path.join(archiveDir, "reason.txt"), "utf8");
    assert.ok(reasonTxt.includes("plan_review_exhausted"));
    assert.ok(reasonTxt.includes("stage: plan_review"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("archiveFailureArtifacts: archives even when only ISSUE.md exists (early-stage failure)", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue #99\n");

    archiveFailureArtifacts(tmp, { id: "#99" }, "failed");

    const failuresDir = path.join(tmp, ".coder", "failures");
    assert.ok(
      existsSync(failuresDir),
      "should archive even without PLANREVIEW.md",
    );
    const entries = readdirSync(failuresDir);
    assert.ok(entries.length >= 1);
    const archiveDir = path.join(failuresDir, entries[0]);
    assert.ok(existsSync(path.join(archiveDir, "ISSUE.md")));
    assert.ok(!existsSync(path.join(archiveDir, "PLAN.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("archiveFailureArtifacts: no-op when no artifacts exist at all", () => {
  const tmp = makeTmpRepo();
  try {
    archiveFailureArtifacts(tmp, { id: "#34" }, "failed");

    const failuresDir = path.join(tmp, ".coder", "failures");
    assert.ok(
      !existsSync(failuresDir),
      "should not create archive when no artifacts exist",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRepoRoot: file path resolves to its directory and logs correction", () => {
  const tmp = makeTmpRepo();
  try {
    const filePath = path.join(tmp, "lib", "foo", "bar.ex");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "# code\n", "utf8");

    // Capture stderr to verify logging
    const origWrite = process.stderr.write;
    const stderrChunks = [];
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };
    try {
      const fileRel = "lib/foo/bar.ex";
      const resolved = resolveRepoRoot(tmp, fileRel);
      assert.equal(resolved, path.join(tmp, "lib", "foo"));
      assert.ok(
        existsSync(resolved),
        "resolved path must exist and be a directory",
      );
      const logged = stderrChunks.join("");
      assert.ok(
        logged.includes("resolveRepoRoot: corrected file path"),
        "should log the file-to-directory correction",
      );
    } finally {
      process.stderr.write = origWrite;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("backupKeyFor: distinct repo_paths produce distinct keys (no collision)", () => {
  const keyA = backupKeyFor({
    source: "github",
    id: "42",
    repo_path: "packages/a-b",
  });
  const keyB = backupKeyFor({
    source: "github",
    id: "42",
    repo_path: "packages/a/b",
  });
  assert.notEqual(keyA, keyB, "packages/a-b and packages/a/b must not collide");
});

test("prepareForIssue: does not restore when repo_path differs (repo-scoped backup)", async () => {
  const tmp = makeTmpRepo();
  try {
    const issue = {
      source: "github",
      id: "42",
      title: "Repo B",
      repo_path: "packages/b",
    };
    const backupKey = "github-42-root";
    const backupDir = path.join(tmp, ".coder", "backups", backupKey);
    mkdirSync(path.join(backupDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(backupDir, "state.json"),
      JSON.stringify({
        selected: { source: "github", id: "42", repo_path: "" },
        steps: { wrotePlan: true },
      }),
    );
    writeFileSync(path.join(backupDir, "artifacts", "PLAN.md"), "# Root plan");

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    assert.ok(
      !logEvents.some((e) => e.event === "loop_resume_detected"),
      "should not resume from backup when repo_path differs",
    );
    const statePath = path.join(tmp, ".coder", "state.json");
    assert.ok(!existsSync(statePath), "should clear, not restore wrong repo");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: backs up then clears when switching to different issue", async () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(
      statePath,
      JSON.stringify({
        selected: { source: "github", id: "39", title: "Prior" },
        steps: { wroteIssue: true, wrotePlan: true },
      }),
    );
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Prior");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Prior plan");

    const issue = { source: "github", id: "40", title: "New", repo_path: "" };
    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    assert.ok(!existsSync(statePath), "state should be cleared");
    assert.ok(!existsSync(path.join(artifactsDir, "PLAN.md")));
    const backupDir = path.join(tmp, ".coder", "backups", "github-39-root");
    assert.ok(
      existsSync(path.join(backupDir, "state.json")),
      "prior should be backed up",
    );
    assert.ok(existsSync(path.join(backupDir, "artifacts", "PLAN.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCleanLoopStart: no WIP commit when known branch is clean", async () => {
  const tmp = makeTmpRepo();
  try {
    const branchName = "feat/clean-branch_GH_50";
    execSync(`git checkout -b ${branchName}`, { cwd: tmp, stdio: "ignore" });
    // No dirty files

    const logEvents = [];
    const knownBranches = new Set([branchName]);
    await ensureCleanLoopStart(
      tmp,
      tmp,
      "main",
      (e) => logEvents.push(e),
      knownBranches,
    );

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(currentBranch, "main");

    const branchLog = execSync(`git log ${branchName} --oneline`, {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.ok(!branchLog.includes("wip:"), "no WIP commit on clean branch");

    assert.equal(logEvents[0].wipCommitted, false);
    assert.equal(logEvents[0].branch, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resetForNextIssue
// ---------------------------------------------------------------------------

test("resetForNextIssue: commits WIP on failed issue branch then switches to main", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-10", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "partial.js"), "// partial work");

    await resetForNextIssue(tmp, ".", { issueStatus: "failed" });

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(currentBranch, "main", "should switch to default branch");

    const wipLog = execSync("git log coder/issue-10 --oneline -1", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.ok(
      wipLog.includes("wip: partial work"),
      `should commit WIP, got: ${wipLog}`,
    );

    const status = execSync("git status --porcelain", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(status, "", "worktree should be clean after reset");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resetForNextIssue: discards stray changes for completed issues", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-11", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "stray.js"), "// leftover");

    await resetForNextIssue(tmp, ".", { issueStatus: "completed" });

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.equal(currentBranch, "main");

    const branchLog = execSync("git log coder/issue-11 --oneline", {
      cwd: tmp,
      encoding: "utf8",
    }).trim();
    assert.ok(
      !branchLog.includes("wip:"),
      "should NOT commit for completed issues",
    );

    assert.ok(!existsSync(path.join(tmp, "stray.js")), "stray file removed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resetForNextIssue: cleans untracked files after switching to main", async () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-12", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "new-file.txt"), "untracked");
    execSync("git add -A && git commit -m 'add file'", {
      cwd: tmp,
      stdio: "ignore",
    });

    await resetForNextIssue(tmp, ".", { issueStatus: "completed" });

    assert.ok(
      !existsSync(path.join(tmp, "new-file.txt")),
      "files from issue branch should not leak to main",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resetForNextIssue: removes stale artifacts and state", async () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# old plan");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# old issue");
    const statePath = path.join(tmp, ".coder", "state.json");
    writeFileSync(statePath, JSON.stringify({ steps: { wrotePlan: true } }));

    await resetForNextIssue(tmp, ".", { issueStatus: "completed" });

    assert.ok(!existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(!existsSync(path.join(artifactsDir, "ISSUE.md")));
    assert.ok(!existsSync(statePath));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: restoring backup clears sessionsDisabled and stale session IDs", async () => {
  const tmp = makeTmpRepo();
  try {
    const issue = { source: "github", id: "99", title: "Session test" };
    const backupKey = "github-99-root";
    const backupDir = path.join(tmp, ".coder", "backups", backupKey);
    mkdirSync(path.join(backupDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(backupDir, "state.json"),
      JSON.stringify({
        selected: { source: "github", id: "99", title: "Session test" },
        repoPath: ".",
        steps: { wroteIssue: true, wrotePlan: true },
        sessionsDisabled: true,
        planningSessionId: "old-session-1",
        implementationSessionId: "old-session-2",
        planReviewSessionId: "old-session-3",
        programmerFixSessionId: null,
        reviewerSessionId: null,
      }),
    );
    writeFileSync(path.join(backupDir, "artifacts", "ISSUE.md"), "# Issue\n");
    writeFileSync(path.join(backupDir, "artifacts", "PLAN.md"), "# Plan\n");

    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: () => {},
    };

    await prepareForIssue(tmp, issue, ctx);

    const state = JSON.parse(
      readFileSync(path.join(tmp, ".coder", "state.json"), "utf8"),
    );
    assert.equal(
      state.sessionsDisabled,
      false,
      "sessionsDisabled should be cleared on backup restore",
    );
    assert.equal(
      state.planningSessionId,
      null,
      "stale planningSessionId cleared",
    );
    assert.equal(
      state.implementationSessionId,
      null,
      "stale implementationSessionId cleared",
    );
    assert.equal(
      state.planReviewSessionId,
      null,
      "stale planReviewSessionId cleared",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reconcileSteps
// ---------------------------------------------------------------------------

test("reconcileSteps: all artifacts present — no rollback", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n");
    writeFileSync(path.join(artifactsDir, "PLANREVIEW.md"), "# Critique\n");
    writeFileSync(
      path.join(artifactsDir, "REVIEW_FINDINGS.md"),
      "# Findings\n",
    );

    const steps = {
      wroteIssue: true,
      wrotePlan: true,
      wroteCritique: true,
      implemented: true,
      reviewerCompleted: true,
    };
    const result = reconcileSteps(steps, artifactsDir);
    assert.equal(result.rolledBack.length, 0);
    assert.equal(result.steps.wroteIssue, true);
    assert.equal(result.steps.reviewerCompleted, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcileSteps: ISSUE.md missing — full reset", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n");

    const steps = { wroteIssue: true, wrotePlan: true };
    const result = reconcileSteps(steps, artifactsDir);
    assert.deepEqual(result.steps, {});
    assert.ok(result.rolledBack.includes("wroteIssue"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcileSteps: PLAN.md missing — keeps issue, clears plan and downstream", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n");
    // No PLAN.md

    const steps = {
      wroteIssue: true,
      wrotePlan: true,
      wroteCritique: true,
      implemented: true,
      reviewerCompleted: true,
      reviewRound: 2,
      testsPassed: true,
    };
    const result = reconcileSteps(steps, artifactsDir);
    assert.ok(result.rolledBack.includes("wrotePlan"));
    assert.equal(result.steps.wroteIssue, true, "issue preserved");
    assert.equal(result.steps.wrotePlan, false, "plan cleared");
    assert.equal(result.steps.wroteCritique, false, "critique cleared");
    assert.equal(result.steps.implemented, false, "implementation cleared");
    assert.equal(result.steps.reviewRound, undefined, "review round cleared");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcileSteps: PLANREVIEW.md missing — keeps issue+plan, clears critique downstream", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n");
    // No PLANREVIEW.md

    const steps = {
      wroteIssue: true,
      wrotePlan: true,
      wroteCritique: true,
      implemented: true,
    };
    const result = reconcileSteps(steps, artifactsDir);
    assert.ok(result.rolledBack.includes("wroteCritique"));
    assert.equal(result.steps.wroteIssue, true, "issue preserved");
    assert.equal(result.steps.wrotePlan, true, "plan preserved");
    assert.equal(result.steps.wroteCritique, false, "critique cleared");
    assert.equal(result.steps.implemented, false, "implementation cleared");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcileSteps: null steps — returns empty", () => {
  const result = reconcileSteps(null, "/tmp/nonexistent");
  assert.deepEqual(result.steps, {});
  assert.equal(result.rolledBack.length, 0);
});

test("reconcileSteps: removes stale downstream artifacts when plan rolled back", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n");
    // PLAN.md missing, but stale downstream artifacts exist
    writeFileSync(path.join(artifactsDir, "PLANREVIEW.md"), "# Stale\n");
    writeFileSync(path.join(artifactsDir, "REVIEW_FINDINGS.md"), "# Stale\n");

    const steps = {
      wroteIssue: true,
      wrotePlan: true,
      wroteCritique: true,
      reviewerCompleted: true,
    };
    reconcileSteps(steps, artifactsDir);
    assert.ok(
      !existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
      "stale PLANREVIEW.md should be deleted",
    );
    assert.ok(
      !existsSync(path.join(artifactsDir, "REVIEW_FINDINGS.md")),
      "stale REVIEW_FINDINGS.md should be deleted",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcileSteps: removes stale REVIEW_FINDINGS.md when critique rolled back", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n");
    // PLANREVIEW.md missing, but stale REVIEW_FINDINGS.md exists
    writeFileSync(path.join(artifactsDir, "REVIEW_FINDINGS.md"), "# Stale\n");

    const steps = {
      wroteIssue: true,
      wrotePlan: true,
      wroteCritique: true,
      reviewerCompleted: true,
    };
    reconcileSteps(steps, artifactsDir);
    assert.ok(
      !existsSync(path.join(artifactsDir, "REVIEW_FINDINGS.md")),
      "stale REVIEW_FINDINGS.md should be deleted",
    );
    assert.ok(
      existsSync(path.join(artifactsDir, "PLAN.md")),
      "PLAN.md should be preserved",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// prepareForIssue: partial resume
// ---------------------------------------------------------------------------

test("prepareForIssue: partial resume when PLAN.md missing from backup", async () => {
  const tmp = makeTmpRepo();
  try {
    const issue = { source: "github", id: "50", title: "Partial" };
    const backupKey = "github-50-root";
    const backupDir = path.join(tmp, ".coder", "backups", backupKey);
    mkdirSync(path.join(backupDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(backupDir, "state.json"),
      JSON.stringify({
        selected: { source: "github", id: "50", title: "Partial" },
        steps: { wroteIssue: true, wrotePlan: true, wroteCritique: true },
      }),
    );
    // Only ISSUE.md in backup — PLAN.md missing
    writeFileSync(
      path.join(backupDir, "artifacts", "ISSUE.md"),
      "# Issue 50\n",
    );

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    // Should have restored and partially resumed
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    assert.ok(
      existsSync(path.join(artifactsDir, "ISSUE.md")),
      "ISSUE.md restored",
    );
    assert.ok(
      !existsSync(path.join(artifactsDir, "PLAN.md")),
      "PLAN.md not restored",
    );

    const state = JSON.parse(
      readFileSync(path.join(tmp, ".coder", "state.json"), "utf8"),
    );
    assert.equal(state.steps.wroteIssue, true, "issue step preserved");
    assert.equal(state.steps.wrotePlan, false, "plan step rolled back");
    assert.equal(state.steps.wroteCritique, false, "critique step rolled back");

    assert.ok(
      logEvents.some((e) => e.event === "loop_resume_partial"),
      "should emit loop_resume_partial",
    );
    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_detected" && e.from === "backup",
      ),
      "should still emit loop_resume_detected",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: partial resume from current state when PLAN.md deleted", async () => {
  const tmp = makeTmpRepo();
  try {
    const issue = { source: "github", id: "51", title: "Current partial" };
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");

    writeFileSync(
      statePath,
      JSON.stringify({
        selected: { source: "github", id: "51", title: "Current partial" },
        steps: { wroteIssue: true, wrotePlan: true, wroteCritique: true },
      }),
    );
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue 51\n");
    // PLAN.md intentionally missing

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    assert.ok(
      existsSync(path.join(artifactsDir, "ISSUE.md")),
      "ISSUE.md preserved",
    );

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.steps.wroteIssue, true, "issue step preserved");
    assert.equal(state.steps.wrotePlan, false, "plan step rolled back");

    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_partial" && e.from === "current",
      ),
      "should emit loop_resume_partial from current",
    );
    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_detected" && e.from === "current",
      ),
      "should still emit loop_resume_detected",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: does not archive completed issues to failures on switch", async () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(
      statePath,
      JSON.stringify({
        selected: { source: "github", id: "60", title: "Done" },
        steps: { wroteIssue: true, wrotePlan: true, prCreated: true },
      }),
    );
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Done");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan done");

    const newIssue = { source: "github", id: "61", title: "Next" };
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: () => {},
    };

    await prepareForIssue(tmp, newIssue, ctx);

    const failuresDir = path.join(tmp, ".coder", "failures");
    assert.ok(
      !existsSync(failuresDir),
      "should not archive completed issue to failures",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
