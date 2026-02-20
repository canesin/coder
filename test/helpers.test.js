import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPrBodyFromIssue,
  buildSecretsWithFallback,
  detectRemoteType,
  extractGeminiPayloadJson,
  extractJson,
  formatCommandFailure,
  gitCleanOrThrow,
  runHostTests,
  sanitizeIssueMarkdown,
  stripAgentNoise,
  TestInfrastructureError,
} from "../src/helpers.js";

function setupGitRepo(files) {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "coder-helpers-git-"));
  mkdirSync(path.join(repoDir, "docs"), { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }

  const runGit = (...args) => {
    const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${res.stderr || res.stdout}`,
      );
    }
  };

  runGit("init");
  runGit("config", "user.email", "test@example.com");
  runGit("config", "user.name", "Test User");
  runGit("add", ".");
  runGit("commit", "-m", "initial");

  return { repoDir };
}

test("buildSecretsWithFallback aliases GOOGLE_API_KEY to GEMINI_API_KEY", () => {
  const secrets = buildSecretsWithFallback(
    ["GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"],
    {
      env: {
        GOOGLE_API_KEY: "google-key",
        OPENAI_API_KEY: "openai-key",
      },
      shellLookup: () => "",
    },
  );

  assert.equal(secrets.GOOGLE_API_KEY, "google-key");
  assert.equal(secrets.GEMINI_API_KEY, "google-key");
  assert.equal(secrets.OPENAI_API_KEY, "openai-key");
});

test("buildSecretsWithFallback aliases GEMINI_API_KEY to GOOGLE_API_KEY", () => {
  const secrets = buildSecretsWithFallback(
    ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    {
      env: {
        GEMINI_API_KEY: "gemini-key",
      },
      shellLookup: () => "",
    },
  );

  assert.equal(secrets.GEMINI_API_KEY, "gemini-key");
  assert.equal(secrets.GOOGLE_API_KEY, "gemini-key");
});

test("buildSecretsWithFallback uses shell fallback when process env is missing", () => {
  const secrets = buildSecretsWithFallback(
    ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"],
    {
      env: {},
      shellLookup: (name) =>
        name === "GEMINI_API_KEY" ? "shell-gemini-key" : "",
    },
  );

  assert.equal(secrets.GEMINI_API_KEY, "shell-gemini-key");
  assert.equal(secrets.GOOGLE_API_KEY, "shell-gemini-key");
  assert.equal(secrets.OPENAI_API_KEY, undefined);
});

test("formatCommandFailure extracts nested gemini JSON error and includes hint", () => {
  const res = {
    exitCode: 41,
    stdout: "",
    stderr:
      `Warning: something\n` +
      `{"session_id":"abc","error":{"type":"Error","message":"When using Gemini API, you must specify the GEMINI_API_KEY environment variable.","code":41}}`,
  };

  const msg = formatCommandFailure("Gemini issue listing failed", res);
  assert.match(msg, /Gemini issue listing failed \(exit 41\)/);
  assert.match(msg, /must specify the GEMINI_API_KEY environment variable/);
  assert.match(msg, /Hint: set GEMINI_API_KEY/);
});

test("formatCommandFailure filters MCP noise and keeps tail content when truncating", () => {
  const noise =
    `Server 'github' supports tool updates. Listening for changes...\n`.repeat(
      400,
    );
  const res = {
    exitCode: 1,
    stdout: "",
    stderr: noise + "REAL ERROR: boom at the end\n",
  };
  const msg = formatCommandFailure("Gemini ISSUE.md drafting failed", res, {
    maxLen: 80,
  });
  assert.match(msg, /REAL ERROR: boom/);
  assert.doesNotMatch(msg, /supports tool updates/i);
});

test("extractJson parses Gemini envelope JSON without tripping on escaped fences", () => {
  const stdout =
    '{"session_id":"abc","response":"```json\\\\n{\\\\n  \\"issues\\": [],\\\\n  \\"recommended_index\\": 0\\\\n}\\\\n```"}';
  const parsed = extractJson(stdout);

  assert.equal(parsed.session_id, "abc");
  assert.match(parsed.response, /recommended_index/);
});

test("extractGeminiPayloadJson unwraps fenced JSON in Gemini envelope response", () => {
  const stdout =
    '{"session_id":"abc","response":"```json\\\\n{\\\\n  \\"issues\\": [],\\\\n  \\"recommended_index\\": 0\\\\n}\\\\n```"}';
  const parsed = extractGeminiPayloadJson(stdout);

  assert.deepEqual(parsed, { issues: [], recommended_index: 0 });
});

test("gitCleanOrThrow automatically ignores .gemini/ directory", () => {
  const { repoDir } = setupGitRepo({
    "README.md": "hello\n",
  });
  mkdirSync(path.join(repoDir, ".gemini"), { recursive: true });
  writeFileSync(path.join(repoDir, ".gemini", "settings.json"), "{}", "utf8");

  assert.doesNotThrow(() => {
    gitCleanOrThrow(repoDir);
  });
});

test("gitCleanOrThrow throws when repo has modified files", () => {
  const { repoDir } = setupGitRepo({
    "a.txt": "a\n",
  });
  writeFileSync(path.join(repoDir, "a.txt"), "b\n", "utf8");

  assert.throws(() => {
    gitCleanOrThrow(repoDir);
  }, /a\.txt/);
});

test("sanitizeIssueMarkdown strips MCP auth noise and preserves markdown body", () => {
  const raw = `MCP server 'linear' rejected stored OAuth token. Please re-authenticate using: /mcp auth linear
# Metadata

Issue details`;
  const cleaned = sanitizeIssueMarkdown(raw);
  assert.equal(cleaned.startsWith("# Metadata"), true);
  assert.doesNotMatch(cleaned, /rejected stored OAuth token/i);
});

test("sanitizeIssueMarkdown strips MCP update notification noise (leading and trailing)", () => {
  const raw = `Warning: Skipping extension in <HOME>/.gemini/extensions/logs: Configuration file not found
🔔 Received tool update notification from 'github'
# Title

Body text

Resources updated for server: githubPrompts updated for server: githubTools updated for server: github
Tools changed, updating Gemini context...`;
  const cleaned = sanitizeIssueMarkdown(raw);
  assert.match(cleaned, /^# Title/m);
  assert.doesNotMatch(cleaned, /Received tool update notification/i);
  assert.doesNotMatch(cleaned, /updated for server:/i);
  assert.doesNotMatch(cleaned, /Tools changed,\s*updating Gemini context/i);
});

test("stripAgentNoise drops concatenated MCP update lines", () => {
  const raw = `Resources updated for server: githubPrompts updated for server: githubTools updated for server: github\nOK\n`;
  const cleaned = stripAgentNoise(raw).trim();
  assert.equal(cleaned, "OK");
});

test("runHostTests throws TestInfrastructureError when cargo test is configured but Cargo.toml is missing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-host-tests-"));
  await assert.rejects(
    async () => runHostTests(dir, { testCmd: "cargo test" }),
    (err) => {
      assert.equal(err instanceof TestInfrastructureError, true);
      assert.match(err.message, /Cargo\.toml/);
      return true;
    },
  );
});

test("runHostTests does not throw TestInfrastructureError when cargo is run after cd into subdir", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-host-tests-"));
  const res = await runHostTests(dir, { testCmd: "cd rust && cargo test" });
  assert.notEqual(res.exitCode, 0);
});

test("buildPrBodyFromIssue returns a sanitized top section", () => {
  const issue = `Warning: startup
MCP server 'linear' rejected stored OAuth token.
# Metadata
- Source: github

# Problem
Real problem text

# Changes
Do the thing`;
  const body = buildPrBodyFromIssue(issue, { maxLines: 4 });
  assert.equal(body.includes("# Metadata"), true);
  assert.equal(body.includes("rejected stored OAuth token"), false);
});

test("detectRemoteType returns gitlab for HTTPS gitlab remote", () => {
  const { repoDir } = setupGitRepo({ "README.md": "hello\n" });
  spawnSync(
    "git",
    ["remote", "add", "origin", "https://gitlab.com/org/repo.git"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );
  assert.equal(detectRemoteType(repoDir), "gitlab");
});

test("detectRemoteType returns gitlab for SSH gitlab remote", () => {
  const { repoDir } = setupGitRepo({ "README.md": "hello\n" });
  spawnSync("git", ["remote", "add", "origin", "git@gitlab.com:org/repo.git"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(detectRemoteType(repoDir), "gitlab");
});

test("detectRemoteType returns github for github remote", () => {
  const { repoDir } = setupGitRepo({ "README.md": "hello\n" });
  spawnSync(
    "git",
    ["remote", "add", "origin", "https://github.com/org/repo.git"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );
  assert.equal(detectRemoteType(repoDir), "github");
});

test("detectRemoteType returns github when no remote exists", () => {
  const { repoDir } = setupGitRepo({ "README.md": "hello\n" });
  assert.equal(detectRemoteType(repoDir), "github");
});
