import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runPpcommitAll,
  runPpcommitBranch,
  runPpcommitNative,
} from "../src/ppcommit.js";

/** Config to bypass gitleaks so tests exercise task/markdown/parser behavior. */
const NO_GITLEAKS = { blockSecrets: false };

const EMOJI_SMILE = 0x1f642;
const PROBE_TIMEOUT_MS = 5000;
const SUBPROCESS_TIMEOUT_MS = 15000;
const FILE_MODE_NON_EXECUTABLE = 0o644;
const FILE_MODE_EXECUTABLE = 0o755;

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
  const r = await runPpcommitNative(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /^ERROR:/m);
  assert.match(r.stdout, /a\.js:1/);
});

test("ppcommit: blocks new markdown outside allowed dirs", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "notes.md"), "# Notes\n", "utf8");
  const r = await runPpcommitNative(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /notes\.md:1/);
});

test("ppcommit: does not flag edits to existing markdown", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "README.md"), "# Readme\n", "utf8");
  run("git", ["add", "README.md"], repo);
  run("git", ["commit", "-m", "add readme"], repo);

  writeFileSync(path.join(repo, "README.md"), "# Readme\n\nMore.\n", "utf8");
  const r = await runPpcommitNative(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 0);
});

test("ppcommit: treatWarningsAsErrors upgrades warnings", async () => {
  const repo = makeRepo();
  // Emoji in code should be a warning by default.
  const smile = String.fromCodePoint(EMOJI_SMILE);
  writeFileSync(path.join(repo, "a.js"), `// hello ${smile}\n`, "utf8");
  const r = await runPpcommitNative(repo, {
    ...NO_GITLEAKS,
    treatWarningsAsErrors: true,
  });
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
  const r = await runPpcommitNative(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 0);
});

test("ppcommit: irreparable LLM fallback JSON returns cleanly without extra retries", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "const x = 1;\n", "utf8");

  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'prefix [{"a":"\\uZZZZ"}] suffix',
            },
          },
        ],
      }),
    };
  };

  try {
    const r = await runPpcommitNative(repo, {
      blockSecrets: false,
      enableLlm: true,
      llmApiKey: "test-key",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ppcommit: detects staged new markdown files", async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs", "ok.md"), "# ok\n", "utf8");
  writeFileSync(path.join(repo, "new.md"), "# new\n", "utf8");
  run("git", ["add", "docs/ok.md", "new.md"], repo);

  const r = await runPpcommitNative(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /new\.md:1/);
  assert.doesNotMatch(r.stdout, /docs\/ok\.md:1/);
});

test("ppcommit: does not allow workflow artifacts under .coder/", async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, ".coder"), { recursive: true });
  writeFileSync(path.join(repo, ".coder", "notes.md"), "# Notes\n", "utf8");
  const r = await runPpcommitNative(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /\.coder\/notes\.md:1/);
});

test("ppcommit: does not allow coder workflow markdown artifacts (ISSUE/PLAN) in repo diffs", async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "ISSUE.md"), "# Issue\n", "utf8");
  const r = await runPpcommitNative(repo, NO_GITLEAKS);
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
  const r = await runPpcommitBranch(repo, "main", NO_GITLEAKS);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /No files changed/i);
});

test("ppcommit branch: detects TODO in files changed since base", async () => {
  const repo = makeRepoWithMainBranch();
  run("git", ["checkout", "-b", "feat"], repo);
  writeFileSync(path.join(repo, "a.js"), "// TODO: fix this\n", "utf8");
  run("git", ["add", "a.js"], repo);
  run("git", ["commit", "-m", "add a.js"], repo);
  const r = await runPpcommitBranch(repo, "main", NO_GITLEAKS);
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
  const r = await runPpcommitBranch(repo, "main", NO_GITLEAKS);
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
  const r = await runPpcommitBranch(repo, "main", NO_GITLEAKS);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /notes\.md:1/);
});

test("ppcommit branch: invalid base ref is an error (does not silently succeed)", async () => {
  const repo = makeRepoWithMainBranch();
  const r = await runPpcommitBranch(
    repo,
    "definitely-not-a-real-branch",
    NO_GITLEAKS,
  );
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
  const r = await runPpcommitAll(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /TODO/);
  assert.match(r.stdout, /a\.js:1/);
});

test("ppcommit all: clean repo passes", async () => {
  const repo = makeRepoWithMainBranch();
  // init.txt has only "initial\n" — no issues
  const r = await runPpcommitAll(repo, NO_GITLEAKS);
  assert.equal(r.exitCode, 0);
});

// --- gitleaks ENOENT tests (spawned subprocess for fresh module state) ---

// Probe: can we spawn process.execPath with a restricted PATH? In sandboxed
// environments (e.g. EPERM), spawn fails before the child runs; skip those.
function gitleaksSpawnSkipReason() {
  if (process.platform === "win32") return "Windows";
  const probeDir = mkdtempSync(path.join(os.tmpdir(), "coder-ppcommit-probe-"));
  try {
    const gitPath = spawnSync("which", ["git"], { encoding: "utf8" })
      .stdout?.trim()
      ?.split(/\r?\n/)[0];
    if (!gitPath) return "git not resolvable";
    symlinkSync(gitPath, path.join(probeDir, path.basename(gitPath)));
    const probe = spawnSync(process.execPath, ["-e", "0"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, PATH: probeDir, NODE_ENV: "test" },
    });
    if (probe.error) return `spawn fails (${probe.error.code})`;
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const gitleaksSpawnSkip = gitleaksSpawnSkipReason();

test("ppcommit: gitleaks missing from PATH produces actionable error", {
  skip: gitleaksSpawnSkip,
}, async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "const x = 1;\n", "utf8");
  const shimDir = mkdtempSync(path.join(os.tmpdir(), "coder-ppcommit-path-"));
  const gitPath = spawnSync("which", ["git"], { encoding: "utf8" })
    .stdout?.trim()
    ?.split(/\r?\n/)[0];
  assert.ok(gitPath, "git must be resolvable for this test");
  symlinkSync(gitPath, path.join(shimDir, path.basename(gitPath)));
  const restrictedPath = shimDir;

  const srcPath = path.resolve(import.meta.dirname, "..", "src", "ppcommit.js");
  const script = `
    import { runPpcommitNative } from ${JSON.stringify("file://" + srcPath)};
    const result = await runPpcommitNative(${JSON.stringify(repo)}, { blockSecrets: true });
    if (result.exitCode !== 0) {
      process.stdout.write(result.stderr);
    } else {
      process.stdout.write("NO_ERROR");
    }
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    env: { ...process.env, PATH: restrictedPath, NODE_ENV: "test" },
  });
  if (r.error) {
    throw new Error(
      `Subprocess failed to spawn: ${r.error.code || r.error.message}. stdout: ${r.stdout || ""}. stderr: ${r.stderr || ""}`,
    );
  }
  const out = r.stdout || "";
  assert.doesNotMatch(
    out,
    /NO_ERROR/,
    "should return exitCode 1 when gitleaks missing",
  );
  assert.match(out, /gitleaks binary not found in PATH/);
  assert.match(
    out,
    new RegExp(
      `PATH searched: ${restrictedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  assert.match(
    out,
    /Install: https:\/\/github\.com\/gitleaks\/gitleaks#installing/,
  );
  assert.match(
    out,
    /To disable: set "blockSecrets": false in ppcommit config \(coder\.json\)/,
  );
});

test("ppcommit: gitleaks not executable (EACCES) produces actionable error", {
  skip: gitleaksSpawnSkip || process.getuid?.() === 0,
}, async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "const x = 1;\n", "utf8");

  const binDir = path.join(
    mkdtempSync(path.join(os.tmpdir(), "coder-bin-")),
    "bin",
  );
  mkdirSync(binDir, { recursive: true });

  const gitleaksPath = path.join(binDir, "gitleaks");
  writeFileSync(gitleaksPath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(gitleaksPath, FILE_MODE_NON_EXECUTABLE);

  const srcPath = path.resolve(import.meta.dirname, "..", "src", "ppcommit.js");
  const script = `
    import { runPpcommitNative } from ${JSON.stringify("file://" + srcPath)};
    const result = await runPpcommitNative(${JSON.stringify(repo)}, { blockSecrets: true });
    if (result.exitCode !== 0) {
      process.stdout.write(result.stderr);
    } else {
      process.stdout.write("NO_ERROR");
    }
  `;
  // binDir is first (non-executable gitleaks); exclude node's dir to avoid real gitleaks
  const restrictedPath = `${binDir}:/usr/bin:/bin`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    env: { ...process.env, PATH: restrictedPath, NODE_ENV: "test" },
  });
  if (r.error) {
    throw new Error(
      `Subprocess failed to spawn: ${r.error.code || r.error.message}. stdout: ${r.stdout || ""}. stderr: ${r.stderr || ""}`,
    );
  }
  const out = r.stdout || "";
  assert.doesNotMatch(
    out,
    /NO_ERROR/,
    "should return exitCode 1 when gitleaks not executable",
  );
  assert.match(out, /gitleaks binary not found in PATH/);
  assert.match(
    out,
    new RegExp(
      `PATH searched: ${restrictedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  assert.match(
    out,
    /Install: https:\/\/github\.com\/gitleaks\/gitleaks#installing/,
  );
  assert.match(
    out,
    /To disable: set "blockSecrets": false in ppcommit config \(coder\.json\)/,
  );
});

test("ppcommit: gitleaks version check failure produces distinct error", {
  skip: gitleaksSpawnSkip,
}, async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "a.js"), "const x = 1;\n", "utf8");

  const binDir = mkdtempSync(path.join(os.tmpdir(), "coder-gitleaks-fail-"));
  const gitPath = spawnSync("which", ["git"], { encoding: "utf8" })
    .stdout?.trim()
    ?.split(/\r?\n/)[0];
  assert.ok(gitPath, "git must be resolvable for this test");
  symlinkSync(gitPath, path.join(binDir, path.basename(gitPath)));

  // Fake gitleaks that is executable but exits non-zero
  const gitleaksPath = path.join(binDir, "gitleaks");
  writeFileSync(
    gitleaksPath,
    "#!/bin/sh\necho 'bad version' >&2\nexit 1\n",
    "utf8",
  );
  chmodSync(gitleaksPath, FILE_MODE_EXECUTABLE);

  const srcPath = path.resolve(import.meta.dirname, "..", "src", "ppcommit.js");
  const script = `
    import { runPpcommitNative } from ${JSON.stringify("file://" + srcPath)};
    const result = await runPpcommitNative(${JSON.stringify(repo)}, { blockSecrets: true });
    if (result.exitCode !== 0) {
      process.stdout.write(result.stderr);
    } else {
      process.stdout.write("NO_ERROR");
    }
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS,
    env: { ...process.env, PATH: binDir, NODE_ENV: "test" },
  });
  if (r.error) {
    throw new Error(
      `Subprocess failed to spawn: ${r.error.code || r.error.message}. stdout: ${r.stdout || ""}. stderr: ${r.stderr || ""}`,
    );
  }
  const out = r.stdout || "";
  assert.doesNotMatch(
    out,
    /NO_ERROR/,
    "should return exitCode 1 when gitleaks version check fails",
  );
  assert.match(out, /gitleaks version check failed/);
  assert.doesNotMatch(
    out,
    /gitleaks binary not found in PATH/,
    "should NOT use the missing-binary message for version check failures",
  );
});
