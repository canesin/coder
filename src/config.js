import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
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
  enableGemini: z.boolean().default(true),
  geminiModel: z.string().default("gemini-3-flash-preview"),
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

export const CoderConfigSchema = z.object({
  models: z.object({
    gemini: z.string().default("gemini-2.5-flash"),
    geminiPreview: z.string().default("gemini-3-flash-preview"),
    claude: z.string().default("claude-opus-4-6"),
  }).default({}),
  ppcommit: PpcommitConfigSchema.default({}),
  test: TestSectionSchema.default({}),
  claude: z.object({
    skipPermissions: z.boolean().default(true),
  }).default({}),
  mcp: z.object({
    strictStartup: z.boolean().default(false),
  }).default({}),
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
  if (override === null || typeof override !== "object" || Array.isArray(override)) return override;
  if (!base || typeof base !== "object" || Array.isArray(base)) return override;
  return merge(base, dropUndefined(override), { arrayMerge: overwriteMerge });
}

function readJson(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
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
  const raw = deepMerge(JSON.parse(JSON.stringify(base)), overrides);
  return CoderConfigSchema.parse(raw);
}
