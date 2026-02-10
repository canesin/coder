import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeJsonlLogger, closeAllLoggers, logsDir, sanitizeLogEvent } from "../src/logging.js";

test("sanitizeLogEvent redacts common credential fields in strings", () => {
  const raw = `{"accessToken":"abc123","refreshToken":"def456","token=xyz789","auth":"Bearer tokenvalue1234"}`;
  const sanitized = sanitizeLogEvent(raw);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.doesNotMatch(sanitized, /abc123|def456|xyz789|tokenvalue1234/);
});

test("makeJsonlLogger writes redacted payloads", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-logging-"));
  const logger = makeJsonlLogger(ws, "gemini");
  logger({
    stream: "stderr",
    data: `MCP server 'linear' rejected stored OAuth token. accessToken="topsecret" refreshToken='alsosecret'`,
  });
  await closeAllLoggers();

  const content = readFileSync(path.join(logsDir(ws), "gemini.jsonl"), "utf8");
  assert.match(content, /\[REDACTED\]/);
  assert.doesNotMatch(content, /topsecret|alsosecret/);
});
