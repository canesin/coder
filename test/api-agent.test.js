import assert from "node:assert/strict";
import test from "node:test";
import { createApiAgent } from "../src/agents/api-agent.js";

const mockConfig = {
  models: {
    gemini: {
      model: "gemini-3-flash-preview",
      apiEndpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKeyEnv: "GEMINI_API_KEY",
      fallbackModel: "",
    },
    claude: {
      model: "claude-sonnet-4-6",
      apiEndpoint: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      fallbackModel: "",
    },
  },
};

const mockSecrets = {
  GEMINI_API_KEY: "test_gemini_key",
  ANTHROPIC_API_KEY: "test_anthropic_key",
};

test("createApiAgent gemini: model is a string from config.models.gemini.model", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: mockSecrets,
    provider: "gemini",
  });
  assert.equal(typeof agent.model, "string");
  assert.equal(agent.model, "gemini-3-flash-preview");
});

test("createApiAgent gemini: endpoint from config.models.gemini.apiEndpoint", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: mockSecrets,
    provider: "gemini",
  });
  assert.equal(typeof agent.endpoint, "string");
  assert.equal(
    agent.endpoint,
    "https://generativelanguage.googleapis.com/v1beta",
  );
});

test("createApiAgent gemini: apiKey from secrets[config.models.gemini.apiKeyEnv]", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: mockSecrets,
    provider: "gemini",
  });
  assert.equal(agent.apiKey, "test_gemini_key");
});

test("createApiAgent anthropic: model is a string from config.models.claude.model", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: mockSecrets,
    provider: "anthropic",
  });
  assert.equal(typeof agent.model, "string");
  assert.equal(agent.model, "claude-sonnet-4-6");
});

test("createApiAgent anthropic: endpoint from config.models.claude.apiEndpoint", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: mockSecrets,
    provider: "anthropic",
  });
  assert.equal(typeof agent.endpoint, "string");
  assert.equal(agent.endpoint, "https://api.anthropic.com");
});

test("createApiAgent anthropic: apiKey from secrets[config.models.claude.apiKeyEnv]", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: mockSecrets,
    provider: "anthropic",
  });
  assert.equal(agent.apiKey, "test_anthropic_key");
});

test("createApiAgent gemini: missing apiKey env falls back to empty string", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: {},
    provider: "gemini",
  });
  assert.equal(agent.apiKey, "");
});

test("createApiAgent anthropic: missing apiKey env falls back to empty string", () => {
  const agent = createApiAgent({
    config: mockConfig,
    secrets: {},
    provider: "anthropic",
  });
  assert.equal(agent.apiKey, "");
});
