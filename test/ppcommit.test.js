import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runPpcommitNative } from "../src/ppcommit.js";

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

test("ppcommit: skip via git config", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "// TODO: should be ignored\n", "utf8");
  run("git", ["config", "ppcommit.skip", "true"], repo);
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /skipped/i);
});

test("ppcommit: detects TODO comment", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "// TODO: fix this\n", "utf8");
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /^ERROR:/m);
  assert.match(r.stdout, /a\.js:1/);
});

test("ppcommit: blocks new markdown outside allowed dirs", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "notes.md"), "# Notes\n", "utf8");
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /notes\.md:1/);
});

test("ppcommit: does not flag edits to existing markdown", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "README.md"), "# Readme\n", "utf8");
  run("git", ["add", "README.md"], repo);
  run("git", ["commit", "-m", "add readme"], repo);

  writeFileSync(path.join(repo, "README.md"), "# Readme\n\nMore.\n", "utf8");
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 0);
});

test("ppcommit: treatWarningsAsErrors upgrades warnings", () => {
  const repo = makeRepo();
  // Emoji in code should be a warning by default.
  const smile = String.fromCodePoint(0x1F642);
  writeFileSync(path.join(repo, "a.js"), `// hello ${smile}\n`, "utf8");
  run("git", ["config", "ppcommit.treatWarningsAsErrors", "true"], repo);
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /^ERROR: Emoji character in code at a\.js:1$/m);
});

test("ppcommit: does not crash when optional parsers are unavailable", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "const x = 123;\nconsole.log(x);\n", "utf8");
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 0);
});

test("ppcommit: detects staged new markdown files", () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "ok.md"), "# ok\n", "utf8");
  writeFileSync(path.join(repo, "new.md"), "# new\n", "utf8");
  run("git", ["add", "docs/ok.md", "new.md"], repo);

  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /new\.md:1/);
  assert.doesNotMatch(r.stdout, /docs\/ok\.md:1/);
});

test("ppcommit: does not allow workflow artifacts under .coder/", () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, ".coder"), { recursive: true });
  writeFileSync(path.join(repo, ".coder", "notes.md"), "# Notes\n", "utf8");
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /\.coder\/notes\.md:1/);
});

test("ppcommit: does not allow coder workflow markdown artifacts (ISSUE/PLAN) in repo diffs", () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "ISSUE.md"), "# Issue\n", "utf8");
  const r = runPpcommitNative(repo);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /ISSUE\.md:1/);
});
