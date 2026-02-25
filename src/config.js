import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import merge from "deepmerge";
import { z } from "zod";

const modelNameRegex = /^[a-zA-Z0-9._/-]+$/;

export const ModelEntrySchema = z.object({
  model: z.string().regex(modelNameRegex, "Invalid model name"),
  apiEndpoint: z.string().default(""),
  apiKeyEnv: z.string().default(""),
});

/** Preset defaults for ppcommit check strictness levels. */
export const PPCOMMIT_PRESETS = {
  strict: {},
  relaxed: {
    blockMagicNumbers: false,
    blockNarrationComments: false,
    blockNewMarkdown: false,
    blockWorkflowArtifacts: false,
  },
  minimal: {
    blockTodos: false,
    blockFixmes: false,
    blockNewMarkdown: false,
    blockWorkflowArtifacts: false,
    blockEmojisInCode: false,
    blockMagicNumbers: false,
    blockNarrationComments: false,
    blockLlmMarkers: false,
    blockPlaceholderCode: false,
    blockCompatHacks: false,
    blockOverEngineering: false,
    enableLlm: false,
  },
};

export const PpcommitConfigSchema = z.object({
  preset: z.enum(["strict", "relaxed", "minimal"]).default("strict"),
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
  llmModelRef: z.enum(["gemini", "claude", "codex"]).default("gemini"),
  llmServiceUrl: z.string().default(""),
  llmApiKey: z.string().default(""),
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

const agentNameRegex = /^[a-zA-Z0-9._-]+$/;
export const AgentNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    agentNameRegex,
    "Invalid agent name: only alphanumerics, dots, hyphens, underscores allowed",
  );

export const WorkflowAgentRolesSchema = z.object({
  issueSelector: AgentNameSchema.default("gemini"),
  planner: AgentNameSchema.default("claude"),
  planReviewer: AgentNameSchema.default("gemini"),
  programmer: AgentNameSchema.default("claude"),
  reviewer: AgentNameSchema.default("codex"),
  committer: AgentNameSchema.default("gemini"),
  coalesce: AgentNameSchema.default("codex"),
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

export const WorkflowTimeoutsSchema = z.object({
  researchStep: z.number().int().positive().default(600_000),
  webSearch: z.number().int().positive().default(900_000),
  pocValidation: z.number().int().positive().default(720_000),
  issueSelection: z.number().int().positive().default(600_000),
  issueDraft: z.number().int().positive().default(600_000),
  planning: z.number().int().positive().default(2_400_000),
  planReview: z.number().int().positive().default(2_400_000),
  implementation: z.number().int().positive().default(3_600_000),
  reviewRound: z.number().int().positive().default(1_800_000),
  programmerFix: z.number().int().positive().default(2_700_000),
  committerEscalation: z.number().int().positive().default(3_600_000),
  finalGate: z.number().int().positive().default(5_400_000),
  designStep: z.number().int().positive().default(600_000),
});

/** Optional per-step agent overrides (all fields optional, for MCP tool inputs). */
export const AgentRolesInputSchema = z.object({
  issueSelector: AgentNameSchema.optional(),
  planner: AgentNameSchema.optional(),
  planReviewer: AgentNameSchema.optional(),
  programmer: AgentNameSchema.optional(),
  reviewer: AgentNameSchema.optional(),
  committer: AgentNameSchema.optional(),
  coalesce: AgentNameSchema.optional(),
});

export const DesignConfigSchema = z.object({
  stitch: z
    .object({
      enabled: z.boolean().default(false),
      transport: z.enum(["stdio", "http"]).default("stdio"),
      serverCommand: z.string().default(""),
      serverUrl: z.string().default(""),
      apiKeyEnv: z.string().default("GOOGLE_STITCH_API_KEY"),
      authHeader: z.string().default("X-Goog-Api-Key"),
    })
    .prefault({}),
  specDir: z.string().default("spec/UI"),
});

export const HookSchema = z.object({
  on: z.enum([
    "machine_start",
    "machine_complete",
    "machine_error",
    "workflow_start",
    "workflow_complete",
    "workflow_failed",
    "loop_start",
    "loop_complete",
    "issue_start",
    "issue_complete",
    "issue_failed",
    "issue_skipped",
    "issue_deferred",
  ]),
  machine: z
    .string()
    .optional()
    .refine(
      (s) => {
        if (s === undefined) return true;
        try {
          new RegExp(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid regex pattern" },
    ),
  run: z.string().min(1),
});

export const GithubConfigSchema = z.object({
  useProjects: z.boolean().default(false),
  defaultLabels: z.array(z.string()).default([]),
  epicAsMilestone: z.boolean().default(true),
});

export const AgentRetrySchema = z.object({
  retries: z.number().int().min(0).default(1),
  backoffMs: z.number().int().min(0).default(5000),
  retryOnRateLimit: z.boolean().default(true),
});

export const AgentFallbackSchema = z
  .record(z.string(), AgentNameSchema)
  .prefault({});

export const CoderConfigSchema = z.object({
  models: z
    .object({
      gemini: ModelEntrySchema.default({
        model: "gemini-3-flash-preview",
        apiEndpoint: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
      }),
      claude: ModelEntrySchema.default({
        model: "claude-sonnet-4-6",
        apiEndpoint: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      }),
      codex: ModelEntrySchema.default({
        model: "gpt-5.3-codex",
        apiEndpoint: "https://api.openai.com",
        apiKeyEnv: "OPENAI_API_KEY",
      }),
    })
    .prefault({}),
  ppcommit: PpcommitConfigSchema.prefault({}),
  test: TestSectionSchema.prefault({}),
  claude: z
    .object({
      skipPermissions: z.boolean().default(true),
    })
    .prefault({}),
  mcp: z
    .object({
      strictStartup: z.boolean().default(false),
    })
    .prefault({}),
  workflow: z
    .object({
      agentRoles: WorkflowAgentRolesSchema.prefault({}),
      wip: WorkflowWipSchema.prefault({}),
      scratchpad: WorkflowScratchpadSchema.prefault({}),
      timeouts: WorkflowTimeoutsSchema.prefault({}),
      issueSource: z
        .enum(["github", "linear", "gitlab", "local"])
        .default("github"),
      localIssuesDir: z.string().default(""),
      hooks: z.array(HookSchema).default([]),
    })
    .prefault({}),
  design: DesignConfigSchema.prefault({}),
  github: GithubConfigSchema.prefault({}),
  agents: z
    .object({
      retry: AgentRetrySchema.prefault({}),
      fallback: AgentFallbackSchema,
    })
    .prefault({}),
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

/**
 * Resolve ppcommit LLM settings from the combined config.
 * Returns a flat object that ppcommit internals can consume directly.
 */
export function resolvePpcommitLlm(config) {
  const ref = config.ppcommit.llmModelRef || "gemini";
  const modelEntry = config.models[ref] || config.models.gemini;
  const serviceUrlOverride = (config.ppcommit.llmServiceUrl || "").trim();
  const derivedServiceUrl = `${modelEntry.apiEndpoint}/openai`;
  return {
    enableLlm: config.ppcommit.enableLlm,
    llmModel: modelEntry.model,
    llmServiceUrl: serviceUrlOverride || derivedServiceUrl,
    llmApiKeyEnv: modelEntry.apiKeyEnv,
    llmApiKey: config.ppcommit.llmApiKey || "",
  };
}

/**
 * Migrate old config shapes to the current schema.
 * - Flat string `models.gemini` → `{ model: "..." }`
 * - `agents.*Endpoint` → `models.*.apiEndpoint`
 * - Remove `geminiPreview`, `agents`
 */
export function migrateConfig(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };

  // Migrate flat string model entries to structured objects
  if (out.models && typeof out.models === "object") {
    const m = { ...out.models };
    if (typeof m.gemini === "string") {
      m.gemini = { model: m.gemini };
    }
    if (typeof m.claude === "string") {
      m.claude = { model: m.claude };
    }
    if (typeof m.codex === "string") {
      m.codex = { model: m.codex };
    }
    delete m.geminiPreview;
    out.models = m;
  }

  // Migrate old agents.*Endpoint keys into models; preserve retry/fallback
  if (out.agents && typeof out.agents === "object") {
    out.models = out.models || {};
    if (out.agents.geminiApiEndpoint) {
      if (typeof out.models.gemini === "object" && out.models.gemini) {
        out.models.gemini.apiEndpoint =
          out.models.gemini.apiEndpoint || out.agents.geminiApiEndpoint;
      } else if (!out.models.gemini) {
        out.models.gemini = { apiEndpoint: out.agents.geminiApiEndpoint };
      }
    }
    if (out.agents.anthropicApiEndpoint) {
      if (typeof out.models.claude === "object" && out.models.claude) {
        out.models.claude.apiEndpoint =
          out.models.claude.apiEndpoint || out.agents.anthropicApiEndpoint;
      } else if (!out.models.claude) {
        out.models.claude = { apiEndpoint: out.agents.anthropicApiEndpoint };
      }
    }
    // Drop migrated endpoint keys; keep retry/fallback for the new schema
    const {
      geminiApiEndpoint: _g,
      anthropicApiEndpoint: _a,
      ...rest
    } = out.agents;
    out.agents = Object.keys(rest).length ? rest : undefined;
  }

  // Migrate ppcommit flat LLM fields to llmModelRef
  if (out.ppcommit && typeof out.ppcommit === "object") {
    const pp = { ...out.ppcommit };
    if ("llmModel" in pp) delete pp.llmModel;
    if ("llmApiKeyEnv" in pp) delete pp.llmApiKeyEnv;
    out.ppcommit = pp;
  }

  return out;
}

export function loadConfig(workspaceDir) {
  const userRaw = readJson(userConfigPath());
  const repoRaw = readJson(repoConfigPath(workspaceDir));
  const merged = deepMerge(userRaw, repoRaw);
  return CoderConfigSchema.parse(migrateConfig(merged));
}

export function resolveConfig(workspaceDir, overrides) {
  const base = loadConfig(workspaceDir);
  if (!overrides) return base;
  const raw = deepMerge(structuredClone(base), overrides);
  return CoderConfigSchema.parse(raw);
}
