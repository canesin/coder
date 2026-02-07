import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { jsonrepair } from "jsonrepair";
import { detectTestCommand, runTestCommand, loadTestConfig, runTestConfig } from "./test-runner.js";
import { runPpcommitNative } from "./ppcommit.js";

export const DEFAULT_PASS_ENV = [
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
];

export function requireEnvOneOf(names) {
  const resolved = buildSecretsWithFallback(names);
  for (const n of names) {
    if (resolved[n]) return;
  }
  throw new Error(`Missing required env var: one of ${names.join(", ")}`);
}

export function requireCommandOnPath(name) {
  const res = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)} >/dev/null 2>&1`], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`Required command not found on PATH: ${name}`);
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

export function buildSecretsWithFallback(passEnv, { env = process.env, shellLookup = readEnvFromLoginShell } = {}) {
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
  let detail = raw || "No stdout/stderr captured.";

  // Try to surface the nested JSON error from gemini CLI when present.
  if (raw) {
    try {
      const parsed = extractJson(raw);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {
      // best-effort parsing only
    }
  }

  if (detail.length > maxLen) detail = detail.slice(0, maxLen) + "…";
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

  // First try full JSON parse so envelopes like:
  // {"response":"```json\\n{...}\\n```"} are handled as top-level JSON
  // instead of matching the escaped code fence inside the string value.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(jsonrepair(trimmed));
    } catch {
      // fall through to extraction heuristics
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch {
      // fall through
    }
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(jsonrepair(fenced[1].trim()));

  // No JSON structure found — provide a helpful error instead of
  // letting jsonrepair throw a confusing "Unexpected character" error.
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

export function heredocPipe(text, pipeCmd) {
  const marker = `CODER_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  if (text.includes(marker)) {
    return heredocPipe(text + "\n", pipeCmd);
  }
  const normalized = text.replace(/\r\n/g, "\n");
  return `cat <<'${marker}' | ${pipeCmd}\n${normalized}\n${marker}`;
}

export function gitCleanOrThrow(repoDir) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) throw new Error("Failed to run `git status`.");
  const lines = (res.stdout || "")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.endsWith(".coder/") && !l.includes(".coder/"));
  if (lines.length > 0) {
    throw new Error(`Repo working tree is not clean: ${repoDir}\n${lines.join("\n")}`);
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
  // Filter out gemini CLI startup noise
  const filtered = output
    .split("\n")
    .filter((line) => !line.startsWith("Warning:") && !line.includes("YOLO mode") && !line.includes("Loading extension") && !line.includes("Hook registry") && !line.includes("Server '") && !line.includes("Found stored OAuth"))
    .join("\n")
    .trim();

  writeFileSync(critiquePath, filtered + "\n");
  return result.status ?? 0;
}

export function runPpcommit(repoDir) {
  return runPpcommitNative(repoDir);
}

export async function runHostTests(repoDir, { testCmd, testConfigPath, allowNoTests } = {}) {
  // Priority 1: test config file (.coder/test.json or custom path)
  if (testConfigPath) {
    const abs = path.resolve(repoDir, testConfigPath);
    if (!existsSync(abs)) {
      throw new Error(`Test config not found: ${abs}`);
    }
    const config = loadTestConfig(repoDir, testConfigPath);
    return await runTestConfig(repoDir, config);
  } else {
    const defaultPath = path.join(repoDir, ".coder", "test.json");
    if (existsSync(defaultPath)) {
      const config = loadTestConfig(repoDir);
      return await runTestConfig(repoDir, config);
    }
  }

  // Priority 2: explicit test command
  if (testCmd) {
    const res = spawnSync("bash", ["-lc", testCmd], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      cmd: ["bash", "-lc", testCmd],
      exitCode: res.status ?? 0,
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
