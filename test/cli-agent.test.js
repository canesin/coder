import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { CliAgent } from "../src/agents/cli-agent.js";

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

test("gemini: malicious sessionId is shell-escaped", () => {
  const agent = makeAgent("gemini");
  const cmd = agent._buildCommand("prompt", { sessionId: MALICIOUS });
  assert.ok(cmd.includes(`--sandbox-id ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`--sandbox-id '; touch`));
});

test("gemini: malicious resumeId is shell-escaped", () => {
  const agent = makeAgent("gemini");
  const cmd = agent._buildCommand("prompt", { resumeId: MALICIOUS });
  assert.ok(cmd.includes(`--sandbox-id ${ESCAPED_MALICIOUS}`));
  assert.ok(!cmd.includes(`--sandbox-id '; touch`));
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
