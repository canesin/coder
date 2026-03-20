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
import { resolveRepoRoot } from "../src/machines/develop/_shared.js";
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

test("ensureCleanLoopStart: removes stale state.json", () => {
  const tmp = makeTmpRepo();
  try {
    const statePath = path.join(tmp, ".coder", "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ steps: { wroteIssue: true, wrotePlan: true } }),
    );

    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

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

test("ensureCleanLoopStart: removes stale artifact files", () => {
  const tmp = makeTmpRepo();
  try {
    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Old issue");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Old plan");
    writeFileSync(path.join(artifactsDir, "PLANREVIEW.md"), "# Old critique");

    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

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

test("ensureCleanLoopStart: switches back to default branch from issue branch", () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-42", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "new-file.js"), "console.log('hi');\n");
    execSync("git add -A && git commit -m 'issue work'", {
      cwd: tmp,
      stdio: "ignore",
    });

    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

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

test("ensureCleanLoopStart: cleans dirty worktree on default branch", () => {
  const tmp = makeTmpRepo();
  try {
    writeFileSync(path.join(tmp, "untracked.txt"), "leftover");
    writeFileSync(path.join(tmp, "README.md"), "modified content");

    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

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

test("ensureCleanLoopStart: recovers from wrong branch with uncommitted changes", () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-99", { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "wip.js"), "// work in progress");

    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

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

test("ensureCleanLoopStart: no-op when workspace is already clean", () => {
  const tmp = makeTmpRepo();
  try {
    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.equal(logEvents.length, 0, "should not log when nothing to clean");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: preserves .coder/ directory
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: preserves .coder/ directory contents", () => {
  const tmp = makeTmpRepo();
  try {
    const loopStatePath = path.join(tmp, ".coder", "loop-state.json");
    writeFileSync(
      loopStatePath,
      JSON.stringify({ status: "running", issueQueue: [] }),
    );

    writeFileSync(path.join(tmp, "untracked.txt"), "leftover");

    const logEvents = [];
    ensureCleanLoopStart(tmp, tmp, "main", (e) => logEvents.push(e));

    assert.ok(existsSync(loopStatePath), "loop-state.json should be preserved");
    assert.ok(!existsSync(path.join(tmp, "untracked.txt")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureCleanLoopStart: failure paths
// ---------------------------------------------------------------------------

test("ensureCleanLoopStart: throws when checkout to default branch fails", () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-1", { cwd: tmp, stdio: "ignore" });

    const logEvents = [];
    assert.throws(
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

test("ensureCleanLoopStart: does not emit success log when checkout fails", () => {
  const tmp = makeTmpRepo();
  try {
    execSync("git checkout -b coder/issue-2", { cwd: tmp, stdio: "ignore" });

    const logEvents = [];
    try {
      ensureCleanLoopStart(tmp, tmp, "nonexistent-branch", (e) =>
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

test("ensureCleanLoopStart: auto-commits WIP on known agent branch", () => {
  const tmp = makeTmpRepo();
  try {
    const branchName = "feat/add-auth_GH_42";
    execSync(`git checkout -b ${branchName}`, { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "wip.js"), "// work in progress");

    const logEvents = [];
    const knownBranches = new Set([branchName]);
    ensureCleanLoopStart(
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

test("ensureCleanLoopStart: discards dirty files on unknown branch", () => {
  const tmp = makeTmpRepo();
  try {
    const branchName = "user/personal-branch";
    execSync(`git checkout -b ${branchName}`, { cwd: tmp, stdio: "ignore" });
    writeFileSync(path.join(tmp, "wip.js"), "// personal changes");

    const logEvents = [];
    const knownBranches = new Set(["feat/other-issue_GH_99"]);
    ensureCleanLoopStart(
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

test("ensureCleanLoopStart: with resume enabled preserves state and artifacts", () => {
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
    ensureCleanLoopStart(
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

test("ensureCleanLoopStart: prunes orphan backups only when resume enabled", () => {
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

    ensureCleanLoopStart(tmp, tmp, "main", () => {}, new Set(), {
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
    ensureCleanLoopStart(tmp, tmp, "main", () => {}, new Set(), {
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

test("ensureCleanLoopStart: preserves legacy monorepo backup keys during prune", () => {
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
    ensureCleanLoopStart(tmp, tmp, "main", () => {}, new Set(), {
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

test("ensureCleanLoopStart: with resumeStepState false deletes state and artifacts", () => {
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
    ensureCleanLoopStart(
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

test("ensureCleanLoopStart: no WIP commit when known branch is clean", () => {
  const tmp = makeTmpRepo();
  try {
    const branchName = "feat/clean-branch_GH_50";
    execSync(`git checkout -b ${branchName}`, { cwd: tmp, stdio: "ignore" });
    // No dirty files

    const logEvents = [];
    const knownBranches = new Set([branchName]);
    ensureCleanLoopStart(
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
