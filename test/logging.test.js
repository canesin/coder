import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeAllLoggers,
  logsDir,
  makeJsonlLogger,
  sanitizeLogEvent,
} from "../src/logging.js";

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

test("makeJsonlLogger closes previous stream when called twice with same name", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-logging-dup-"));
  const logger1 = makeJsonlLogger(ws, "agent");
  logger1({ event: "first" });

  // Create second logger with same name — should close the first stream
  const logger2 = makeJsonlLogger(ws, "agent");
  logger2({ event: "second" });
  await closeAllLoggers();

  const content = readFileSync(path.join(logsDir(ws), "agent.jsonl"), "utf8");
  const lines = content.trim().split("\n");
  // Both events must be present; order is non-deterministic because two
  // O_APPEND streams race on the same fd path.
  assert.equal(lines.length, 2, "both events should be written");
  assert.ok(
    lines.some((l) => l.includes('"first"')) &&
      lines.some((l) => l.includes('"second"')),
    `expected both events, got: ${content}`,
  );
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

test("stale logger stops writing after closeAllLoggers", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-logging-"));
  const log1 = makeJsonlLogger(ws, "stale");
  log1({ event: "first" });
  const log2 = makeJsonlLogger(ws, "stale");
  log2({ event: "second" });

  await closeAllLoggers();

  const logPath = path.join(logsDir(ws), "stale.jsonl");
  const before = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);

  log1({ event: "after-close" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.equal(after.length, before.length);
});
