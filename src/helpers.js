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
  for (const n of names) {
    if (process.env[n]) return;
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
  /** @type {Record<string, string>} */
  const secrets = {};
  for (const key of passEnv) {
    const val = process.env[key];
    if (val) secrets[key] = val;
  }
  return secrets;
}

export function extractJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Empty response — no JSON to extract.");

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(jsonrepair(fenced[1].trim()));

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonrepair(candidate));
  }

  // No JSON structure found — provide a helpful error instead of
  // letting jsonrepair throw a confusing "Unexpected character" error.
  const preview = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
  throw new Error(`No JSON object found in response. Preview:\n${preview}`);
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

  const reviewPrompt = `You are a cynical, experienced senior principal engineer reviewing a technical plan.

## CRITICAL: Verify External Dependencies

This plan references external libraries/crates/packages. You MUST:
1. **CHECK THE ACTUAL SOURCE** - If a GitHub URL is mentioned, read the README.md and docs/ folder directly
2. For git dependencies, fetch raw files like: https://raw.githubusercontent.com/OWNER/REPO/main/docs/FILE.md
3. Verify the proposed API usage matches the real library's interface
4. Check if functions/methods mentioned actually exist in those libraries
5. Do NOT trust the plan's claims about external APIs - verify them by reading source/docs

## Your Mandate

Be ruthlessly analytical. Find flaws, gaps, risks, and problems BEFORE implementation.

Focus on:
1. **Feasibility**: Can this actually be implemented? Are the APIs real?
2. **Completeness**: What's missing? What edge cases are ignored?
3. **Correctness**: Are there logical flaws or misunderstandings?
4. **Dependencies**: Are the external library APIs correctly described?

## The Plan to Review

${planContent}

## Your Critique

After verifying external APIs via search, provide your critique:

### Critical Issues (Must Fix)
Issues that would cause the plan to fail.

### Concerns (Should Address)
Problems that should be addressed but won't cause immediate failure.

### Questions (Need Clarification)
Ambiguities or assumptions that need to be verified.

### Verdict
One of: REJECT (major rework needed), REVISE (fix issues first), PROCEED WITH CAUTION (minor issues), APPROVED (rare - plan is solid)

Be specific. Reference what you found in your searches about the external APIs.`;

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
