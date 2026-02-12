import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeJsonlLogger, closeAllLoggers, logsDir, sanitizeLogEvent } from "../src/logging.js";

test("sanitizeLogEvent redacts common credential fields in strings", () => {
  // Keep values short/low-entropy to avoid tripping external secret scanners in tests.
  const raw = `{"accessToken":"x","refreshToken":"y","token=z","auth":"Bearer aaaaaaaaaaaa"}`;
  const sanitized = sanitizeLogEvent(raw);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.doesNotMatch(sanitized, /\b(x|y|z)\b/);
  assert.doesNotMatch(sanitized, /Bearer a{12}/i);
});

test("makeJsonlLogger writes redacted payloads", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-logging-"));
  const logger = makeJsonlLogger(ws, "gemini");
  logger({
    stream: "stderr",
    data: `MCP server 'linear' rejected stored OAuth token. accessToken="x" refreshToken='y'`,
  });
  await closeAllLoggers();

  const content = readFileSync(path.join(logsDir(ws), "gemini.jsonl"), "utf8");
  assert.match(content, /\[REDACTED\]/);
  assert.doesNotMatch(content, /topsecret|alsosecret/);
});

test("sanitizeLogEvent redacts nested objects, arrays, and query tokens", () => {
  const event = sanitizeLogEvent({
    nested: { authorization: "Bearer supersecretvalue" },
    array: ["https://example.test?a=1&access_token=abc123&token=def456"],
  });

  assert.match(event.nested.authorization, /REDACTED/);
  assert.match(event.array[0], /access_token=\[REDACTED\]/);
  assert.match(event.array[0], /token=\[REDACTED\]/);
});
