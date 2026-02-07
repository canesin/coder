import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSecretsWithFallback,
  extractGeminiPayloadJson,
  extractJson,
  formatCommandFailure,
} from "../src/helpers.js";

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
