import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
  buildSecretsWithFallback,
  extractGeminiPayloadJson,
  extractJson,
  formatCommandFailure,
  gitCleanOrThrow,
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
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
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
      shellLookup: (name) => (name === "GEMINI_API_KEY" ? "shell-gemini-key" : ""),
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

test("gitCleanOrThrow ignores root workflow artifacts when explicitly ignored", () => {
  const { repoDir } = setupGitRepo({
    "PLAN.md": "plan\n",
  });
  writeFileSync(path.join(repoDir, "PLAN.md"), "updated plan\n", "utf8");

  assert.doesNotThrow(() => {
    gitCleanOrThrow(repoDir, ["PLAN.md"]);
  });
});

test("gitCleanOrThrow does not ignore nested lookalike artifact paths", () => {
  const { repoDir } = setupGitRepo({
    "PLAN.md": "plan\n",
    "docs/PLAN.md": "docs plan\n",
  });
  writeFileSync(path.join(repoDir, "docs", "PLAN.md"), "updated docs plan\n", "utf8");

  assert.throws(() => {
    gitCleanOrThrow(repoDir, ["PLAN.md"]);
  }, /docs\/PLAN\.md/);
});
