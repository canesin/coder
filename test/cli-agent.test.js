import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { CliAgent, resolveAgentName } from "../src/agents/cli-agent.js";

const tmpDir = os.tmpdir();

function makeAgent(agentName, modelOverride) {
  const config = {
    models: {
      gemini: modelOverride?.gemini ?? null,
      claude: modelOverride?.claude ?? null,
    },
    mcp: { strictStartup: false },
    claude: { skipPermissions: false },
    verbose: false,
  };
  return new CliAgent(agentName, {
    cwd: tmpDir,
    workspaceDir: tmpDir,
    secrets: {},
    config,
  });
}

const MALICIOUS = "'; touch /tmp/pwned; #";
const ESCAPED_MALICIOUS = "''\\''; touch /tmp/pwned; #'";

test("gemini: sessionId is ignored (no Gemini equivalent)", () => {
  const agent = makeAgent("gemini");
  const cmd = agent._buildCommand("prompt", { sessionId: "some-id" });
  assert.ok(!cmd.includes("--sandbox-id"));
  assert.ok(!cmd.includes("--session-id"));
  assert.ok(!cmd.includes("--resume"));
});

test("gemini: resumeId maps to --resume latest", () => {
  const agent = makeAgent("gemini");
  const cmd = agent._buildCommand("prompt", { resumeId: "some-id" });
  assert.ok(cmd.includes("--resume latest"));
  assert.ok(!cmd.includes("--sandbox-id"));
});

test("gemini: malicious modelName is shell-escaped", () => {
  const agent = makeAgent("gemini", { gemini: MALICIOUS });
  const cmd = agent._buildCommand("prompt", {});
  assert.ok(cmd.includes(`-m ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`-m '; touch`));
});

test("gemini: malicious modelName is shell-escaped in structured mode", () => {
  const agent = makeAgent("gemini", { gemini: MALICIOUS });
  const cmd = agent._buildCommand("prompt", { structured: true });
  assert.ok(cmd.includes(`-m ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`-m '; touch`));
});

test("claude: malicious sessionId is shell-escaped", () => {
  const agent = makeAgent("claude");
  const cmd = agent._buildCommand("prompt", { sessionId: MALICIOUS });
  assert.ok(cmd.includes(`--session-id ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`--session-id '; touch`));
});

test("claude: malicious resumeId is shell-escaped", () => {
  const agent = makeAgent("claude");
  const cmd = agent._buildCommand("prompt", { resumeId: MALICIOUS });
  assert.ok(cmd.includes(`--resume ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`--resume '; touch`));
});

test("claude: malicious model name is shell-escaped", () => {
  const agent = makeAgent("claude", { claude: MALICIOUS });
  const cmd = agent._buildCommand("prompt", {});
  assert.ok(cmd.includes(`--model ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`--model '; touch`));
});

test("resolveAgentName: known agents resolve", () => {
  assert.equal(resolveAgentName("gemini"), "gemini");
  assert.equal(resolveAgentName("claude"), "claude");
  assert.equal(resolveAgentName("codex"), "codex");
});

test("resolveAgentName: custom agent name resolves", () => {
  assert.equal(resolveAgentName("aider"), "aider");
  assert.equal(resolveAgentName("cursor"), "cursor");
});

test("resolveAgentName: normalizes to lowercase", () => {
  assert.equal(resolveAgentName("Gemini"), "gemini");
  assert.equal(resolveAgentName("AIDER"), "aider");
});

test("resolveAgentName: trims whitespace", () => {
  assert.equal(resolveAgentName("  claude  "), "claude");
});

test("resolveAgentName: rejects empty", () => {
  assert.throws(() => resolveAgentName(""), /Invalid agent name/);
});

test("resolveAgentName: rejects null and undefined", () => {
  assert.throws(() => resolveAgentName(null), /Invalid agent name/);
  assert.throws(() => resolveAgentName(undefined), /Invalid agent name/);
});

test("resolveAgentName: rejects path separators", () => {
  assert.throws(() => resolveAgentName("foo/bar"), /Invalid agent name/);
  assert.throws(() => resolveAgentName("foo\\bar"), /Invalid agent name/);
});

test("resolveAgentName: rejects shell injection", () => {
  assert.throws(() => resolveAgentName("x; rm -rf /"), /Invalid agent name/);
  assert.throws(() => resolveAgentName("$(whoami)"), /Invalid agent name/);
});

test("custom agent falls through to codex exec in _buildCommand", () => {
  const agent = makeAgent("aider");
  const cmd = agent._buildCommand("test prompt");
  assert.ok(cmd.startsWith("codex exec"));
});
