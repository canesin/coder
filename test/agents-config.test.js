import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiAgent } from "../src/agents/api-agent.js";
import { CliAgent } from "../src/agents/cli-agent.js";
import { CoderConfigSchema } from "../src/config.js";

function makeConfig(overrides = {}) {
  const base = CoderConfigSchema.parse({});
  return {
    ...base,
    ...overrides,
    models: {
      ...base.models,
      ...(overrides.models || {}),
    },
    workflow: {
      ...base.workflow,
      ...(overrides.workflow || {}),
    },
    claude: {
      ...base.claude,
      ...(overrides.claude || {}),
    },
    mcp: {
      ...base.mcp,
      ...(overrides.mcp || {}),
    },
  };
}

test("createApiAgent uses model entries and custom apiKeyEnv for gemini", () => {
  const config = makeConfig({
    models: {
      gemini: {
        model: "gemini-custom",
        apiEndpoint: "https://gemini.example/v1beta",
        openaiEndpoint: "",
        apiKeyEnv: "MY_GEMINI_KEY",
      },
    },
  });

  const agent = createApiAgent({
    config,
    secrets: { MY_GEMINI_KEY: "secret-1" },
    provider: "gemini",
  });

  assert.equal(agent.provider, "gemini");
  assert.equal(agent.endpoint, "https://gemini.example/v1beta");
  assert.equal(agent.apiKey, "secret-1");
  assert.equal(agent.model, "gemini-custom");
});

test("createApiAgent uses model entries and custom apiKeyEnv for anthropic", () => {
  const config = makeConfig({
    models: {
      claude: {
        model: "claude-custom",
        apiEndpoint: "https://anthropic.example",
        openaiEndpoint: "",
        apiKeyEnv: "MY_ANTHROPIC_KEY",
      },
    },
  });

  const agent = createApiAgent({
    config,
    secrets: { MY_ANTHROPIC_KEY: "secret-2" },
    provider: "anthropic",
  });

  assert.equal(agent.provider, "anthropic");
  assert.equal(agent.endpoint, "https://anthropic.example");
  assert.equal(agent.apiKey, "secret-2");
  assert.equal(agent.model, "claude-custom");
});

test("CliAgent builds commands using model strings from structured models config", () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "coder-agent-cmd-"));
  const config = makeConfig({
    models: {
      gemini: {
        model: "gemini-3-flash-preview",
        apiEndpoint: "https://generativelanguage.googleapis.com/v1beta",
        openaiEndpoint:
          "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKeyEnv: "GEMINI_API_KEY",
      },
      claude: {
        model: "claude-sonnet-4-6",
        apiEndpoint: "https://api.anthropic.com",
        openaiEndpoint: "",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      codex: {
        model: "gpt-5.3-codex",
        apiEndpoint: "https://api.openai.com",
        openaiEndpoint: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
  });

  const gemini = new CliAgent("gemini", {
    cwd: workspaceDir,
    secrets: {},
    config,
    workspaceDir,
    verbose: false,
  });
  const geminiStructured = gemini._buildCommand("hi", { structured: true });
  assert.match(
    geminiStructured,
    /gemini --yolo -m gemini-3-flash-preview -o json/,
  );

  const claude = new CliAgent("claude", {
    cwd: workspaceDir,
    secrets: {},
    config,
    workspaceDir,
    verbose: false,
  });
  const claudeCmd = claude._buildCommand("hi");
  assert.match(claudeCmd, /claude -p --model claude-sonnet-4-6/);

  const codex = new CliAgent("codex", {
    cwd: workspaceDir,
    secrets: {},
    config,
    workspaceDir,
    verbose: false,
  });
  const codexCmd = codex._buildCommand("hi");
  assert.match(
    codexCmd,
    /codex exec --model gpt-5\.3-codex --full-auto --skip-git-repo-check/,
  );
});
