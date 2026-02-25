import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runPpcommitAll,
  runPpcommitBranch,
  runPpcommitNative,
} from "../src/ppcommit.js";

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    const msg = (res.stdout || "") + (res.stderr || "");
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${msg}`);
  }
  return res;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-ppcommit-"));
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  return dir;
}

test("ppcommit: skip via config", async () => {
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, "a.js"),
    "// TODO: should be ignored\n",
    "utf8",
  );
  const r = await runPpcommitNative(repo, { skip: true });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /skipped/i);
});

test("ppcommit: detects TODO comment", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "// TODO: fix this\n", "utf8");
  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /^ERROR:/m);
  assert.match(r.stdout, /a\.js:1/);
});

test("ppcommit: blocks new markdown outside allowed dirs", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "notes.md"), "# Notes\n", "utf8");
  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /notes\.md:1/);
});

test("ppcommit: does not flag edits to existing markdown", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "README.md"), "# Readme\n", "utf8");
  run("git", ["add", "README.md"], repo);
  run("git", ["commit", "-m", "add readme"], repo);

  writeFileSync(path.join(repo, "README.md"), "# Readme\n\nMore.\n", "utf8");
  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 0);
});

test("ppcommit: treatWarningsAsErrors upgrades warnings", async () => {
  const repo = makeRepo();
  // Emoji in code should be a warning by default.
  const smile = String.fromCodePoint(0x1f642);
  writeFileSync(path.join(repo, "a.js"), `// hello ${smile}\n`, "utf8");
  const r = await runPpcommitNative(repo, { treatWarningsAsErrors: true });
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /^ERROR: Emoji character in code at a\.js:1$/m);
});

test("ppcommit: does not crash when optional parsers are unavailable", async () => {
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, "a.js"),
    "const x = 123;\nconsole.log(x);\n",
    "utf8",
  );
  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 0);
});

test("ppcommit: detects staged new markdown files", async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "ok.md"), "# ok\n", "utf8");
  writeFileSync(path.join(repo, "new.md"), "# new\n", "utf8");
  run("git", ["add", "docs/ok.md", "new.md"], repo);

  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /new\.md:1/);
  assert.doesNotMatch(r.stdout, /docs\/ok\.md:1/);
});

test("ppcommit: does not allow workflow artifacts under .coder/", async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, ".coder"), { recursive: true });
  writeFileSync(path.join(repo, ".coder", "notes.md"), "# Notes\n", "utf8");
  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /\.coder\/notes\.md:1/);
});

test("ppcommit: does not allow coder workflow markdown artifacts (ISSUE/PLAN) in repo diffs", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "ISSUE.md"), "# Issue\n", "utf8");
  const r = await runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /ISSUE\.md:1/);
});

// --- runPpcommitBranch tests ---

function makeRepoWithMainBranch() {
  const dir = makeRepo();
  // Create initial commit on main so we can branch from it.
  writeFileSync(path.join(dir, "init.txt"), "initial\n", "utf8");
  run("git", ["add", "init.txt"], dir);
  run("git", ["commit", "-m", "initial commit"], dir);
  // Ensure we're on "main" branch
  run("git", ["branch", "-M", "main"], dir);
  return dir;
}

test("ppcommit branch: no files changed since base", async () => {
  const repo = makeRepoWithMainBranch();
  const r = await runPpcommitBranch(repo, "main");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /No files changed/i);
});

test("ppcommit branch: detects TODO in files changed since base", async () => {
  const repo = makeRepoWithMainBranch();
  run("git", ["checkout", "-b", "feat"], repo);
  writeFileSync(path.join(repo, "a.js"), "// TODO: fix this\n", "utf8");
  run("git", ["add", "a.js"], repo);
  run("git", ["commit", "-m", "add a.js"], repo);
  const r = await runPpcommitBranch(repo, "main");
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /TODO/);
  assert.match(r.stdout, /a\.js:1/);
});

test("ppcommit branch: clean files pass checks", async () => {
  const repo = makeRepoWithMainBranch();
  run("git", ["checkout", "-b", "feat"], repo);
  writeFileSync(
    path.join(repo, "b.js"),
    "const x = 1;\nconsole.log(x);\n",
    "utf8",
  );
  run("git", ["add", "b.js"], repo);
  run("git", ["commit", "-m", "add b.js"], repo);
  const r = await runPpcommitBranch(repo, "main");
  assert.equal(r.exitCode, 0);
});

test("ppcommit branch: skip via config", async () => {
  const repo = makeRepoWithMainBranch();
  run("git", ["checkout", "-b", "feat"], repo);
  writeFileSync(
    path.join(repo, "a.js"),
    "// TODO: should be ignored\n",
    "utf8",
  );
  run("git", ["add", "a.js"], repo);
  run("git", ["commit", "-m", "add a.js"], repo);
  const r = await runPpcommitBranch(repo, "main", { skip: true });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /skipped/i);
});

test("ppcommit branch: detects new markdown added since base", async () => {
  const repo = makeRepoWithMainBranch();
  run("git", ["checkout", "-b", "feat"], repo);
  writeFileSync(path.join(repo, "notes.md"), "# Notes\n", "utf8");
  run("git", ["add", "notes.md"], repo);
  run("git", ["commit", "-m", "add notes"], repo);
  const r = await runPpcommitBranch(repo, "main");
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /notes\.md:1/);
});

test("ppcommit branch: invalid base ref is an error (does not silently succeed)", async () => {
  const repo = makeRepoWithMainBranch();
  const r = await runPpcommitBranch(repo, "definitely-not-a-real-branch");
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /Failed to diff against base/);
});

// --- runPpcommitAll tests ---

test("ppcommit all: checks all files in the repo", async () => {
  const repo = makeRepoWithMainBranch();
  // init.txt is already committed — add a file with a task marker
  writeFileSync(path.join(repo, "a.js"), "// TODO: fix\n", "utf8");
  run("git", ["add", "a.js"], repo);
  run("git", ["commit", "-m", "add a.js"], repo);
  const r = await runPpcommitAll(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /TODO/);
  assert.match(r.stdout, /a\.js:1/);
});

test("ppcommit all: clean repo passes", async () => {
  const repo = makeRepoWithMainBranch();
  // init.txt has only "initial\n" — no issues
  const r = await runPpcommitAll(repo);
  assert.equal(r.exitCode, 0);
});

// --- gitleaks ENOENT tests (spawned subprocess for fresh module state) ---

test("ppcommit: gitleaks missing from PATH produces actionable error", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "const x = 1;\n", "utf8");
  const srcPath = path.resolve(import.meta.dirname, "..", "src", "ppcommit.js");
  const script = `
    import { runPpcommitNative } from ${JSON.stringify("file://" + srcPath)};
    try {
      await runPpcommitNative(${JSON.stringify(repo)}, { blockSecrets: true });
      process.stdout.write("NO_ERROR");
    } catch (e) {
      process.stdout.write(e.message);
    }
  `;
  // Include node + git dirs but exclude gitleaks
  const nodeBin = path.dirname(process.execPath);
  const restrictedPath = `${nodeBin}:/usr/bin:/bin`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, PATH: restrictedPath, NODE_ENV: "test" },
  });
  const out = r.stdout || "";
  assert.doesNotMatch(out, /NO_ERROR/, "should have thrown an error");
  assert.match(out, /gitleaks binary not found in PATH/);
  assert.match(out, /gitleaks\/gitleaks/);
  assert.match(out, /blockSecrets/);
});
