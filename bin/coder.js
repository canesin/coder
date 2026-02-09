#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { parseArgs as nodeParseArgs } from "node:util";

import { jsonrepair } from "jsonrepair";
import { z } from "zod";

import { AgentRunner } from "../src/agent-runner.js";
import { HostSandboxProvider } from "../src/host-sandbox.js";
import { closeAllLoggers, ensureLogsDir, makeJsonlLogger } from "../src/logging.js";
import { runPpcommitNative, runPpcommitBranch, runPpcommitAll } from "../src/ppcommit.js";
import { runPlanreview, upsertIssueCompletionBlock } from "../src/helpers.js";
import { loadState, saveState, statePathFor } from "../src/state.js";
import { detectTestCommand, runTestCommand } from "../src/test-runner.js";
import { sanitizeBranchForRef, worktreePath, ensureWorktree } from "../src/worktrees.js";

const IssuesPayloadSchema = z.object({
  issues: z.array(
    z.object({
      source: z.enum(["github", "linear"]),
      id: z.string().min(1),
      title: z.string().min(1),
      repo_path: z.string().default(""),
      difficulty: z.number().int().min(1).max(5),
      reason: z.string().default(""),
    }),
  ),
  recommended_index: z.number().int(),
});

const QuestionsPayloadSchema = z.object({
  questions: z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
});

const ProjectsPayloadSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      key: z.string().default(""),
    }),
  ),
});

function usage() {
  return `coder (multi-agent orchestrator; host sandbox)

Usage:
  coder [--workspace <path>] [--repo <path>] [--issue-index <n>] [--verbose]
        [--test-cmd "<cmd>"] [--allow-no-tests]

  coder ppcommit [--base <branch>]
        Run ppcommit checks on the repository.
        Without --base: checks all files in the repo.
        With --base: checks only files changed since the given branch.

Defaults:
  - Human interaction: project selection, issue selection, and Gemini's 3 clarification questions.
  - All agent output and progress written under .coder/

Required environment (agent auth):
  GOOGLE_API_KEY or GEMINI_API_KEY
  ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN for Claude Code)
  OPENAI_API_KEY

Optional:
  --test-cmd          Override test command (e.g. "pnpm test" or "pytest -q")
  --allow-no-tests    Continue even if no tests detected
`;
}

const DEFAULT_PASS_ENV = [
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
];

function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv.slice(2),
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      workspace: { type: "string", default: "." },
      repo: { type: "string", default: "" },
      "issue-index": { type: "string", default: "" },
      "test-cmd": { type: "string", default: "" },
      "allow-no-tests": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      "pass-env": { type: "string", default: "" },
    },
  });

  return {
    help: values.help,
    workspace: values.workspace,
    repo: values.repo,
    issueIndex: values["issue-index"] ? Number.parseInt(values["issue-index"], 10) : -1,
    verbose: values.verbose,
    issueFile: "ISSUE.md",
    planFile: "PLAN.md",
    critiqueFile: "PLANREVIEW.md",
    allowNoTests: values["allow-no-tests"],
    testCmd: values["test-cmd"],
    passEnv: values["pass-env"]
      ? values["pass-env"].split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_PASS_ENV,
  };
}

function requireEnvOneOf(names) {
  const resolved = buildSecrets(names);
  for (const n of names) {
    if (resolved[n]) return;
  }
  throw new Error(`Missing required env var: one of ${names.join(", ")}`);
}

function requireCommandOnPath(name) {
  const res = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)} >/dev/null 2>&1`], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`Required command not found on PATH: ${name}`);
}

function buildSecrets(passEnv) {
  const isSafeEnvName = (name) => /^[A-Z_][A-Z0-9_]*$/.test(name);
  const readEnvFromLoginShell = (name) => {
    if (!isSafeEnvName(name)) return "";
    const script = `printf '%s' "\${${name}:-}"`;
    const res = spawnSync("bash", ["-lc", script], { encoding: "utf8" });
    if (res.status !== 0) return "";
    return (res.stdout || "").trim();
  };

  /** @type {Record<string, string>} */
  const secrets = {};
  for (const key of passEnv) {
    const val = process.env[key] || readEnvFromLoginShell(key);
    if (val) secrets[key] = val;
  }
  // Gemini CLI can require GEMINI_API_KEY explicitly in some modes.
  if (!secrets.GEMINI_API_KEY && secrets.GOOGLE_API_KEY) {
    secrets.GEMINI_API_KEY = secrets.GOOGLE_API_KEY;
  }
  if (!secrets.GOOGLE_API_KEY && secrets.GEMINI_API_KEY) {
    secrets.GOOGLE_API_KEY = secrets.GEMINI_API_KEY;
  }
  return secrets;
}

function formatCommandFailure(label, res, maxLen = 1200) {
  const exit = typeof res?.exitCode === "number" ? res.exitCode : "unknown";
  const raw = `${res?.stderr || ""}\n${res?.stdout || ""}`.trim();
  const isNoiseLine = (line) => {
    const l = String(line || "");
    return (
      /^Warning:/i.test(l) ||
      /Skipping extension in .*Configuration file not found/i.test(l) ||
      /YOLO mode/i.test(l) ||
      /Loading extension/i.test(l) ||
      /Hook registry/i.test(l) ||
      /Server '/i.test(l) ||
      /supports tool updates/i.test(l) ||
      /Listening for changes/i.test(l) ||
      /Found stored OAuth/i.test(l) ||
      /rejected stored OAuth token/i.test(l) ||
      /Please re-authenticate using:\s*\/mcp auth/i.test(l) ||
      /Both GOOGLE_API_KEY and GEMINI_API_KEY are set/i.test(l) ||
      /\bUsing GOOGLE_API_KEY\b/i.test(l) ||
      /updated for server:/i.test(l) ||
      /Tools changed,\s*updating Gemini context/i.test(l) ||
      /Received (?:resource|prompt|tool) update notification/i.test(l) ||
      /^\[INFO\]\s*(?:Tools|Prompts|Resources) updated for server:/i.test(l) ||
      /^Resources updated for server:/i.test(l) ||
      /^Prompts updated for server:/i.test(l) ||
      /^Tools updated for server:/i.test(l) ||
      /^🔔\s*/u.test(l)
    );
  };
  const stripNoise = (text) =>
    String(text || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !isNoiseLine(line))
      .join("\n")
      .trim();

  const filteredRaw = stripNoise(raw);
  let detail = filteredRaw || raw || "No stdout/stderr captured.";

  if (raw) {
    try {
      const parsed = extractJson(raw);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {
      // best-effort parsing only
    }
  }

  if (detail.length > maxLen) detail = "…" + detail.slice(-maxLen);
  const hint =
    /must specify the GEMINI_API_KEY environment variable/i.test(raw) ||
    /GEMINI_API_KEY/i.test(detail)
      ? " Hint: set GEMINI_API_KEY (GOOGLE_API_KEY is also accepted and auto-aliased)."
      : "";
  return `${label} (exit ${exit}).${hint}\n${detail}`;
}

function extractJson(stdout) {
  const trimmed = stdout.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(jsonrepair(fenced[1].trim()));

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonrepair(candidate));
  }

  return JSON.parse(jsonrepair(trimmed));
}

async function promptText(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function gitCleanOrThrow(repoDir, extraIgnore = []) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) throw new Error("Failed to run `git status`.");
  const ignorePatterns = [".coder/", ".gemini/", ...extraIgnore].map((p) => p.replace(/\\/g, "/"));

  const isIgnored = (filePath) => {
    return ignorePatterns.some((pattern) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      if (pattern.endsWith("/")) {
        return normalizedPath.startsWith(pattern);
      }
      if (pattern.includes("/")) {
        return normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`);
      }
      return normalizedPath === pattern;
    });
  };

  const lines = (res.stdout || "")
    .split("\n")
    .filter((l) => {
      if (l.trim() === "") return false;
      const pathField = l.slice(3);
      const filePath = pathField.includes(" -> ") ? pathField.split(" -> ").pop() || pathField : pathField;
      return !isIgnored(filePath);
    });
  if (lines.length > 0) {
    throw new Error(`Repo working tree is not clean: ${repoDir}\n${lines.join("\n")}`);
  }
}

// runPlanreview is imported from helpers.js (uses Gemini CLI)

function runPpcommit(repoDir) {
  return runPpcommitNative(repoDir);
}

function runHostTests(repoDir, args) {
  if (args.testCmd) {
    const res = spawnSync("bash", ["-lc", args.testCmd], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      cmd: ["bash", "-lc", args.testCmd],
      exitCode: res.status ?? 0,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
    };
  }

  const detected = detectTestCommand(repoDir);
  if (!detected) {
    if (args.allowNoTests) return { cmd: null, exitCode: 0, stdout: "", stderr: "" };
    throw new Error(
      `No tests detected for repo ${repoDir}. Pass --test-cmd \"...\" or --allow-no-tests.`,
    );
  }

  const res = runTestCommand(repoDir, detected);
  return { cmd: detected, ...res };
}

function heredocPipe(text, pipeCmd) {
  const marker = `CODER_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  if (text.includes(marker)) {
    return heredocPipe(text + "\n", pipeCmd);
  }
  const normalized = text.replace(/\r\n/g, "\n");
  return `cat <<'${marker}' | ${pipeCmd}\n${normalized}\n${marker}`;
}

function renderIssuesTable(issues, recommendedIndex) {
  const headers = [" #", "Source", "ID", "Diff", "Title", "Reason"];
  const rows = issues.map((it, i) => [
    i === recommendedIndex ? `\u2192${i + 1}` : ` ${i + 1}`,
    it.source,
    it.id,
    `${it.difficulty}/5`,
    it.title,
    it.reason || "",
  ]);

  const maxColWidths = [5, 6, 24, 4, 42, 32];
  const widths = headers.map((h, col) => {
    const dataMax = Math.max(h.length, ...rows.map((r) => r[col].length));
    return Math.min(dataMax, maxColWidths[col]);
  });

  const trunc = (s, w) => (s.length > w ? s.slice(0, w - 1) + "\u2026" : s.padEnd(w));
  const hr = (l, m, r) => l + widths.map((w) => "\u2500".repeat(w + 2)).join(m) + r;
  const fmtRow = (cells) =>
    "\u2502" + cells.map((c, i) => ` ${trunc(c, widths[i])} `).join("\u2502") + "\u2502";

  let out = "";
  out += hr("\u250c", "\u252c", "\u2510") + "\n";
  out += fmtRow(headers) + "\n";
  out += hr("\u251c", "\u253c", "\u2524") + "\n";
  for (const r of rows) out += fmtRow(r) + "\n";
  out += hr("\u2514", "\u2534", "\u2518") + "\n";
  out += "\u2192 = Gemini recommendation\n";
  return out;
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  requireEnvOneOf(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
  requireEnvOneOf(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  requireEnvOneOf(["OPENAI_API_KEY"]);
  requireCommandOnPath("git");
  requireCommandOnPath("gemini");
  requireCommandOnPath("claude");
  requireCommandOnPath("codex");
  // planreview and ppcommit are now built-in (no external dependencies)

  const workspaceDir = path.resolve(args.workspace);
  if (!existsSync(workspaceDir)) throw new Error(`Workspace does not exist: ${workspaceDir}`);

  mkdirSync(path.join(workspaceDir, ".coder"), { recursive: true });
  ensureLogsDir(workspaceDir);

  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const legacyIssuePath = path.join(workspaceDir, args.issueFile);
  const legacyPlanPath = path.join(workspaceDir, args.planFile);
  const legacyCritiquePath = path.join(workspaceDir, args.critiqueFile);
  const modernIssuePath = path.join(artifactsDir, args.issueFile);
  const modernPlanPath = path.join(artifactsDir, args.planFile);
  const modernCritiquePath = path.join(artifactsDir, args.critiqueFile);

  const hasModern = existsSync(modernIssuePath) || existsSync(modernPlanPath) || existsSync(modernCritiquePath);
  const hasLegacy = existsSync(legacyIssuePath) || existsSync(legacyPlanPath) || existsSync(legacyCritiquePath);
  const issuePath = hasModern ? modernIssuePath : hasLegacy ? legacyIssuePath : modernIssuePath;
  const planPath = hasModern ? modernPlanPath : hasLegacy ? legacyPlanPath : modernPlanPath;
  const critiquePath = hasModern ? modernCritiquePath : hasLegacy ? legacyCritiquePath : modernCritiquePath;

  const state = loadState(workspaceDir);
  const statePath = statePathFor(workspaceDir);
  const log = makeJsonlLogger(workspaceDir, "coder");
  log({ event: "start", workspaceDir, statePath });

  // Best-effort checkpoint reconciliation based on artifact presence.
  state.steps ||= {};
  if (existsSync(issuePath)) state.steps.wroteIssue = true;
  if (existsSync(planPath)) state.steps.wrotePlan = true;
  if (existsSync(critiquePath)) state.steps.wroteCritique = true;

  const secrets = buildSecrets(args.passEnv);

  const attachAgentLogging = (name, vk) => {
    const agentLog = makeJsonlLogger(workspaceDir, name);
    vk.on("stdout", (d) => agentLog({ stream: "stdout", data: d }));
    vk.on("stderr", (d) => agentLog({ stream: "stderr", data: d }));
    vk.on("update", (d) => agentLog({ stream: "update", data: d }));
    vk.on("error", (d) => agentLog({ stream: "error", data: d }));
    if (args.verbose) {
      vk.on("stdout", (d) => process.stdout.write(`[${name}] ${d}`));
      vk.on("stderr", (d) => process.stderr.write(`[${name}] ${d}`));
    }
  };

  // Gemini runs at workspace scope.
  const geminiProvider = new HostSandboxProvider({ defaultCwd: workspaceDir, baseEnv: secrets });
  const gemini = new AgentRunner(geminiProvider);
  attachAgentLogging("gemini", gemini);

  // --- Step 0: Linear project selection ---
  if (secrets.LINEAR_API_KEY && (!state.steps.listedProjects || !state.linearProjects)) {
    process.stdout.write("\n[0/8] Gemini: listing Linear teams...\n");
    const projPrompt = `Use your Linear MCP to list all teams I have access to.

Return ONLY valid JSON in this schema:
{
  "projects": [
    {
      "id": "string (team ID)",
      "name": "string (team name)",
      "key": "string (team key, e.g. ENG)"
    }
  ]
}`;
    const projCmd = heredocPipe(projPrompt, "gemini --model gemini-3-flash-preview --yolo");
    const projRes = await gemini.executeCommand(projCmd, { timeoutMs: 1000 * 60 * 5 });
    if (projRes.exitCode !== 0) throw new Error(formatCommandFailure("Gemini project listing failed", projRes));
    const projPayload = ProjectsPayloadSchema.parse(extractJson(projRes.stdout));
    state.linearProjects = projPayload.projects;

    if (state.linearProjects.length > 0) {
      process.stdout.write("\nLinear teams:\n");
      for (let i = 0; i < state.linearProjects.length; i++) {
        const p = state.linearProjects[i];
        const key = p.key ? ` (${p.key})` : "";
        process.stdout.write(`  ${i + 1}. ${p.name}${key}\n`);
      }
      const raw = await promptText(
        `\nSelect a project [1-${state.linearProjects.length}] (or Enter for all): `,
      );
      if (raw) {
        const idx = Number.parseInt(raw, 10);
        if (!Number.isInteger(idx) || idx < 1 || idx > state.linearProjects.length) {
          throw new Error("Invalid project selection.");
        }
        state.selectedProject = state.linearProjects[idx - 1];
      }
    }

    state.steps.listedProjects = true;
    saveState(workspaceDir, state);
  }

  // --- Step 1: Gemini issues listing (structured JSON contract) ---
  let issuesPayload;
  if (!state.steps.listedIssues || !state.issuesPayload) {
    process.stdout.write("\n[1/7] Gemini: listing assigned issues...\n");
    let projectFilter = "";
    if (state.selectedProject) {
      projectFilter = `\nOnly include Linear issues from the "${state.selectedProject.name}" team (key: ${state.selectedProject.key}).`;
    }
    const listPrompt = `Use your GitHub MCP and Linear MCP to list the issues assigned to me.${projectFilter}

Then, for each issue, briefly inspect the local code in the relevant repository folder(s) in this workspace (${workspaceDir}) and estimate implementation difficulty and directness (prefer small, self-contained changes).

Return ONLY valid JSON in this schema:
{
  "issues": [
    {
      "source": "github" | "linear",
      "id": "string",
      "title": "string",
      "repo_path": "string (relative path to repo subfolder in workspace, or empty if unknown)",
      "difficulty": 1 | 2 | 3 | 4 | 5,
      "reason": "short explanation"
    }
  ],
  "recommended_index": number
}`;

    const cmd = heredocPipe(listPrompt, "gemini --model gemini-3-flash-preview --yolo");
    const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 10 });
    if (res.exitCode !== 0) throw new Error(formatCommandFailure("Gemini issue listing failed", res));
    issuesPayload = IssuesPayloadSchema.parse(extractJson(res.stdout));
    state.steps.listedIssues = true;
    state.issuesPayload = issuesPayload;
    saveState(workspaceDir, state);
  } else {
    issuesPayload = state.issuesPayload;
  }

  const issues = issuesPayload?.issues || [];
  if (issues.length === 0) {
    process.stdout.write("No issues returned.\n");
    return 0;
  }

  // --- Step 1.5: choose issue and repo ---
  if (!state.selected || !state.repoPath || !state.branch) {
    let selected;
    if (Number.isInteger(args.issueIndex) && args.issueIndex >= 0 && args.issueIndex < issues.length) {
      selected = issues[args.issueIndex];
    } else {
      process.stdout.write("\n");
      process.stdout.write(renderIssuesTable(issues, issuesPayload.recommended_index));
      process.stdout.write("\n");
      const raw = await promptText("Pick an issue number: ");
      const idx = Number.parseInt(raw, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > issues.length) throw new Error("Invalid issue selection.");
      selected = issues[idx - 1];
    }

    let repoPath = (args.repo || selected.repo_path || "").trim();
    if (!repoPath) repoPath = await promptText("Repo subfolder to work in (relative to workspace): ");

    state.selected = selected;
    state.repoPath = repoPath;
    state.branch = sanitizeBranchForRef(`coder/${selected.source}-${selected.id}`);
    saveState(workspaceDir, state);
  }

  const repoRoot = path.resolve(workspaceDir, state.repoPath);
  if (!existsSync(repoRoot)) throw new Error(`Repo root does not exist: ${repoRoot}`);
  const isGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, encoding: "utf8" });
  if (isGit.status !== 0) throw new Error(`Not a git repository: ${repoRoot}`);

  // Hard gate: require repo clean before any agent writes code.
  if (!state.steps.verifiedCleanRepo) {
    process.stdout.write("\n[1.6/8] Verifying repo is clean...\n");
    gitCleanOrThrow(repoRoot);
    state.steps.verifiedCleanRepo = true;
    saveState(workspaceDir, state);
  }

  const worktreesRoot = path.join(workspaceDir, ".coder", "worktrees", state.repoPath.replaceAll("/", "__"));
  mkdirSync(worktreesRoot, { recursive: true });
  const repoWorktree = ensureWorktree(repoRoot, worktreesRoot, state.branch);

  // Repo-scoped agents operate from the worktree directory.
  const makeRepoAgent = (name) => {
    const provider = new HostSandboxProvider({ defaultCwd: repoWorktree, baseEnv: secrets });
    const agent = new AgentRunner(provider);
    attachAgentLogging(name, agent);
    return agent;
  };

  const claude = makeRepoAgent("claude");
  const codex = makeRepoAgent("codex");

  // --- Step 2: Gemini asks 3 questions (only human interaction) ---
  if (!state.questions || !state.answers || state.questions.length !== 3 || state.answers.length !== 3) {
    process.stdout.write("\n[2/7] Gemini: generating 3 clarification questions...\n");
    const qPrompt = `We chose this issue:
- source: ${state.selected.source}
- id: ${state.selected.id}
- title: ${state.selected.title}
- repo_root: ${repoRoot}

Ask EXACTLY 3 clarifying questions that are essential to implement this issue correctly in this codebase.
Return ONLY valid JSON:
{"questions":["q1","q2","q3"]}`;

    const cmd = heredocPipe(qPrompt, "gemini --model gemini-3-flash-preview --yolo");
    const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 5 });
    if (res.exitCode !== 0) throw new Error(formatCommandFailure("Gemini questions failed", res));
    const qPayload = QuestionsPayloadSchema.parse(extractJson(res.stdout));

    const answers = [];
    for (let i = 0; i < 3; i++) {
      process.stdout.write(`\nQ${i + 1}: ${qPayload.questions[i]}\n`);
      answers.push(await promptText("A: "));
    }

    state.questions = qPayload.questions;
    state.answers = answers;
    saveState(workspaceDir, state);
  }

  // --- Step 3: Gemini drafts ISSUE.md ---
  if (!state.steps.wroteIssue) {
    process.stdout.write("\n[3/7] Gemini: drafting ISSUE.md...\n");
    const issuePrompt = `Draft an ISSUE.md for the chosen issue. Use the local codebase in ${repoRoot} as ground truth.
Be specific about what needs to change, and how to verify it.

Chosen issue:
- source: ${state.selected.source}
- id: ${state.selected.id}
- title: ${state.selected.title}
- repo_root: ${repoRoot}

Clarifications:
1) ${state.questions[0]}
   Answer: ${state.answers[0]}
2) ${state.questions[1]}
   Answer: ${state.answers[1]}
3) ${state.questions[2]}
   Answer: ${state.answers[2]}

Output ONLY markdown suitable for writing directly to ISSUE.md.
Include a short section at the top with:
- Source
- Issue ID
- Repo Root (relative path if possible)
`;
    const cmd = heredocPipe(issuePrompt, "gemini --model gemini-3-flash-preview --yolo");
    const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 10 });
    if (res.exitCode !== 0) throw new Error(formatCommandFailure("Gemini ISSUE.md drafting failed", res));
    writeFileSync(issuePath, res.stdout.trimEnd() + "\n");
    process.stdout.write(`Wrote ${issuePath}\n`);
    state.steps.wroteIssue = true;
    saveState(workspaceDir, state);
  }

  // --- Step 4: Claude writes PLAN.md (must not modify repo) ---
  if (!state.steps.wrotePlan) {
    process.stdout.write("\n[4/7] Claude: writing PLAN.md...\n");
    const planPrompt = `Read ${issuePath} and write a complete implementation plan to ${planPath}.

Constraints:
- Do NOT implement code yet.
- Do NOT modify any tracked files in the repository (only write/update ${planPath}).
- Do NOT ask the user any questions; use repo conventions and ISSUE.md as ground truth.`;

    const cmd = heredocPipe(
      planPrompt,
      `claude -p --output-format stream-json --dangerously-skip-permissions --model claude-opus-4-6`,
    );
    const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 20 });
    if (res.exitCode !== 0) throw new Error("Claude plan generation failed.");

    // Hard gate: Claude must not change the repo during planning
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoWorktree, encoding: "utf8" });
    if (status.status !== 0) throw new Error("Failed to check git status after planning.");
    // Planning must not modify the repo. Allow internal tool dirs only.
    const artifactFiles = [".coder/", ".gemini/"];
    const dirtyLines = (status.stdout || "")
      .split("\n")
      .filter((l) => l.trim() !== "" && !artifactFiles.some((a) => l.includes(a)));
    if (dirtyLines.length > 0) {
      throw new Error(`Planning step modified the repository. Aborting.\n${dirtyLines.join("\n")}`);
    }

    if (!existsSync(planPath)) throw new Error(`PLAN.md not found: ${planPath}`);
    state.steps.wrotePlan = true;
    saveState(workspaceDir, state);
  }

  // --- Step 5: planreview critique ---
  if (!state.steps.wroteCritique) {
    process.stdout.write("\n[5/7] planreview: critiquing PLAN.md...\n");
    const rc = runPlanreview(repoWorktree, planPath, critiquePath);
    if (rc !== 0) process.stdout.write("WARNING: planreview exited non-zero. Continuing.\n");
    state.steps.wroteCritique = true;
    saveState(workspaceDir, state);
  }

  // --- Step 6: Claude updates PLAN.md and implements ---
  if (!state.steps.implemented) {
    process.stdout.write("\n[6/7] Claude: implementing feature...\n");
    const implPrompt = `Read ${planPath} and ${critiquePath}. Update ${planPath} to address critique, then implement the feature in the repo.

Constraints:
- Follow existing patterns and conventions in the repository.
- Fix root causes; no hacks.
- Do not bypass tests; use the repo's normal commands.`;

    const cmd = heredocPipe(
      implPrompt,
      `claude -p --output-format stream-json --dangerously-skip-permissions --model claude-opus-4-6`,
    );
    const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 60 });
    if (res.exitCode !== 0) throw new Error("Claude implementation failed.");
    state.steps.implemented = true;
    saveState(workspaceDir, state);
  }

  // --- Step 7: Codex runs ppcommit, fixes, and tests ---
  if (!state.steps.codexReviewed) {
    process.stdout.write("\n[7/7] Codex: ppcommit + fixes + tests...\n");
    const ppBefore = runPpcommit(repoWorktree);
    log({ event: "ppcommit_before", exitCode: ppBefore.exitCode });

    const codexPrompt = `You are reviewing uncommitted changes. Run ppcommit and fix ALL issues it reports.
Then run the repo's standard lint/format/test commands and fix failures.

Hard constraints:
- Never bypass tests or reduce coverage/quality.
- If a command fails, fix the underlying issue and re-run until it passes.

ppcommit output:
\n---\n${(ppBefore.stdout || ppBefore.stderr || "").trim()}\n---\n`;

    const cmd = `codex exec --full-auto --skip-git-repo-check ${JSON.stringify(codexPrompt)}`;
    const res = await codex.executeCommand(cmd, { timeoutMs: 1000 * 60 * 90 });
    if (res.exitCode !== 0) throw new Error("Codex review/fix failed.");
    state.steps.codexReviewed = true;
    saveState(workspaceDir, state);
  }

  // Hard gate: ppcommit must be clean after Codex
  process.stdout.write("\n[7.1/7] Verifying: ppcommit checks are clean...\n");
  const ppAfter = runPpcommit(repoWorktree);
  if (ppAfter.exitCode !== 0) {
    process.stdout.write(ppAfter.stdout || ppAfter.stderr);
    throw new Error("ppcommit still reports issues after Codex pass.");
  }
  state.steps.ppcommitClean = true;
  saveState(workspaceDir, state);

  // Hard gate: tests must pass on host
  process.stdout.write("\n[7.2/7] Running tests on host...\n");
  const testRes = runHostTests(repoWorktree, args);
  if (testRes.cmd) process.stdout.write(`Test command: ${testRes.cmd.join(" ")}\n`);
  if (testRes.exitCode !== 0) {
    process.stdout.write(testRes.stdout);
    process.stderr.write(testRes.stderr);
    throw new Error("Tests failed after Codex pass.");
  }
  state.steps.testsPassed = true;
  saveState(workspaceDir, state);

  // Update workflow ISSUE.md with a clear completion signal (no extra agent pass).
  try {
    upsertIssueCompletionBlock(issuePath, {
      ppcommitClean: true,
      testsPassed: true,
      note: "ppcommit + tests completed. Ready to create PR.",
    });
  } catch {
    // Best-effort: don't fail the run if this write fails.
  }

  process.stdout.write("\nDone.\n");
  log({ event: "done", branch: state.branch, repoWorktree });
  await closeAllLoggers();
  return 0;
}

function runPpcommitCli() {
  const args = process.argv.slice(3); // skip "node coder ppcommit"
  let baseBranch = "";
  let hasBase = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && i + 1 < args.length) {
      baseBranch = args[i + 1];
      hasBase = true;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
  }

  const repoDir = process.cwd();
  const isGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repoDir, encoding: "utf8" });
  if (isGit.status !== 0) {
    process.stderr.write("ERROR: Not a git repository.\n");
    process.exit(1);
  }

  let result;
  if (hasBase) {
    result = runPpcommitBranch(repoDir, baseBranch);
  } else {
    result = runPpcommitAll(repoDir);
  }
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// Subcommand dispatch
if (process.argv[2] === "ppcommit") {
  runPpcommitCli();
} else {
  run().catch(async (err) => {
    process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
    await closeAllLoggers();
    process.exitCode = 1;
  });
}
