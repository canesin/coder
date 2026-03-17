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
import issueDraftMachine from "../src/machines/develop/issue-draft.machine.js";
import { saveState } from "../src/state/workflow-state.js";
import {
  backupKeyFor,
  prepareForIssue,
} from "../src/workflows/develop.workflow.js";

function makeTmpRepo() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "claude-session-resume-"));
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
// issue-draft early-return: setRepoRoot called when skipping draft
// ---------------------------------------------------------------------------

test("issue-draft early-return calls setRepoRoot for monorepo (restored state + fresh AgentPool)", async () => {
  const tmp = makeTmpRepo();
  try {
    const packagesFoo = path.join(tmp, "packages", "foo");
    mkdirSync(packagesFoo, { recursive: true });
    execSync("git init -b main", { cwd: packagesFoo, stdio: "ignore" });
    execSync("git config user.email test@example.com", {
      cwd: packagesFoo,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test User'", {
      cwd: packagesFoo,
      stdio: "ignore",
    });
    writeFileSync(path.join(packagesFoo, "README.md"), "# foo\n");
    execSync("git add -A && git commit -m init", {
      cwd: packagesFoo,
      stdio: "ignore",
    });

    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    const repoPath = "packages/foo";
    const issue = { source: "github", id: "42", title: "Monorepo issue" };

    await saveState(tmp, {
      selected: issue,
      repoPath,
      steps: { wroteIssue: true },
    });
    writeFileSync(
      path.join(artifactsDir, "ISSUE.md"),
      "# Monorepo Issue\n\nDescription with enough content to pass the length check.",
    );

    let setRepoRootCalledWith = null;
    const mockAgentPool = {
      setRepoRoot(repoRoot) {
        setRepoRootCalledWith = repoRoot;
      },
    };

    const logEvents = [];
    const ctx = {
      workspaceDir: tmp,
      artifactsDir,
      agentPool: mockAgentPool,
      log: (e) => logEvents.push(e),
      cancelToken: { cancelled: false, paused: false },
      config: {},
      secrets: {},
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await issueDraftMachine.run(
      { issue, repoPath, force: true },
      ctx,
    );

    assert.equal(result.status, "ok");
    assert.ok(
      logEvents.some(
        (e) =>
          e.event === "issue_draft_skipped" && e.reason === "already_drafted",
      ),
      "should emit issue_draft_skipped",
    );
    assert.ok(setRepoRootCalledWith !== null, "setRepoRoot should be called");
    assert.equal(
      setRepoRootCalledWith,
      path.resolve(tmp, repoPath),
      "setRepoRoot should receive resolved monorepo path",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// backup creation/restore: state.repoPath used when selected lacks repo_path
// ---------------------------------------------------------------------------

test("prepareForIssue: backup uses state.repoPath when selected lacks repo_path (monorepo)", async () => {
  const tmp = makeTmpRepo();
  try {
    mkdirSync(path.join(tmp, "packages", "foo"), { recursive: true });
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");

    const issue = {
      source: "github",
      id: "42",
      title: "Monorepo issue",
      repo_path: "packages/foo",
    };
    const expectedBackupKey = backupKeyFor({
      ...issue,
      repo_path: "packages/foo",
    });
    assert.ok(
      expectedBackupKey.includes("42") && !expectedBackupKey.includes("root"),
      "monorepo backup key should include repo hash, not root",
    );

    writeFileSync(
      statePath,
      JSON.stringify({
        selected: { source: "github", id: "42", title: "Monorepo issue" },
        repoPath: "packages/foo",
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

    await prepareForIssue(tmp, { ...issue, repo_path: "packages/foo" }, ctx);

    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_detected" && e.from === "current",
      ),
      "should resume from current state when repoPath matches",
    );
    assert.ok(existsSync(statePath), "state should be preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: restores from legacy root key when monorepo backup was written before fix", async () => {
  const tmp = makeTmpRepo();
  try {
    mkdirSync(path.join(tmp, "packages", "foo"), { recursive: true });
    const artifactsDir = path.join(tmp, ".coder", "artifacts");

    const issue = {
      source: "github",
      id: "42",
      title: "Monorepo issue",
      repo_path: "packages/foo",
    };
    const legacyBackupKey = "github-42-root";
    const backupDir = path.join(tmp, ".coder", "backups", legacyBackupKey);
    mkdirSync(path.join(backupDir, "artifacts"), { recursive: true });
    writeFileSync(
      path.join(backupDir, "state.json"),
      JSON.stringify({
        selected: { source: "github", id: "42", title: "Monorepo issue" },
        repoPath: "packages/foo",
        steps: { wroteIssue: true, wrotePlan: true },
      }),
    );
    writeFileSync(path.join(backupDir, "artifacts", "ISSUE.md"), "# Old");
    writeFileSync(path.join(backupDir, "artifacts", "PLAN.md"), "# Old plan");

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, issue, ctx);

    assert.ok(
      logEvents.some(
        (e) => e.event === "loop_resume_detected" && e.from === "backup",
      ),
      "should restore from legacy root key when primary key has no backup",
    );
    const statePath = path.join(tmp, ".coder", "state.json");
    assert.ok(existsSync(statePath), "state should be restored");
    assert.ok(existsSync(path.join(artifactsDir, "PLAN.md")));
    assert.ok(!existsSync(backupDir), "backup should be consumed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareForIssue: backup created under correct key when state has repoPath but selected lacks it", async () => {
  const tmp = makeTmpRepo();
  try {
    mkdirSync(path.join(tmp, "packages", "foo"), { recursive: true });
    const statePath = path.join(tmp, ".coder", "state.json");
    const artifactsDir = path.join(tmp, ".coder", "artifacts");

    const priorIssue = {
      source: "github",
      id: "39",
      title: "Prior monorepo",
    };
    const newIssue = {
      source: "github",
      id: "40",
      title: "New",
      repo_path: ".",
    };

    writeFileSync(
      statePath,
      JSON.stringify({
        selected: priorIssue,
        repoPath: "packages/foo",
        steps: { wroteIssue: true, wrotePlan: true },
      }),
    );
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Prior");
    writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Prior plan");

    const expectedBackupKey = backupKeyFor({
      ...priorIssue,
      repo_path: "packages/foo",
    });

    const logEvents = [];
    const ctx = {
      config: { workflow: { resumeStepState: true } },
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
      log: (e) => logEvents.push(e),
    };

    await prepareForIssue(tmp, newIssue, ctx);

    assert.ok(!existsSync(statePath), "state should be cleared");
    const backupDir = path.join(tmp, ".coder", "backups", expectedBackupKey);
    assert.ok(
      existsSync(path.join(backupDir, "state.json")),
      `backup should be under monorepo key ${expectedBackupKey}, not github-39-root`,
    );
    assert.ok(existsSync(path.join(backupDir, "artifacts", "PLAN.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
