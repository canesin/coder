import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("codex: default command uses bypass flag and skips full-auto", () => {
  const agent = makeAgent("codex");
  const cmd = agent._buildCommand("prompt", {});
  assert.ok(cmd.startsWith("codex exec "));
  assert.ok(cmd.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(cmd.includes("--skip-git-repo-check"));
  assert.ok(!cmd.includes("--full-auto"));
});

test("codex: resume command uses subcommand with bypass flag", () => {
  const agent = makeAgent("codex");
  const cmd = agent._buildCommand("prompt", { resumeId: "resume-123" });
  assert.ok(cmd.startsWith("codex exec resume 'resume-123' "));
  assert.ok(cmd.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(cmd.includes("--skip-git-repo-check"));
  assert.ok(!cmd.includes("--full-auto"));
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

function makeFakeSandbox() {
  const sandbox = new EventEmitter();
  sandbox.kill = () => Promise.resolve();
  sandbox.commands = {
    run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return sandbox;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("_ensureSandbox: concurrent calls coalesce to a single create()", async () => {
  const agent = makeAgent("claude");
  let createCount = 0;
  const sandbox = makeFakeSandbox();
  agent._provider = {
    create: () => {
      createCount++;
      return Promise.resolve(sandbox);
    },
  };

  const [s1, s2, s3] = await Promise.all([
    agent._ensureSandbox(),
    agent._ensureSandbox(),
    agent._ensureSandbox(),
  ]);

  assert.equal(createCount, 1);
  assert.equal(s1, sandbox);
  assert.equal(s2, sandbox);
  assert.equal(s3, sandbox);
});

test("_ensureSandbox: failed creation clears promise, allowing retry", async () => {
  const agent = makeAgent("claude");
  let createCount = 0;
  const sandbox = makeFakeSandbox();
  agent._provider = {
    create: () => {
      createCount++;
      if (createCount === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(sandbox);
    },
  };

  await assert.rejects(() => agent._ensureSandbox(), /boom/);
  assert.equal(agent._sandboxPromise, null);

  const result = await agent._ensureSandbox();
  assert.equal(result, sandbox);
  assert.equal(createCount, 2);
});

test("_ensureSandbox: kill() during in-flight creation aborts and kills sandbox", async () => {
  const agent = makeAgent("claude");
  const d = deferred();
  agent._provider = { create: () => d.promise };

  const ensurePromise = agent._ensureSandbox();

  await agent.kill();
  assert.equal(agent._sandboxPromise, null);

  let killCalled = false;
  const sandbox = makeFakeSandbox();
  sandbox.kill = () => {
    killCalled = true;
    return Promise.resolve();
  };
  d.resolve(sandbox);

  await assert.rejects(ensurePromise, { name: "AbortError" });
  assert.equal(killCalled, true);
  assert.equal(agent._sandbox, null);
});

test("_ensureSandbox: rejected first creation does not wipe second in-flight promise", async () => {
  const agent = makeAgent("claude");
  const d1 = deferred();
  const d2 = deferred();
  let createCount = 0;
  agent._provider = {
    create: () => {
      createCount++;
      return createCount === 1 ? d1.promise : d2.promise;
    },
  };

  const p1 = agent._ensureSandbox();
  await agent.kill();

  const p2 = agent._ensureSandbox();

  d1.reject(new Error("first failed"));
  await assert.rejects(p1, /first failed/);

  // Second promise must still be intact
  assert.notEqual(agent._sandboxPromise, null);

  const sandbox2 = makeFakeSandbox();
  d2.resolve(sandbox2);
  const result = await p2;
  assert.equal(result, sandbox2);
  assert.equal(agent._sandbox, sandbox2);
});
