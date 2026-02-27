import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeGitWorktreeFingerprint,
  upsertIssueCompletionBlock,
} from "../src/helpers.js";

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    const msg = (res.stdout || "") + (res.stderr || "");
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${msg}`);
  }
  return res;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-fp-"));
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  return dir;
}

test("computeGitWorktreeFingerprint changes when tracked file changes", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
  const fp1 = computeGitWorktreeFingerprint(repo);
  writeFileSync(path.join(repo, "a.txt"), "two\n", "utf8");
  const fp2 = computeGitWorktreeFingerprint(repo);
  assert.notEqual(fp1, fp2);
});

test("computeGitWorktreeFingerprint changes when untracked file content changes", () => {
  const repo = makeRepo();
  const fp1 = computeGitWorktreeFingerprint(repo);
  writeFileSync(path.join(repo, "u.txt"), "u1\n", "utf8");
  const fp2 = computeGitWorktreeFingerprint(repo);
  writeFileSync(path.join(repo, "u.txt"), "u2\n", "utf8");
  const fp3 = computeGitWorktreeFingerprint(repo);
  assert.notEqual(fp1, fp2);
  assert.notEqual(fp2, fp3);
});

test(
  "computeGitWorktreeFingerprint handles unreadable untracked file without throwing",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  () => {
    const repo = makeRepo();
    const filePath = path.join(repo, "secret.txt");
    writeFileSync(filePath, "cannot read me\n", "utf8");
    chmodSync(filePath, 0o000);
    const fp1 = computeGitWorktreeFingerprint(repo);
    const fp2 = computeGitWorktreeFingerprint(repo);
    assert.equal(fp1, fp2);

    // Reconstruct expected digest with ERR:EACCES sentinel
    const gitOut = (args) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8" }).stdout || "";
    const h = createHash("sha256");
    h.update("status\0");
    h.update(gitOut(["status", "--porcelain=v1", "-z"]));
    h.update("\0diff\0");
    h.update(gitOut(["diff", "--no-ext-diff"]));
    h.update("\0diff_cached\0");
    h.update(gitOut(["diff", "--cached", "--no-ext-diff"]));
    h.update("\0untracked\0");
    h.update("secret.txt\nERR:EACCES\n");
    assert.equal(fp1, h.digest("hex"));

    chmodSync(filePath, 0o644);
  },
);

test("computeGitWorktreeFingerprint handles special characters and spaces in paths", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "hello world.txt"), "sp1\n", "utf8");
  writeFileSync(path.join(repo, "special!@#chars.txt"), "sp2\n", "utf8");
  mkdirSync(path.join(repo, "path with spaces"));
  writeFileSync(
    path.join(repo, "path with spaces", "nested.txt"),
    "sp3\n",
    "utf8",
  );
  const fp1 = computeGitWorktreeFingerprint(repo);
  const fp2 = computeGitWorktreeFingerprint(repo);
  assert.equal(fp1, fp2);
});

test("computeGitWorktreeFingerprint is stable across repeated runs", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "tracked.txt"), "t\n", "utf8");
  run("git", ["add", "tracked.txt"], repo);
  run("git", ["commit", "-m", "init"], repo);
  writeFileSync(path.join(repo, "untracked.txt"), "u\n", "utf8");
  const fp1 = computeGitWorktreeFingerprint(repo);
  const fp2 = computeGitWorktreeFingerprint(repo);
  const fp3 = computeGitWorktreeFingerprint(repo);
  assert.equal(fp1, fp2);
  assert.equal(fp2, fp3);
});

test("upsertIssueCompletionBlock is idempotent (replaces existing block)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-issue-"));
  const p = path.join(dir, "ISSUE.md");
  writeFileSync(p, "# Title\n\nBody.\n", "utf8");
  upsertIssueCompletionBlock(p, {
    ppcommitClean: true,
    testsPassed: true,
    note: "first",
  });
  const a = readFileSync(p, "utf8");
  upsertIssueCompletionBlock(p, {
    ppcommitClean: true,
    testsPassed: true,
    note: "second",
  });
  const b = readFileSync(p, "utf8");

  assert.match(a, /coder:completion:start/);
  assert.match(b, /coder:completion:start/);
  assert.match(b, /note: second/);
  assert.doesNotMatch(b, /note: first/);

  // Should only have one block.
  assert.equal((b.match(/coder:completion:start/g) || []).length, 1);
  assert.equal((b.match(/coder:completion:end/g) || []).length, 1);
});
