import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import merge from "deepmerge";
import { z } from "zod";

export const PpcommitConfigSchema = z.object({
  skip: z.boolean().default(false),
  blockSecrets: z.boolean().default(true),
  blockTodos: z.boolean().default(true),
  blockFixmes: z.boolean().default(true),
  blockNewMarkdown: z.boolean().default(true),
  blockWorkflowArtifacts: z.boolean().default(true),
  blockEmojisInCode: z.boolean().default(true),
  blockMagicNumbers: z.boolean().default(true),
  blockNarrationComments: z.boolean().default(true),
  blockLlmMarkers: z.boolean().default(true),
  blockPlaceholderCode: z.boolean().default(true),
  blockCompatHacks: z.boolean().default(true),
  blockOverEngineering: z.boolean().default(true),
  treatWarningsAsErrors: z.boolean().default(false),
  enableLlm: z.boolean().default(true),
  llmServiceUrl: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta/openai"),
  llmApiKey: z.string().default(""),
  llmApiKeyEnv: z.string().default("GEMINI_API_KEY"),
  llmModel: z.string().default("gemini-3-flash-preview"),
});

export const TestSectionSchema = z.object({
  setup: z.array(z.string()).default([]),
  healthCheck: z
    .object({
      url: z.string(),
      retries: z.number().int().positive().default(30),
      intervalMs: z.number().int().positive().default(2000),
    })
    .nullable()
    .default(null),
  command: z.string().default(""),
  teardown: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600000),
  allowNoTests: z.boolean().default(false),
});

export const AgentNameSchema = z.enum(["gemini", "claude", "codex"]);

export const WorkflowAgentRolesSchema = z.object({
  issueSelector: AgentNameSchema.default("gemini"),
  planner: AgentNameSchema.default("claude"),
  planReviewer: AgentNameSchema.default("gemini"),
  programmer: AgentNameSchema.default("claude"),
  reviewer: AgentNameSchema.default("codex"),
  committer: AgentNameSchema.default("codex"),
});

export const WorkflowWipSchema = z.object({
  push: z.boolean().default(true),
  autoCommit: z.boolean().default(true),
  includeUntracked: z.boolean().default(false),
  remote: z.string().default("origin"),
  failOnError: z.boolean().default(false),
});

export const WorkflowScratchpadSchema = z.object({
  sqliteSync: z.boolean().default(true),
  sqlitePath: z.string().default(".coder/state.db"),
});

/** Optional per-step agent overrides (all fields optional, for MCP tool inputs). */
export const AgentRolesInputSchema = z.object({
  issueSelector: AgentNameSchema.optional(),
  planner: AgentNameSchema.optional(),
  planReviewer: AgentNameSchema.optional(),
  programmer: AgentNameSchema.optional(),
  reviewer: AgentNameSchema.optional(),
  committer: AgentNameSchema.optional(),
});

export const DesignConfigSchema = z.object({
  stitch: z
    .object({
      enabled: z.boolean().default(false),
      serverCommand: z.string().default(""),
      apiKeyEnv: z.string().default("GOOGLE_STITCH_API_KEY"),
    })
    .default({}),
  specDir: z.string().default("spec/UI"),
});

export const GithubConfigSchema = z.object({
  useProjects: z.boolean().default(false),
  defaultLabels: z.array(z.string()).default([]),
  epicAsMilestone: z.boolean().default(true),
});

export const AgentsConfigSchema = z.object({
  preferApi: z.boolean().default(false),
  geminiApiEndpoint: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta"),
  anthropicApiEndpoint: z.string().default("https://api.anthropic.com"),
});

export const CoderConfigSchema = z.object({
  models: z
    .object({
      gemini: z
        .string()
        .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid model name")
        .default("gemini-2.5-flash"),
      geminiPreview: z
        .string()
        .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid model name")
        .default("gemini-3-flash-preview"),
      claude: z
        .string()
        .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid model name")
        .default("claude-opus-4-6"),
    })
    .default({}),
  ppcommit: PpcommitConfigSchema.default({}),
  test: TestSectionSchema.default({}),
  claude: z
    .object({
      skipPermissions: z.boolean().default(true),
    })
    .default({}),
  mcp: z
    .object({
      strictStartup: z.boolean().default(false),
    })
    .default({}),
  workflow: z
    .object({
      agentRoles: WorkflowAgentRolesSchema.default({}),
      wip: WorkflowWipSchema.default({}),
      scratchpad: WorkflowScratchpadSchema.default({}),
    })
    .default({}),
  design: DesignConfigSchema.default({}),
  github: GithubConfigSchema.default({}),
  agents: AgentsConfigSchema.default({}),
  verbose: z.boolean().default(false),
});

export function userConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "coder");
}

export function userConfigPath() {
  return path.join(userConfigDir(), "config.json");
}

export function repoConfigPath(workspaceDir) {
  return path.join(workspaceDir, "coder.json");
}

// Arrays replace (not concat); undefined keys are dropped before merging.
const overwriteMerge = (_target, source) => source;

function dropUndefined(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = dropUndefined(v);
  }
  return out;
}

export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (
    override === null ||
    typeof override !== "object" ||
    Array.isArray(override)
  )
    return override;
  if (!base || typeof base !== "object" || Array.isArray(base)) return override;
  return merge(base, dropUndefined(override), { arrayMerge: overwriteMerge });
}

function readJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    process.stderr.write(
      `[coder] Warning: failed to parse ${filePath}: ${err.message}\n`,
    );
    return {};
  }
}

export function loadConfig(workspaceDir) {
  const userRaw = readJson(userConfigPath());
  const repoRaw = readJson(repoConfigPath(workspaceDir));
  const merged = deepMerge(userRaw, repoRaw);
  return CoderConfigSchema.parse(merged);
}

export function resolveConfig(workspaceDir, overrides) {
  const base = loadConfig(workspaceDir);
  if (!overrides) return base;
  const raw = deepMerge(structuredClone(base), overrides);
  return CoderConfigSchema.parse(raw);
}
