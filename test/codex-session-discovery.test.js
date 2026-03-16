import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverCodexSessionId } from "../src/agents/codex-session-discovery.js";

test("discoverCodexSessionId: returns sessionId when cwd matches", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "codex-session-"));
  const sessionsDir = path.join(tmp, "sessions", "2025", "03", "10");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sessionsDir, { recursive: true });

  const workspaceDir = path.join(tmp, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const sessionId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const rolloutPath = path.join(sessionsDir, "rollout-abc.jsonl");
  writeFileSync(
    rolloutPath,
    JSON.stringify({ sessionId, cwd: workspaceDir }) + "\n",
    "utf8",
  );

  const runStartTimeMs = Date.now() - 5000;
  const origEnv = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;

  try {
    const result = await discoverCodexSessionId(workspaceDir, runStartTimeMs);
    assert.equal(result, sessionId);
  } finally {
    process.env.CODEX_HOME = origEnv;
  }
});

test("discoverCodexSessionId: run-boundary filter excludes old files", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "codex-session-"));
  const sessionsDir = path.join(tmp, "sessions", "2025", "03", "10");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sessionsDir, { recursive: true });

  const workspaceDir = path.join(tmp, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const rolloutPath = path.join(sessionsDir, "rollout-old.jsonl");
  writeFileSync(
    rolloutPath,
    JSON.stringify({ sessionId: "old-session", cwd: workspaceDir }) + "\n",
    "utf8",
  );

  const runStartTimeMs = Date.now() + 10000;

  const origEnv = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;

  try {
    const result = await discoverCodexSessionId(workspaceDir, runStartTimeMs);
    assert.equal(result, null);
  } finally {
    process.env.CODEX_HOME = origEnv;
  }
});

test("discoverCodexSessionId: scans all lines for sessionId/cwd", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "codex-session-"));
  const sessionsDir = path.join(tmp, "sessions", "2025", "03", "10");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(sessionsDir, { recursive: true });

  const workspaceDir = path.join(tmp, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const sessionId = "found-in-line-3";
  const rolloutPath = path.join(sessionsDir, "rollout-multi.jsonl");
  writeFileSync(
    rolloutPath,
    '{"type":"other"}\n{"type":"other"}\n' +
      JSON.stringify({ sessionId, cwd: workspaceDir }) +
      "\n",
    "utf8",
  );

  const runStartTimeMs = Date.now() - 5000;
  const origEnv = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;

  try {
    const result = await discoverCodexSessionId(workspaceDir, runStartTimeMs);
    assert.equal(result, sessionId);
  } finally {
    process.env.CODEX_HOME = origEnv;
  }
});
