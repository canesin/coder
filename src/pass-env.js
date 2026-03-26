/**
 * Default env var names passed into the agent sandbox (secret values only).
 *
 * Routing for Claude (base URL, model, auth token) comes from `models.claude` in
 * coder.json — see CliAgent. Do not duplicate ANTHROPIC_BASE_URL / ANTHROPIC_MODEL /
 * ANTHROPIC_AUTH_TOKEN here; list only the key holder (e.g. OPENROUTER_API_KEY) via
 * `models.claude.apiKeyEnv`, which resolvePassEnv merges automatically.
 */
export const DEFAULT_PASS_ENV = [
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "LINEAR_API_KEY",
];
