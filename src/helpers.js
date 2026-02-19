import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import { runPpcommitBranch, runPpcommitNative } from "./ppcommit.js";
import { runShellSync } from "./systemd-run.js";
import {
  detectTestCommand,
  loadTestConfig,
  runTestCommand,
  runTestConfig,
} from "./test-runner.js";

/**
 * Detect the default branch for a git repository.
 * Tries `git symbolic-ref --short refs/remotes/origin/HEAD` first,
 * then falls back to checking if `main` exists, else `master`.
 *
 * @param {string} repoDir - Path to the git repository
 * @returns {string} The default branch name
 */
export function detectDefaultBranch(repoDir) {
  const originHead = spawnSync(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );
  if (originHead.status === 0) {
    const raw = (originHead.stdout || "").trim();
    if (raw.startsWith("origin/") && raw.length > "origin/".length) {
      return raw.slice("origin/".length);
    }
  }

  const mainCheck = spawnSync("git", ["rev-parse", "--verify", "main"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  return mainCheck.status === 0 ? "main" : "master";
}

export const DEFAULT_PASS_ENV = [
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "LINEAR_API_KEY",
];

export function detectRemoteType(repoDir) {
  const res = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (res.status === 0) {
    const url = (res.stdout || "").trim();
    const httpsMatch = url.match(/^https?:\/\/([^/:]+)/);
    const sshMatch = url.match(/^[^@]+@([^:]+):/);
    const host = (httpsMatch?.[1] || sshMatch?.[1] || "").toLowerCase();
    if (host.includes("gitlab")) return "gitlab";
  }
  return "github";
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
    ["-lc", `command -v ${JSON.stringify(name)} >/dev/null 2>&1`],
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
export function extractGeminiPayloadJson(stdout) {
  const parsed = extractJson(stdout);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof parsed.response === "string"
  ) {
    try {
      return extractJson(parsed.response);
    } catch {
      // Some envelopes encode escaped newlines (e.g. "\\n") literally.
      // Normalize and retry before falling back to the raw envelope.
      try {
        const normalized = parsed.response
          .replace(/\\r\\n/g, "\n")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t");
        return extractJson(normalized);
      } catch {
        // Keep envelope if response is not structured JSON.
      }
    }
  }
  return parsed;
}

export function geminiJsonPipe(prompt) {
  return heredocPipe(prompt, "gemini --yolo -o json");
}

export function geminiJsonPipeWithModel(prompt, model) {
  const modelArg = (
    model && typeof model === "object"
      ? String(model.model || "")
      : String(model || "")
  ).trim();
  const cmd = modelArg
    ? `gemini --yolo -m ${modelArg} -o json`
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
  const lines = fullyCleaned.split("\n");
  const firstHeader = lines.findIndex((line) => line.trim().startsWith("#"));
  if (firstHeader > 0) return lines.slice(firstHeader).join("\n").trim();
  return fullyCleaned;
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
One of:
- REJECT (major rework needed, scope violation, or hallucinated APIs)
- REVISE (fix over-engineering or other issues first)
- PROCEED WITH CAUTION (minor issues)
- APPROVED (rare - plan is minimal, correct, and verified)

Be specific. Reference what you found in your searches about the external APIs.
Reference specific sections in the plan when identifying over-engineering.`;

  // Use gemini CLI with yolo mode and text output
  const cmd = heredocPipe(reviewPrompt, "gemini --yolo -o text");
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 300000, // 5 minute timeout
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
  });

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

  writeFileSync(critiquePath, critique + "\n");
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
        const abs = path.join(repoDir, p);
        try {
          const content = readFileSync(abs);
          const digest = createHash("sha256").update(content).digest("hex");
          return `${p}\n${digest}\n`;
        } catch {
          return `${p}\n<unreadable>\n`;
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

export async function runHostTests(
  repoDir,
  { testCmd, testConfigPath, allowNoTests } = {},
) {
  // Priority 1: explicit config path, then coder.json test section
  if (testConfigPath) {
    const abs = path.resolve(repoDir, testConfigPath);
    if (!existsSync(abs)) {
      throw new Error(`Test config not found: ${abs}`);
    }
    const config = loadTestConfig(repoDir, testConfigPath);
    return await runTestConfig(repoDir, config);
  }
  const configured = loadTestConfig(repoDir);
  if (configured) {
    return await runTestConfig(repoDir, configured);
  }

  // Priority 2: explicit test command
  if (testCmd) {
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
      const cargoToml = path.join(repoDir, "Cargo.toml");
      if (!existsSync(cargoToml)) {
        throw new TestInfrastructureError(
          `Test infrastructure missing: ${cargoToml} not found, but testCmd includes "cargo". ` +
            `Either ensure Cargo.toml exists on the default branch (especially with destructiveReset=true), ` +
            `or adjust testCmd/testConfigPath for this repo.`,
          { testCmd, missingPath: cargoToml },
        );
      }
    }
    const res = runShellSync(testCmd, { cwd: repoDir });
    return {
      cmd: res.cmd,
      exitCode: res.exitCode ?? 0,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  }

  // Priority 3: auto-detected test command
  const detected = detectTestCommand(repoDir);
  if (detected) {
    const res = runTestCommand(repoDir, detected);
    return { cmd: detected, ...res };
  }

  // Fallback
  if (allowNoTests) return { cmd: null, exitCode: 0, stdout: "", stderr: "" };
  throw new Error(
    `No tests detected for repo ${repoDir}. Pass --test-cmd "..." or --allow-no-tests.`,
  );
}
