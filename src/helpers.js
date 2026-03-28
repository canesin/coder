import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import { DEFAULT_PASS_ENV } from "./pass-env.js";
import { runPpcommitBranch, runPpcommitNative } from "./ppcommit.js";
import { runShellSync } from "./systemd-run.js";
import {
  assertTestCommandPathsExist,
  resolveMonorepoTestCwd,
} from "./test-command-paths.js";
import {
  detectTestCommand,
  isUnifiedCoderJsonTestConfigPath,
  isWorkspaceScopedRepo,
  loadTestConfig,
  runTestCommand,
  runTestConfig,
} from "./test-runner.js";

export function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    let spawnError;
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        stdout += d;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        stderr += d;
      });
    }
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code, sig) => {
      let error = spawnError;
      if (!error && sig) {
        error = Object.assign(new Error(`Command killed with signal ${sig}`), {
          code: sig === "SIGTERM" ? "ETIMEDOUT" : "ABORT_ERR",
          signal: sig,
        });
      }
      resolve({ stdout, stderr, status: code, signal: sig, error });
    });
  });
}

/** Throw if a spawnAsync result carries an abort or timeout error. */
export function throwIfAborted(res) {
  if (
    res.error &&
    (res.error.code === "ABORT_ERR" || res.error.code === "ETIMEDOUT")
  ) {
    throw res.error;
  }
}

/**
 * Detect the default branch for a git repository.
 * Tries `git symbolic-ref --short refs/remotes/origin/HEAD` first,
 * then falls back to checking if `main` exists, else `master`.
 *
 * @param {string} repoDir - Path to the git repository
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string>} The default branch name
 */
export async function detectDefaultBranch(repoDir, { signal } = {}) {
  const originHead = await spawnAsync(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repoDir, signal },
  );
  throwIfAborted(originHead);
  if (originHead.status === 0) {
    const raw = (originHead.stdout || "").trim();
    if (raw.startsWith("origin/") && raw.length > "origin/".length) {
      const branch = raw.slice("origin/".length);
      const verify = await spawnAsync("git", ["rev-parse", "--verify", raw], {
        cwd: repoDir,
        signal,
      });
      throwIfAborted(verify);
      if (verify.status === 0) return branch;
    }
  }

  const mainCheck = await spawnAsync("git", ["rev-parse", "--verify", "main"], {
    cwd: repoDir,
    signal,
  });
  throwIfAborted(mainCheck);
  if (mainCheck.status === 0) return "main";

  const masterCheck = await spawnAsync(
    "git",
    ["rev-parse", "--verify", "master"],
    { cwd: repoDir, signal },
  );
  throwIfAborted(masterCheck);
  if (masterCheck.status === 0) return "master";

  throw new Error(
    "Could not detect default branch; origin/HEAD, main, and master are unavailable or absent.",
  );
}

/**
 * Check if the default branch has tracking config. If missing, log a warning.
 * Skips check when repo has no origin (local-only); pull would fail anyway.
 * @param {string} repoDir - Path to the git repository
 * @param {string} defaultBranch - Default branch name (e.g. main)
 * @param {(obj: object) => void} log - Logger function
 * @returns {boolean} true if tracking is configured or no remote exists
 */
export async function checkDefaultBranchTracking(
  repoDir,
  defaultBranch,
  log,
  { signal } = {},
) {
  const hasOrigin = await spawnAsync("git", ["remote", "get-url", "origin"], {
    cwd: repoDir,
    signal,
  });
  throwIfAborted(hasOrigin);
  if (hasOrigin.status !== 0) return true; // No remote; tracking check N/A

  const remote = await spawnAsync(
    "git",
    ["config", "--get", `branch.${defaultBranch}.remote`],
    { cwd: repoDir, signal },
  );
  throwIfAborted(remote);
  const merge = await spawnAsync(
    "git",
    ["config", "--get", `branch.${defaultBranch}.merge`],
    { cwd: repoDir, signal },
  );
  throwIfAborted(merge);
  if (remote.status !== 0 || merge.status !== 0) {
    const remoteName = getDefaultBranchRemoteName(repoDir, defaultBranch);
    log({
      event: "git_tracking_missing",
      defaultBranch,
      suggestion: `Run: git branch --set-upstream-to=${remoteName}/${defaultBranch} ${defaultBranch}`,
    });
    return false;
  }
  return true;
}

/**
 * Get the remote name for the default branch's upstream, or a fallback.
 * @param {string} repoDir - Path to the git repository
 * @param {string} defaultBranch - Default branch name (e.g. main)
 * @returns {string} Remote name (e.g. origin, upstream)
 */
export function getDefaultBranchRemoteName(repoDir, defaultBranch) {
  const res = spawnSync(
    "git",
    ["config", "--get", `branch.${defaultBranch}.remote`],
    { cwd: repoDir, encoding: "utf8" },
  );
  const configured = (res.stdout || "").trim();
  if (configured) return configured;
  const remotes = spawnSync("git", ["remote"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const list = (remotes.stdout || "").trim().split(/\s+/).filter(Boolean);
  return list.includes("origin") ? "origin" : list[0] || "origin";
}

/** Patterns indicating upstream ref was deleted or never existed (stale tracking). */
const STALE_UPSTREAM_PATTERNS = [
  /couldn't find remote ref/i,
  /no such ref was fetched/i,
  /no such ref/i,
  /your configuration specifies to merge with .* from the remote, but no such ref was fetched/i,
  /refs\/heads\/[^\s]+ does not exist/i,
];

/**
 * Detect if git pull stderr indicates a stale/deleted upstream ref.
 * @param {string} stderr - Git pull stderr output
 * @returns {boolean}
 */
export function isStaleUpstreamRefError(stderr) {
  const text = String(stderr || "").trim();
  return STALE_UPSTREAM_PATTERNS.some((re) => re.test(text));
}

/**
 * Detect repository hosting type from remote URL.
 *
 * @param {string} repoDir - Path to the git repository
 * @param {string} [remoteName="origin"] - Remote name to inspect
 * @returns {"github" | "gitlab"}
 */
export function detectRemoteType(repoDir, remoteName = "origin") {
  const origin = spawnSync("git", ["remote", "get-url", remoteName], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (origin.status !== 0) return "github";
  const url = (origin.stdout || "").trim();
  const httpsMatch = url.match(/^https?:\/\/([^/:]+)/i);
  const sshMatch = url.match(/^[^@]+@([^:]+):/);
  const host = (httpsMatch?.[1] || sshMatch?.[1] || "").toLowerCase();
  if (host.includes("gitlab")) return "gitlab";
  return "github";
}

export { DEFAULT_PASS_ENV };

/** Default API key env names when a model entry omits apiKeyEnv entirely. */
const DEFAULT_MODEL_KEY_ENV = {
  gemini: "GEMINI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

/** Collect apiKeyEnv names from models.* so secrets are passed without duplicating them in passEnv. */
function modelApiKeyEnvNames(config) {
  const models = config.models;
  if (!models || typeof models !== "object") return [];
  const out = [];
  for (const role of ["gemini", "claude", "codex"]) {
    const entry = models[role];
    if (!entry || typeof entry !== "object") continue;
    // Only fall back to the built-in default when apiKeyEnv is undefined
    // (omitted).  An explicit empty string means "don't forward any key".
    const name =
      entry.apiKeyEnv === undefined
        ? DEFAULT_MODEL_KEY_ENV[role]
        : entry.apiKeyEnv;
    if (typeof name === "string" && name.trim()) out.push(name.trim());
  }
  return out;
}

/**
 * Build the effective passEnv list from config.
 * Merges `sandbox.passEnv` (explicit names), `models.*.apiKeyEnv`, and any env var names
 * matching `sandbox.passEnvPatterns` (glob-style, e.g. "AWS_*").
 *
 * @param {object} config - Parsed CoderConfigSchema
 * @param {object} [env] - Environment to scan for pattern matches (defaults to process.env)
 * @returns {string[]} Deduplicated list of env var names to pass through
 */
export function resolvePassEnv(config, env = process.env) {
  const explicit = config.sandbox?.passEnv ?? DEFAULT_PASS_ENV;
  const fromModels = modelApiKeyEnvNames(config);
  const mergedExplicit = [...new Set([...explicit, ...fromModels])];
  const patterns = config.sandbox?.passEnvPatterns ?? [];

  if (patterns.length === 0) return mergedExplicit;

  const regexes = patterns.map((p) => {
    // Convert simple glob pattern to regex (only * wildcards supported)
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  });

  const matched = Object.keys(env).filter((key) =>
    regexes.some((re) => re.test(key)),
  );

  return [...new Set([...mergedExplicit, ...matched])];
}

const AGENT_NOISE_LINE_PATTERNS = [
  /^Warning:/i,
  /Skipping extension in .*Configuration file not found/i,
  /YOLO mode/i,
  /Loading extension/i,
  /Hook registry/i,
  /Server '/i,
  /supports tool updates/i,
  /Listening for changes/i,
  /Found stored OAuth/i,
  /rejected stored OAuth token/i,
  /Please re-authenticate using:\s*\/mcp auth/i,
  /Both GOOGLE_API_KEY and GEMINI_API_KEY are set/i,
  /\bUsing GOOGLE_API_KEY\b/i,
  /updated for server:/i,
  /Tools changed,\s*updating Gemini context/i,
  /Received (?:resource|prompt|tool) update notification/i,
  /^\[INFO\]\s*(?:Tools|Prompts|Resources) updated for server:/i,
  /^Resources updated for server:/i,
  /^Prompts updated for server:/i,
  /^Tools updated for server:/i,
  /^🔔\s*/u,
  /^Prompt with name\b/,
];

export class TestInfrastructureError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TestInfrastructureError";
    this.details = details;
  }
}

export { TestCommandPathError } from "./test-command-paths.js";

export function requireEnvOneOf(names) {
  const resolved = buildSecretsWithFallback(names);
  for (const n of names) {
    if (resolved[n]) return;
  }
  throw new Error(`Missing required env var: one of ${names.join(", ")}`);
}

export function requireCommandOnPath(name) {
  const res = spawnSync(
    "bash",
    ["-lc", `command -v ${shellEscape(name)} >/dev/null 2>&1`],
    {
      encoding: "utf8",
    },
  );
  if (res.status !== 0)
    throw new Error(`Required command not found on PATH: ${name}`);
}

export function buildSecrets(passEnv) {
  return buildSecretsWithFallback(passEnv);
}

function isSafeEnvName(name) {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

function readEnvFromLoginShell(name) {
  if (!isSafeEnvName(name)) return "";
  const script = `printf '%s' "\${${name}:-}"`;
  const res = spawnSync("bash", ["-lc", script], { encoding: "utf8" });
  if (res.status !== 0) return "";
  return (res.stdout || "").trim();
}

function applyGeminiKeyAliases(secrets) {
  // Gemini CLI currently requires GEMINI_API_KEY in some modes.
  // Mirror GOOGLE_API_KEY when only one of the two is present.
  if (!secrets.GEMINI_API_KEY && secrets.GOOGLE_API_KEY) {
    secrets.GEMINI_API_KEY = secrets.GOOGLE_API_KEY;
  }
  if (!secrets.GOOGLE_API_KEY && secrets.GEMINI_API_KEY) {
    secrets.GOOGLE_API_KEY = secrets.GEMINI_API_KEY;
  }
}

export function buildSecretsWithFallback(
  passEnv,
  { env = process.env, shellLookup = readEnvFromLoginShell } = {},
) {
  /** @type {Record<string, string>} */
  const secrets = {};
  for (const key of passEnv) {
    const val = env[key] || shellLookup(key);
    if (val) secrets[key] = val;
  }
  applyGeminiKeyAliases(secrets);
  return secrets;
}

export function formatCommandFailure(label, res, { maxLen = 1200 } = {}) {
  const exit = typeof res?.exitCode === "number" ? res.exitCode : "unknown";
  const raw = `${res?.stderr || ""}\n${res?.stdout || ""}`.trim();
  const filteredRaw = stripAgentNoise(raw).trim();
  let detail = filteredRaw || raw || "No stdout/stderr captured.";

  // Try to surface the nested JSON error from gemini CLI when present.
  if (raw) {
    try {
      const parsed = extractJson(raw);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {
      // best-effort parsing only
    }
  }

  if (detail.length > maxLen) {
    // Keep the tail: errors are usually at the end, and the head is often MCP startup noise.
    detail = "…" + detail.slice(-maxLen);
  }
  const hint =
    /must specify the GEMINI_API_KEY environment variable/i.test(raw) ||
    /GEMINI_API_KEY/i.test(detail)
      ? " Hint: set GEMINI_API_KEY (GOOGLE_API_KEY is also accepted and auto-aliased)."
      : "";
  return `${label} (exit ${exit}).${hint}\n${detail}`;
}

export function extractJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Empty response — no JSON to extract.");

  // Fast path: input starts with { or [ — likely already JSON (possibly malformed).
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      return JSON.parse(jsonrepair(trimmed));
    } catch {
      /* fall through */
    }
  }

  // Extract from markdown code fence.
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(jsonrepair(fenced[1].trim()));
    } catch {
      /* fall through */
    }
  }

  // Extract the outermost { … } or [ … ] from surrounding prose.
  const open = trimmed.search(/[{[]/);
  if (open !== -1) {
    const isArray = trimmed[open] === "[";
    const close = trimmed.lastIndexOf(isArray ? "]" : "}");
    if (close > open) {
      try {
        return JSON.parse(jsonrepair(trimmed.slice(open, close + 1)));
      } catch {
        /* fall through */
      }
    }
  }

  const preview = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
  throw new Error(`No JSON object found in response. Preview:\n${preview}`);
}

/**
 * Parse Gemini output where `-o json` returns an envelope with a `response`
 * field that may itself contain JSON (often fenced markdown).
 */
const GEMINI_ENVELOPE_INNER_PARSE_PREFIX =
  "[coder] Gemini -o json: could not parse issues payload from envelope response";
const GEMINI_ENVELOPE_BAD_RESPONSE_PREFIX =
  "[coder] Gemini -o json: envelope response field is missing or not a usable issues payload";

/** @param {unknown} obj */
function isIssuesPayloadShape(obj) {
  return (
    !!obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Array.isArray(/** @type {{ issues?: unknown }} */ (obj).issues) &&
    typeof (
      /** @type {{ recommended_index?: unknown }} */ (obj).recommended_index
    ) === "number"
  );
}

export function extractGeminiPayloadJson(stdout) {
  const parsed = extractJson(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  // Direct issues payload (no envelope wrapper)
  if (isIssuesPayloadShape(parsed)) {
    return parsed;
  }

  // Standard envelope: { response: "..." }
  if (typeof parsed.response === "string") {
    /** @type {unknown} */
    let lastInnerError;
    try {
      return extractJson(parsed.response);
    } catch (e) {
      lastInnerError = e;
      // Some envelopes encode escaped newlines (e.g. "\\n") literally.
      try {
        const normalized = parsed.response
          .replace(/\\r\\n/g, "\n")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t");
        return extractJson(normalized);
      } catch (e2) {
        lastInnerError = e2;
      }
    }
    const raw = parsed.response;
    const preview = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
    const err = new Error(`${GEMINI_ENVELOPE_INNER_PARSE_PREFIX}\n${preview}`);
    if (lastInnerError instanceof Error) err.cause = lastInnerError;
    throw err;
  }

  // Session envelope: { session_id: "...", response: ... }
  if (
    typeof (/** @type {{ session_id?: unknown }} */ (parsed).session_id) ===
    "string"
  ) {
    // Return any non-null object payload (issues, web-research, poc-runner, etc.)
    if (
      parsed.response &&
      typeof parsed.response === "object" &&
      !Array.isArray(parsed.response)
    ) {
      return /** @type {object} */ (parsed.response);
    }
    let preview;
    if (parsed.response === undefined) {
      preview = "(response field missing)";
    } else if (parsed.response === null) {
      preview = "(response is null)";
    } else {
      try {
        const s = JSON.stringify(parsed.response);
        preview = s.length > 400 ? `${s.slice(0, 400)}…` : s;
      } catch {
        preview = String(parsed.response);
      }
    }
    throw new Error(`${GEMINI_ENVELOPE_BAD_RESPONSE_PREFIX}\n${preview}`);
  }

  return parsed;
}

export function geminiJsonPipe(prompt) {
  return heredocPipe(prompt, "gemini --yolo -o json");
}

/**
 * Extract the model name string from a config entry that may be
 * either a plain string or an object with a `.model` property.
 */
export function resolveModelName(entry) {
  if (typeof entry === "object" && entry) return entry.model;
  return entry;
}

export function shellEscape(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

export function isRateLimitError(text) {
  const s = String(text || "");
  return (
    /rate limit|429|resource_exhausted|quota/i.test(s) ||
    /out\s+of\s+extra\s+usage|usage\s+limit/i.test(s)
  );
}

export function geminiJsonPipeWithModel(prompt, model) {
  const modelArg = String(resolveModelName(model) || "").trim();
  const cmd = modelArg
    ? `gemini --yolo -m ${shellEscape(modelArg)} -o json`
    : "gemini --yolo -o json";
  return heredocPipe(prompt, cmd);
}

export function heredocPipe(text, pipeCmd) {
  const marker = `CODER_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  if (text.includes(marker)) {
    return heredocPipe(text + "\n", pipeCmd);
  }
  const normalized = text.replace(/\r\n/g, "\n");
  return `cat <<'${marker}' | ${pipeCmd}\n${normalized}\n${marker}`;
}

function isAgentNoiseLine(line) {
  return AGENT_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function stripAgentNoise(text, { dropLeadingOnly = false } = {}) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  if (dropLeadingOnly) {
    let start = 0;
    while (
      start < lines.length &&
      (lines[start].trim() === "" || isAgentNoiseLine(lines[start]))
    ) {
      start += 1;
    }
    return lines.slice(start).join("\n");
  }
  return lines.filter((line) => !isAgentNoiseLine(line)).join("\n");
}

export function sanitizeIssueMarkdown(text) {
  // Drop leading startup noise (common) and then remove any remaining noise lines
  // anywhere in the document (MCP notifications can leak mid/late output).
  const cleaned = stripAgentNoise(text, { dropLeadingOnly: true });
  const fullyCleaned = stripAgentNoise(cleaned).trim();
  if (!fullyCleaned) return "";
  // Strip outer markdown code fence if the agent wrapped the output (e.g. Gemini).
  const fenceMatch = fullyCleaned.match(
    /^```(?:markdown)?\s*\n([\s\S]*?)\n?```\s*$/i,
  );
  const unwrapped = fenceMatch ? fenceMatch[1].trim() : fullyCleaned;
  const lines = unwrapped.split("\n");
  const firstHeader = lines.findIndex((line) => line.trim().startsWith("#"));
  if (firstHeader > 0) return lines.slice(firstHeader).join("\n").trim();
  return unwrapped;
}

export function sanitizeUserData(text) {
  return String(text == null ? "" : text).replace(/<\/?user-data[^>]*>/gi, "");
}

export function buildPrBodyFromIssue(issueMd, { maxLines = 10 } = {}) {
  const cleaned = sanitizeIssueMarkdown(issueMd);
  if (!cleaned) return "";
  const lines = cleaned.split("\n");
  const head = lines.slice(0, Math.max(1, maxLines));
  return head.join("\n").trim();
}

export function gitCleanOrThrow(repoDir) {
  const res = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error("Failed to run `git status`.");
  const ignorePatterns = [
    ".coder/",
    ".gemini/",
    ".gitignore",
    ".geminiignore",
  ].map((p) => p.replace(/\\/g, "/"));

  const isIgnored = (filePath) => {
    return ignorePatterns.some((pattern) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      if (pattern.endsWith("/")) {
        return normalizedPath.startsWith(pattern);
      }
      if (pattern.includes("/")) {
        return (
          normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`)
        );
      }
      return normalizedPath === pattern;
    });
  };

  const lines = (res.stdout || "").split("\n").filter((l) => {
    if (l.trim() === "") return false;
    const pathField = l.slice(3); // skip status prefix (e.g. "?? " or " M ")
    const filePath = pathField.includes(" -> ")
      ? pathField.split(" -> ").pop() || pathField
      : pathField;
    return !isIgnored(filePath);
  });
  if (lines.length > 0) {
    throw new Error(
      `Repo working tree is not clean: ${repoDir}\n${lines.join("\n")}`,
    );
  }
}

export function runPlanreview(repoDir, planPath, critiquePath) {
  return runPlanreviewWithGemini(repoDir, planPath, critiquePath);
}

/**
 * Run plan review using gemini CLI directly (with native search grounding).
 * This alternative to the planreview tool better leverages Gemini's
 * ability to search for and verify external API documentation.
 */
export function runPlanreviewWithGemini(repoDir, planPath, critiquePath) {
  const planContent = readFileSync(planPath, "utf8");

  const reviewPrompt = `You are a rigorous, experienced senior principal engineer reviewing a technical plan.

## CRITICAL: Verify External Dependencies

This plan references external libraries/crates/packages. You MUST:
1. **CHECK THE ACTUAL SOURCE** - If a GitHub URL is mentioned, read the README.md and docs/ folder directly
2. For git dependencies, fetch raw files like: https://raw.githubusercontent.com/OWNER/REPO/main/docs/FILE.md
3. Verify the proposed API usage matches the real library's interface
4. Check if functions/methods mentioned actually exist in those libraries
5. Do NOT trust the plan's claims about external APIs - verify them by reading source/docs

## CRITICAL: Detect Over-Engineering

Flag as issues:
1. **Unnecessary abstractions** - wrapper classes, factory patterns, or interfaces for simple operations
2. **Premature generalization** - configuration options, plugin systems, or extensibility not required by the issue
3. **Future-proofing** - code designed for hypothetical future requirements
4. **Reinventing wheels** - custom implementations when standard library or existing codebase utilities exist
5. **Excessive layering** - more than 2 levels of indirection for simple operations

## CRITICAL: Scope Conformance

Compare plan to original issue (ISSUE.md should exist in the repo):
1. Does it add features NOT requested?
2. Does it refactor code unrelated to the issue?
3. Does it change interfaces/APIs beyond what's needed?
4. Does it modify more files than necessary?

## CRITICAL: Codebase Consistency

1. Does the plan follow existing patterns in the codebase?
2. Are naming conventions consistent with existing code?
3. Does it use existing utilities instead of creating new ones?

## Your Mandate

Be analytically rigorous. Find flaws, gaps, risks, and over-engineering BEFORE implementation.

Focus on:
1. **Feasibility**: Can this actually be implemented? Are the APIs real?
2. **Completeness**: What's missing? What edge cases are ignored?
3. **Correctness**: Are there logical flaws or misunderstandings?
4. **Dependencies**: Are the external library APIs correctly described?
5. **Simplicity**: Is this the simplest solution? What can be removed?
6. **Scope**: Does this stay within the original issue's requirements?

## The Plan to Review

${planContent}

## Your Critique

After verifying external APIs via search, provide your critique:

### Critical Issues (Must Fix)
Issues that would cause the plan to fail or violate constraints.

### Over-Engineering Concerns
Unnecessary complexity, abstractions, or scope creep.

### Concerns (Should Address)
Problems that should be addressed but won't cause immediate failure.

### Questions (Need Clarification)
Ambiguities or assumptions that need to be verified.

### Verdict
IMPORTANT: Your verdict line MUST be exactly one of these four options, with no other words:
- REJECT
- REVISE
- PROCEED WITH CAUTION
- APPROVED

Do NOT paraphrase (e.g. do not write "Needs Revision" or "Needs Rework"). Write the exact keyword.

Be specific. Reference what you found in your searches about the external APIs.
Reference specific sections in the plan when identifying over-engineering.`;

  // Use gemini CLI with yolo mode and text output
  const cmd = heredocPipe(reviewPrompt, "gemini --yolo -o text");
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 900000, // 15 minute timeout
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
  });

  // Detect timeout: spawnSync sets status=null, signal='SIGTERM' on timeout
  const timedOut =
    result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT";

  const output = (result.stdout || "") + (result.stderr || "");
  // Two-pass sanitization: strip leading noise first, then remove any remaining
  // embedded MCP lines (same approach as sanitizeIssueMarkdown).
  const cleaned = stripAgentNoise(output, { dropLeadingOnly: true });
  const filtered = stripAgentNoise(cleaned).trim();
  let critique = filtered;
  const critiqueLines = filtered.split("\n");
  const firstHeader = critiqueLines.findIndex((line) =>
    line.trim().startsWith("#"),
  );
  if (firstHeader > 0) {
    critique = critiqueLines.slice(firstHeader).join("\n").trim();
  }

  if (timedOut) {
    const partial = critique || "(review timed out — no output captured)";
    writeFileSync(critiquePath, `${partial}\n`);
    return 1;
  }

  writeFileSync(critiquePath, `${critique}\n`);
  return result.status ?? 0;
}

export async function runPpcommit(repoDir, ppcommitConfig) {
  return await runPpcommitNative(repoDir, ppcommitConfig);
}

export async function runPpcommitScoped(repoDir, baseBranch, ppcommitConfig) {
  if (baseBranch)
    return await runPpcommitBranch(repoDir, baseBranch, ppcommitConfig);
  return await runPpcommitNative(repoDir, ppcommitConfig);
}

export function computeGitWorktreeFingerprint(repoDir) {
  const runGit = (args) => {
    const res = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    if (res.status !== 0) {
      const msg = (res.stderr || res.stdout || "").trim();
      throw new Error(`git ${args.join(" ")} failed${msg ? `: ${msg}` : ""}`);
    }
    return res.stdout || "";
  };

  const statusZ = runGit(["status", "--porcelain=v1", "-z"]);
  const diff = runGit(["diff", "--no-ext-diff"]);
  const diffCached = runGit(["diff", "--cached", "--no-ext-diff"]);

  // Include untracked file contents in the fingerprint (git diff won't).
  const untrackedZ = runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untrackedPaths = untrackedZ.split("\0").filter(Boolean).sort();

  let untrackedHashes = "";
  if (untrackedPaths.length > 0) {
    untrackedHashes = untrackedPaths
      .map((p) => {
        try {
          const buf = readFileSync(path.join(repoDir, p));
          const hashHex = createHash("sha256").update(buf).digest("hex");
          return `${p}\n${hashHex}\n`;
        } catch (err) {
          return `${p}\nERR:${err.code || "UNKNOWN"}\n`;
        }
      })
      .join("");
  }

  const h = createHash("sha256");
  h.update("status\0");
  h.update(statusZ);
  h.update("\0diff\0");
  h.update(diff);
  h.update("\0diff_cached\0");
  h.update(diffCached);
  h.update("\0untracked\0");
  h.update(untrackedHashes);

  return h.digest("hex");
}

export function upsertIssueCompletionBlock(
  issuePath,
  { ppcommitClean, testsPassed, note } = {},
) {
  if (!issuePath || !existsSync(issuePath)) return false;

  const start = "<!-- coder:completion:start -->";
  const end = "<!-- coder:completion:end -->";

  const raw = readFileSync(issuePath, "utf8");
  const withoutOld = (() => {
    const s = raw.indexOf(start);
    if (s === -1) return raw;
    const e = raw.indexOf(end, s);
    if (e === -1) return raw.slice(0, s).trimEnd() + "\n";
    return (raw.slice(0, s) + raw.slice(e + end.length)).trimEnd() + "\n";
  })();

  const ts = new Date().toISOString();
  const lines = [
    start,
    "## Coder Status",
    `- Updated: ${ts}`,
    typeof ppcommitClean === "boolean"
      ? `- ppcommit: ${ppcommitClean ? "clean" : "failed"}`
      : null,
    typeof testsPassed === "boolean"
      ? `- tests: ${testsPassed ? "passed" : "failed"}`
      : null,
    note ? `- note: ${String(note).trim()}` : null,
    end,
    "",
  ].filter(Boolean);

  const next = withoutOld.replace(/\s*$/u, "") + "\n\n" + lines.join("\n");
  writeFileSync(issuePath, next, "utf8");
  return true;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "EPERM") return true;
    return false;
  }
}

/** @typedef {"test_config_path"|"repo_coder_json"|"explicit_test_cmd"|"auto_detect"|"allow_no_tests"} RunHostTestsBranch */

/**
 * @param {((o: object) => void) | undefined} log
 * @param {RunHostTestsBranch} branch
 * @param {string} repoDirAbs
 * @param {object} opts
 */
function emitRunHostTestsGate(log, branch, repoDirAbs, opts) {
  if (typeof log !== "function") return;
  const ws = opts.workspaceDir;
  const resolvedWs = ws ? path.resolve(ws) : null;
  const scriptRepo = path.join(repoDirAbs, "scripts", "test.sh");
  /** @type {Record<string, unknown>} */
  const payload = {
    event: "run_host_tests_start",
    branch,
    cwd: repoDirAbs,
    repoRoot: repoDirAbs,
    workspaceDir: resolvedWs,
    repoPath: opts.repoPath ?? null,
    testCmd: opts.testCmd || null,
    testConfigPath: opts.testConfigPath || null,
    scriptsTestShExistsUnderRepoRoot: existsSync(scriptRepo),
  };
  if (resolvedWs != null && resolvedWs !== repoDirAbs) {
    payload.scriptsTestShExistsUnderWorkspaceDir = existsSync(
      path.join(resolvedWs, "scripts", "test.sh"),
    );
  }
  log(payload);
}

export async function runHostTests(
  repoDir,
  { testCmd, testConfigPath, allowNoTests, log, workspaceDir, repoPath } = {},
) {
  const resolvedRepo = path.resolve(repoDir);
  /** @type {Record<string, string | undefined>} */
  const pathMeta = {};
  if (testConfigPath) pathMeta.testConfigPath = testConfigPath;
  if (repoPath != null && repoPath !== "") pathMeta.repoPath = repoPath;
  if (workspaceDir) pathMeta.workspaceDir = workspaceDir;

  const gateOpts = {
    workspaceDir,
    repoPath: repoPath ?? null,
    testCmd: testCmd || "",
    testConfigPath: testConfigPath || "",
  };

  // Priority 1: explicit config path, then coder.json test section
  if (testConfigPath) {
    emitRunHostTestsGate(log, "test_config_path", resolvedRepo, gateOpts);
    const abs = path.resolve(resolvedRepo, testConfigPath);
    const mergedCoderJson =
      workspaceDir &&
      isUnifiedCoderJsonTestConfigPath(testConfigPath) &&
      isWorkspaceScopedRepo(resolvedRepo, workspaceDir);
    if (!mergedCoderJson && !existsSync(abs)) {
      throw new Error(`Test config not found: ${abs}`);
    }
    const config = loadTestConfig(resolvedRepo, testConfigPath, workspaceDir);
    if (!config) {
      throw new Error(
        `Test config invalid or empty: ${testConfigPath} (resolved: ${abs}). ` +
          "No test.command in merged workspace config and no usable config file.",
      );
    }
    const effectiveAllowNoTests = allowNoTests ?? config.allowNoTests ?? false;
    return await runTestConfig(
      resolvedRepo,
      config,
      effectiveAllowNoTests,
      pathMeta,
    );
  }
  const configured = loadTestConfig(resolvedRepo, undefined, workspaceDir);
  if (configured) {
    emitRunHostTestsGate(log, "repo_coder_json", resolvedRepo, gateOpts);
    const effectiveAllowNoTests =
      allowNoTests ?? configured.allowNoTests ?? false;
    return await runTestConfig(
      resolvedRepo,
      configured,
      effectiveAllowNoTests,
      pathMeta,
    );
  }

  // Priority 2: explicit test command
  if (testCmd) {
    emitRunHostTestsGate(log, "explicit_test_cmd", resolvedRepo, gateOpts);
    const rawCmd = String(testCmd);
    // Avoid cascading failures in auto-mode when a repo is reset to a branch
    // that doesn't actually contain the Rust project files required by `cargo`.
    //
    // Important: do NOT false-trigger when users intentionally run cargo from a
    // subdirectory (e.g. `cd rust && cargo test`). Only treat cargo as "repo-root
    // required" when it is the top-level command.
    const looksLikeRootCargoCmd = () => {
      const t = rawCmd.trim();
      // Match commands like:
      // - cargo test
      // - RUSTFLAGS=... cargo test
      // - env -i FOO=1 cargo test
      // - command cargo test
      // - time cargo test
      //
      // Reject anything that starts with `cd ... &&` or other multi-command scripts.
      return /^(?:(?:env\b[^;&|]*\s+)?(?:command\s+)?(?:time\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)cargo\b/i.test(
        t,
      );
    };

    if (looksLikeRootCargoCmd()) {
      const cargoToml = path.join(resolvedRepo, "Cargo.toml");
      const workspaceCargoToml = workspaceDir
        ? path.join(workspaceDir, "Cargo.toml")
        : null;
      if (
        !existsSync(cargoToml) &&
        !(workspaceCargoToml && existsSync(workspaceCargoToml))
      ) {
        throw new TestInfrastructureError(
          `Test infrastructure missing: ${cargoToml} not found, but testCmd includes "cargo". ` +
            `Either ensure Cargo.toml exists on the default branch (especially with destructiveReset=true), ` +
            `or adjust testCmd/testConfigPath for this repo.`,
          { testCmd, missingPath: cargoToml },
        );
      }
    }
    assertTestCommandPathsExist(resolvedRepo, [rawCmd], pathMeta);
    const testCwd = resolveMonorepoTestCwd(resolvedRepo, workspaceDir, [
      rawCmd,
    ]);
    const res = runShellSync(testCmd, { cwd: testCwd });
    // pytest exits 5 when no tests collected; treat as success when allowNoTests
    const exitCode = allowNoTests && res.exitCode === 5 ? 0 : res.exitCode;
    return {
      cmd: res.cmd,
      exitCode,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  }

  // Priority 3: auto-detected test command
  const detected = detectTestCommand(resolvedRepo);
  if (detected) {
    emitRunHostTestsGate(log, "auto_detect", resolvedRepo, gateOpts);
    const res = runTestCommand(resolvedRepo, detected);
    const exitCode = allowNoTests && res.exitCode === 5 ? 0 : res.exitCode;
    return {
      cmd: detected,
      exitCode,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  }

  // Fallback
  if (allowNoTests) {
    emitRunHostTestsGate(log, "allow_no_tests", resolvedRepo, gateOpts);
    return { cmd: null, exitCode: 0, stdout: "", stderr: "" };
  }
  throw new Error(
    `No tests detected for repo ${resolvedRepo}. Pass --test-cmd "..." or --allow-no-tests.`,
  );
}

export { parseAdrStatus, parseSpecMeta } from "./core/metadata-block.js";

/**
 * Parse gap checklist items from spec markdown (e.g. `- [ ] **1. Gap** — Desc. Domain: X. Severity: Y.`).
 * @param {string} text - Spec document content
 * @returns {Array<{description: string, domain: string, severity: string, status: "open"|"done"}>}
 */
export function parseSpecGaps(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const gaps = [];
  const re =
    /^-\s+\[([ x])\]\s+\*\*\d+\.\s+[^*]+\*\*\s*—\s*(.+?)\s*Domain:\s*(.+?)\.?\s*Severity:\s*(\S+?)\.?\s*$/gm;
  for (const m of normalized.matchAll(re)) {
    gaps.push({
      description: m[2].trim(),
      domain: m[3].replace(/\.$/, ""),
      severity: m[4].replace(/\.$/, ""),
      status: m[1] === "x" ? "done" : "open",
    });
  }
  return gaps;
}
