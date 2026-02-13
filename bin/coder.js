#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { parseArgs as nodeParseArgs } from "node:util";

import Table from "cli-table3";

import { AgentRunner } from "../src/agent-runner.js";
import { loadConfig } from "../src/config.js";
import {
  defaultDurabilityEnvText,
  defaultLitestreamConfigText,
  durableServiceName,
  renderDurableSystemdUnit,
  upsertEnvVar,
} from "../src/durability.js";
import {
  buildSecrets,
  DEFAULT_PASS_ENV,
  extractJson,
  formatCommandFailure,
  gitCleanOrThrow,
  heredocPipe,
  requireCommandOnPath,
  requireEnvOneOf,
  runHostTests,
  runPlanreview,
  upsertIssueCompletionBlock,
} from "../src/helpers.js";
import { HostSandboxProvider } from "../src/host-sandbox.js";
import {
  closeAllLoggers,
  ensureLogsDir,
  makeJsonlLogger,
  sanitizeLogEvent,
} from "../src/logging.js";
import {
  runPpcommitAll,
  runPpcommitBranch,
  runPpcommitNative,
} from "../src/ppcommit.js";
import {
  IssuesPayloadSchema,
  ProjectsPayloadSchema,
  QuestionsPayloadSchema,
} from "../src/schemas.js";
import { loadState, saveState, statePathFor } from "../src/state.js";
import { buildIssueBranchName, ensureWorktree } from "../src/worktrees.js";

function usage() {
  return `coder (multi-agent orchestrator; host sandbox)

Usage:
  coder [--workspace <path>] [--repo <path>] [--issue-index <n>] [--verbose]
        [--test-cmd "<cmd>"] [--allow-no-tests]

  coder ppcommit [--base <branch>]
        Run ppcommit checks on the repository.
        Without --base: checks all files in the repo.
        With --base: checks only files changed since the given branch.

  coder durability install [--workspace <path>] [--scope <system|user>] [--replica-url <url>] [--no-now]
        Bootstrap litestream.yml + .coder/litestream.env, install a systemd service, daemon-reload, and enable/start.

  coder durability {status|start|stop|restart|logs|uninstall} [--workspace <path>] [--scope <system|user>]
        Manage the durable coder-mcp service for the workspace.

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
  --claude-dangerously-skip-permissions  Default: on. Run Claude Code without permission prompts (risky)
  --claude-require-permissions           Force permission prompts for Claude Code (safer)
`;
}

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
      "claude-dangerously-skip-permissions": { type: "boolean", default: true },
      "claude-require-permissions": { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      "pass-env": { type: "string", default: "" },
    },
  });

  const claudeDangerouslySkipPermissions = values["claude-require-permissions"]
    ? false
    : values["claude-dangerously-skip-permissions"];

  return {
    help: values.help,
    workspace: values.workspace,
    repo: values.repo,
    issueIndex: values["issue-index"]
      ? Number.parseInt(values["issue-index"], 10)
      : -1,
    verbose: values.verbose,
    issueFile: "ISSUE.md",
    planFile: "PLAN.md",
    critiqueFile: "PLANREVIEW.md",
    allowNoTests: values["allow-no-tests"],
    testCmd: values["test-cmd"],
    claudeDangerouslySkipPermissions,
    passEnv: values["pass-env"]
      ? values["pass-env"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_PASS_ENV,
  };
}

async function promptText(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function runPpcommit(repoDir, ppcommitConfig) {
  return await runPpcommitNative(repoDir, ppcommitConfig);
}

function renderIssuesTable(issues, recommendedIndex) {
  const table = new Table({
    head: [" #", "Source", "ID", "Diff", "Title", "Reason"],
    colWidths: [6, 8, 26, 6, 44, 34],
    style: { head: [], border: [] },
    wordWrap: true,
  });
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    table.push([
      i === recommendedIndex ? `\u2192${i + 1}` : ` ${i + 1}`,
      it.source,
      it.id,
      `${it.difficulty}/5`,
      it.title,
      it.reason || "",
    ]);
  }
  return table.toString() + "\n\u2192 = Gemini recommendation\n";
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
  if (!existsSync(workspaceDir))
    throw new Error(`Workspace does not exist: ${workspaceDir}`);

  const config = loadConfig(workspaceDir);

  mkdirSync(path.join(workspaceDir, ".coder"), { recursive: true });
  ensureLogsDir(workspaceDir);

  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const modernIssuePath = path.join(artifactsDir, args.issueFile);
  const modernPlanPath = path.join(artifactsDir, args.planFile);
  const modernCritiquePath = path.join(artifactsDir, args.critiqueFile);

  const issuePath = modernIssuePath;
  const planPath = modernPlanPath;
  const critiquePath = modernCritiquePath;

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
      vk.on("stdout", (d) =>
        process.stdout.write(`[${name}] ${sanitizeLogEvent(String(d))}`),
      );
      vk.on("stderr", (d) =>
        process.stderr.write(`[${name}] ${sanitizeLogEvent(String(d))}`),
      );
    }
  };

  // Gemini runs at workspace scope.
  const geminiProvider = new HostSandboxProvider({
    defaultCwd: workspaceDir,
    baseEnv: secrets,
  });
  const gemini = new AgentRunner(geminiProvider);
  attachAgentLogging("gemini", gemini);

  // --- Step 0: Linear project selection ---
  if (
    secrets.LINEAR_API_KEY &&
    (!state.steps.listedProjects || !state.linearProjects)
  ) {
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
    const projCmd = heredocPipe(
      projPrompt,
      `gemini --model ${config.models.geminiPreview} --yolo`,
    );
    const projRes = await gemini.executeCommand(projCmd, {
      timeoutMs: 1000 * 60 * 5,
    });
    if (projRes.exitCode !== 0)
      throw new Error(
        formatCommandFailure("Gemini project listing failed", projRes),
      );
    const projPayload = ProjectsPayloadSchema.parse(
      extractJson(projRes.stdout),
    );
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
        if (
          !Number.isInteger(idx) ||
          idx < 1 ||
          idx > state.linearProjects.length
        ) {
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

    const cmd = heredocPipe(
      listPrompt,
      `gemini --model ${config.models.geminiPreview} --yolo`,
    );
    const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 10 });
    if (res.exitCode !== 0)
      throw new Error(formatCommandFailure("Gemini issue listing failed", res));
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
    if (
      Number.isInteger(args.issueIndex) &&
      args.issueIndex >= 0 &&
      args.issueIndex < issues.length
    ) {
      selected = issues[args.issueIndex];
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        renderIssuesTable(issues, issuesPayload.recommended_index),
      );
      process.stdout.write("\n");
      const raw = await promptText("Pick an issue number: ");
      const idx = Number.parseInt(raw, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > issues.length)
        throw new Error("Invalid issue selection.");
      selected = issues[idx - 1];
    }

    let repoPath = (args.repo || selected.repo_path || "").trim();
    if (!repoPath)
      repoPath = await promptText(
        "Repo subfolder to work in (relative to workspace): ",
      );

    state.selected = selected;
    state.repoPath = repoPath;
    state.branch = buildIssueBranchName(selected);
    saveState(workspaceDir, state);
  }

  const repoRoot = path.resolve(workspaceDir, state.repoPath);
  if (!existsSync(repoRoot))
    throw new Error(`Repo root does not exist: ${repoRoot}`);
  const isGit = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (isGit.status !== 0) throw new Error(`Not a git repository: ${repoRoot}`);

  // Hard gate: require repo clean before any agent writes code.
  if (!state.steps.verifiedCleanRepo) {
    process.stdout.write("\n[1.6/8] Verifying repo is clean...\n");
    gitCleanOrThrow(repoRoot);
    state.steps.verifiedCleanRepo = true;
    saveState(workspaceDir, state);
  }

  const worktreesRoot = path.join(
    workspaceDir,
    ".coder",
    "worktrees",
    state.repoPath.replaceAll("/", "__"),
  );
  mkdirSync(worktreesRoot, { recursive: true });
  const repoWorktree = ensureWorktree(repoRoot, worktreesRoot, state.branch);

  // Repo-scoped agents operate from the worktree directory.
  const makeRepoAgent = (name) => {
    const provider = new HostSandboxProvider({
      defaultCwd: repoWorktree,
      baseEnv: secrets,
    });
    const agent = new AgentRunner(provider);
    attachAgentLogging(name, agent);
    return agent;
  };

  const claude = makeRepoAgent("claude");
  const codex = makeRepoAgent("codex");

  // --- Step 2: Gemini asks 3 questions (only human interaction) ---
  if (
    !state.questions ||
    !state.answers ||
    state.questions.length !== 3 ||
    state.answers.length !== 3
  ) {
    process.stdout.write(
      "\n[2/7] Gemini: generating 3 clarification questions...\n",
    );
    const qPrompt = `We chose this issue:
- source: ${state.selected.source}
- id: ${state.selected.id}
- title: ${state.selected.title}
- repo_root: ${repoRoot}

Ask EXACTLY 3 clarifying questions that are essential to implement this issue correctly in this codebase.
Return ONLY valid JSON:
{"questions":["q1","q2","q3"]}`;

    const cmd = heredocPipe(
      qPrompt,
      `gemini --model ${config.models.geminiPreview} --yolo`,
    );
    const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 5 });
    if (res.exitCode !== 0)
      throw new Error(formatCommandFailure("Gemini questions failed", res));
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
    const cmd = heredocPipe(
      issuePrompt,
      `gemini --model ${config.models.geminiPreview} --yolo`,
    );
    const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 10 });
    if (res.exitCode !== 0)
      throw new Error(
        formatCommandFailure("Gemini ISSUE.md drafting failed", res),
      );
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
      `claude -p --output-format stream-json --model ${config.models.claude}${
        args.claudeDangerouslySkipPermissions
          ? " --dangerously-skip-permissions"
          : ""
      }`,
    );
    const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 20 });
    if (res.exitCode !== 0) throw new Error("Claude plan generation failed.");

    // Hard gate: Claude must not change the repo during planning
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoWorktree,
      encoding: "utf8",
    });
    if (status.status !== 0)
      throw new Error("Failed to check git status after planning.");
    // Planning must not modify the repo. Allow internal tool dirs only.
    const artifactFiles = [".coder/", ".gemini/"];
    const dirtyLines = (status.stdout || "")
      .split("\n")
      .filter(
        (l) => l.trim() !== "" && !artifactFiles.some((a) => l.includes(a)),
      );
    if (dirtyLines.length > 0) {
      throw new Error(
        `Planning step modified the repository. Aborting.\n${dirtyLines.join("\n")}`,
      );
    }

    if (!existsSync(planPath))
      throw new Error(`PLAN.md not found: ${planPath}`);
    state.steps.wrotePlan = true;
    saveState(workspaceDir, state);
  }

  // --- Step 5: planreview critique ---
  if (!state.steps.wroteCritique) {
    process.stdout.write("\n[5/7] planreview: critiquing PLAN.md...\n");
    const rc = runPlanreview(repoWorktree, planPath, critiquePath);
    if (rc !== 0)
      process.stdout.write(
        "WARNING: planreview exited non-zero. Continuing.\n",
      );
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
      `claude -p --output-format stream-json --model ${config.models.claude}${
        args.claudeDangerouslySkipPermissions
          ? " --dangerously-skip-permissions"
          : ""
      }`,
    );
    const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 60 });
    if (res.exitCode !== 0) throw new Error("Claude implementation failed.");
    state.steps.implemented = true;
    saveState(workspaceDir, state);
  }

  // --- Step 7: Codex runs ppcommit, fixes, and tests ---
  if (!state.steps.codexReviewed) {
    process.stdout.write("\n[7/7] Codex: ppcommit + fixes + tests...\n");
    const ppBefore = await runPpcommit(repoWorktree, config.ppcommit);
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
  const ppAfter = await runPpcommit(repoWorktree, config.ppcommit);
  if (ppAfter.exitCode !== 0) {
    process.stdout.write(ppAfter.stdout || ppAfter.stderr);
    throw new Error("ppcommit still reports issues after Codex pass.");
  }
  state.steps.ppcommitClean = true;
  saveState(workspaceDir, state);

  // Hard gate: tests must pass on host
  process.stdout.write("\n[7.2/7] Running tests on host...\n");
  const testRes = await runHostTests(repoWorktree, args);
  if (testRes.cmd)
    process.stdout.write(`Test command: ${testRes.cmd.join(" ")}\n`);
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

async function runPpcommitCli() {
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
  const isGit = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (isGit.status !== 0) {
    process.stderr.write("ERROR: Not a git repository.\n");
    process.exit(1);
  }

  const ppConfig = loadConfig(repoDir).ppcommit;

  let result;
  if (hasBase) {
    result = await runPpcommitBranch(repoDir, baseBranch, ppConfig);
  } else {
    result = await runPpcommitAll(repoDir, ppConfig);
  }
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

function durabilityUsage() {
  return `coder durability

Usage:
  coder durability install [--workspace <path>] [--scope <system|user>] [--replica-url <url>] [--host <host>] [--port <port>] [--path <route>] [--allowed-hosts <csv>] [--no-now] [--dry-run]
  coder durability status [--workspace <path>] [--scope <system|user>]
  coder durability start [--workspace <path>] [--scope <system|user>]
  coder durability stop [--workspace <path>] [--scope <system|user>]
  coder durability restart [--workspace <path>] [--scope <system|user>]
  coder durability logs [--workspace <path>] [--scope <system|user>] [--lines <n>] [--follow]
  coder durability uninstall [--workspace <path>] [--scope <system|user>] [--dry-run]
  coder durability run [--workspace <path>]   # internal: used by systemd ExecStart

Notes:
  - scope=system writes unit files under /etc/systemd/system (typically requires root).
  - scope=user writes unit files under ~/.config/systemd/user.
  - Service name is deterministic per workspace path.
`;
}

function parseDurabilityArgs(argv) {
  const raw = [...argv];
  const action =
    raw[0] && !raw[0].startsWith("-") ? String(raw.shift()) : "help";
  const opts = {
    workspace: ".",
    scope: "system",
    replicaUrl: "",
    host: "127.0.0.1",
    port: "8787",
    routePath: "/mcp",
    allowedHosts: "",
    noNow: false,
    dryRun: false,
    lines: 200,
    follow: false,
    serviceName: "",
  };

  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (token === "--workspace" && i + 1 < raw.length) {
      opts.workspace = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--scope" && i + 1 < raw.length) {
      opts.scope = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--replica-url" && i + 1 < raw.length) {
      opts.replicaUrl = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--host" && i + 1 < raw.length) {
      opts.host = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--port" && i + 1 < raw.length) {
      opts.port = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--path" && i + 1 < raw.length) {
      opts.routePath = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--allowed-hosts" && i + 1 < raw.length) {
      opts.allowedHosts = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--service-name" && i + 1 < raw.length) {
      opts.serviceName = raw[i + 1];
      i++;
      continue;
    }
    if (token === "--lines" && i + 1 < raw.length) {
      const n = Number.parseInt(raw[i + 1], 10);
      if (Number.isInteger(n) && n > 0) opts.lines = n;
      i++;
      continue;
    }
    if (token === "--no-now") {
      opts.noNow = true;
      continue;
    }
    if (token === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (token === "--follow" || token === "-f") {
      opts.follow = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { action: "help", opts };
    }
    throw new Error(`Unknown durability argument: ${token}`);
  }

  if (!["system", "user"].includes(opts.scope)) {
    throw new Error(`Invalid --scope: ${opts.scope} (expected system|user)`);
  }
  const parsedPort = Number.parseInt(opts.port, 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  opts.port = String(parsedPort);
  if (!String(opts.routePath || "").startsWith("/")) {
    opts.routePath = `/${opts.routePath}`;
  }
  return { action, opts };
}

function runShellCommand(
  cmd,
  args,
  { cwd, dryRun = false, check = true } = {},
) {
  if (dryRun) {
    process.stdout.write(`[dry-run] ${[cmd, ...args].join(" ")}\n`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (check && res.status !== 0) {
    throw new Error(`${cmd} failed with status ${res.status}`);
  }
  return res;
}

function unitContext(scope, serviceName) {
  if (scope === "user") {
    const homeDir = process.env.HOME || os.homedir();
    const unitDir = path.join(homeDir, ".config", "systemd", "user");
    return {
      unitDir,
      unitPath: path.join(unitDir, serviceName),
      systemctlPrefix: ["--user"],
      wantedBy: "default.target",
    };
  }
  const unitDir = "/etc/systemd/system";
  return {
    unitDir,
    unitPath: path.join(unitDir, serviceName),
    systemctlPrefix: [],
    wantedBy: "multi-user.target",
  };
}

function ensureDurabilityFiles(
  workspaceDir,
  { replicaUrl, host, port, routePath, allowedHosts, dryRun } = {},
) {
  const litestreamPath = path.join(workspaceDir, "litestream.yml");
  const coderDir = path.join(workspaceDir, ".coder");
  const envPath = path.join(coderDir, "litestream.env");

  if (dryRun) {
    if (!existsSync(litestreamPath)) {
      process.stdout.write(`[dry-run] create ${litestreamPath}\n`);
    }
    if (!existsSync(envPath)) {
      process.stdout.write(`[dry-run] create ${envPath}\n`);
    }
    if (replicaUrl) {
      process.stdout.write(
        `[dry-run] set LITESTREAM_REPLICA_URL in ${envPath}\n`,
      );
    }
    process.stdout.write(
      `[dry-run] set CODER_MCP_HOST/CODER_MCP_PORT/CODER_MCP_PATH in ${envPath}\n`,
    );
    if (allowedHosts) {
      process.stdout.write(
        `[dry-run] set CODER_MCP_ALLOWED_HOSTS in ${envPath}\n`,
      );
    }
    return { litestreamPath, envPath };
  }

  mkdirSync(coderDir, { recursive: true });
  if (!existsSync(litestreamPath)) {
    writeFileSync(litestreamPath, defaultLitestreamConfigText(), "utf8");
  }
  if (!existsSync(envPath)) {
    writeFileSync(envPath, defaultDurabilityEnvText(), "utf8");
  }
  if (replicaUrl) {
    const current = readFileSync(envPath, "utf8");
    const next = upsertEnvVar(current, "LITESTREAM_REPLICA_URL", replicaUrl);
    if (next !== current) writeFileSync(envPath, next, "utf8");
  }
  const current = readFileSync(envPath, "utf8");
  let next = upsertEnvVar(current, "CODER_MCP_HOST", host || "127.0.0.1");
  next = upsertEnvVar(next, "CODER_MCP_PORT", String(port || "8787"));
  next = upsertEnvVar(next, "CODER_MCP_PATH", routePath || "/mcp");
  if (allowedHosts !== undefined && allowedHosts !== null) {
    next = upsertEnvVar(next, "CODER_MCP_ALLOWED_HOSTS", String(allowedHosts));
  }
  if (next !== current) writeFileSync(envPath, next, "utf8");
  return { litestreamPath, envPath };
}

async function runDurabilityCli() {
  const { action, opts } = parseDurabilityArgs(process.argv.slice(3));
  if (action === "help" || !action) {
    process.stdout.write(durabilityUsage());
    process.exit(0);
  }

  const workspaceDir = path.resolve(opts.workspace || ".");
  const serviceName = opts.serviceName || durableServiceName(workspaceDir);
  const { unitDir, unitPath, systemctlPrefix } = unitContext(
    opts.scope,
    serviceName,
  );

  const runSystemctl = (args, extra = {}) =>
    runShellCommand("systemctl", [...systemctlPrefix, ...args], extra);

  switch (action) {
    case "install": {
      requireCommandOnPath("systemctl");
      const { litestreamPath, envPath } = ensureDurabilityFiles(workspaceDir, {
        replicaUrl: opts.replicaUrl,
        host: opts.host,
        port: opts.port,
        routePath: opts.routePath,
        allowedHosts: opts.allowedHosts,
        dryRun: opts.dryRun,
      });
      const coderBin = path.resolve(process.argv[1]);
      const unitText = renderDurableSystemdUnit({
        workspaceDir,
        scope: opts.scope,
        envFilePath: envPath,
        coderBin,
      });

      if (opts.dryRun) {
        process.stdout.write(`[dry-run] mkdir -p ${unitDir}\n`);
        process.stdout.write(`[dry-run] write unit: ${unitPath}\n`);
        process.stdout.write(`[dry-run] unit references ${litestreamPath}\n`);
      } else {
        mkdirSync(unitDir, { recursive: true });
        writeFileSync(unitPath, unitText, "utf8");
      }

      runSystemctl(["daemon-reload"], { dryRun: opts.dryRun });
      const enableArgs = ["enable"];
      if (!opts.noNow) enableArgs.push("--now");
      enableArgs.push(serviceName);
      runSystemctl(enableArgs, { dryRun: opts.dryRun });

      process.stdout.write(`Service installed: ${serviceName}\n`);
      process.stdout.write(`Unit path: ${unitPath}\n`);
      process.stdout.write(`Workspace: ${workspaceDir}\n`);
      process.stdout.write(`Scope: ${opts.scope}\n`);
      process.stdout.write(
        `HTTP endpoint: http://${opts.host}:${opts.port}${opts.routePath}\n`,
      );
      process.stdout.write(
        `Tip: set LITESTREAM_REPLICA_URL in ${path.join(workspaceDir, ".coder", "litestream.env")}\n`,
      );
      process.exit(0);
      break;
    }
    case "status": {
      requireCommandOnPath("systemctl");
      runSystemctl(["status", serviceName, "--no-pager"]);
      process.exit(0);
      break;
    }
    case "start": {
      requireCommandOnPath("systemctl");
      runSystemctl(["start", serviceName]);
      process.exit(0);
      break;
    }
    case "stop": {
      requireCommandOnPath("systemctl");
      runSystemctl(["stop", serviceName]);
      process.exit(0);
      break;
    }
    case "restart": {
      requireCommandOnPath("systemctl");
      runSystemctl(["restart", serviceName]);
      process.exit(0);
      break;
    }
    case "logs": {
      requireCommandOnPath("journalctl");
      const args = [];
      if (opts.scope === "user") args.push("--user");
      args.push("-u", serviceName, "--no-pager", "-n", String(opts.lines));
      if (opts.follow) args.push("-f");
      runShellCommand("journalctl", args);
      process.exit(0);
      break;
    }
    case "uninstall": {
      requireCommandOnPath("systemctl");
      runSystemctl(["disable", "--now", serviceName], {
        dryRun: opts.dryRun,
        check: false,
      });
      if (opts.dryRun) {
        process.stdout.write(`[dry-run] rm -f ${unitPath}\n`);
      } else if (existsSync(unitPath)) {
        unlinkSync(unitPath);
      }
      runSystemctl(["daemon-reload"], { dryRun: opts.dryRun });
      process.stdout.write(`Service removed: ${serviceName}\n`);
      process.exit(0);
      break;
    }
    case "run": {
      requireCommandOnPath("litestream");
      requireCommandOnPath("coder-mcp");

      const litestreamPath = path.join(workspaceDir, "litestream.yml");
      if (!existsSync(litestreamPath)) {
        throw new Error(
          `Missing litestream.yml at ${litestreamPath}. Run "coder durability install" first.`,
        );
      }
      mkdirSync(path.join(workspaceDir, ".coder"), { recursive: true });
      runShellCommand(
        "litestream",
        [
          "restore",
          "-if-replica-exists",
          "-if-db-not-exists",
          "-config",
          "litestream.yml",
          ".coder/state.db",
        ],
        { cwd: workspaceDir },
      );
      const host = process.env.CODER_MCP_HOST || "127.0.0.1";
      const port = process.env.CODER_MCP_PORT || "8787";
      const routePath = process.env.CODER_MCP_PATH || "/mcp";
      const allowedHosts = process.env.CODER_MCP_ALLOWED_HOSTS || "";
      const mcpArgs = [
        "coder-mcp",
        "--workspace",
        workspaceDir,
        "--transport",
        "http",
        "--host",
        host,
        "--port",
        String(port),
        "--path",
        routePath,
      ];
      if (allowedHosts.trim()) {
        mcpArgs.push("--allowed-hosts", allowedHosts.trim());
      }
      const execCmd = mcpArgs.map((arg) => JSON.stringify(arg)).join(" ");
      const res = runShellCommand(
        "litestream",
        ["replicate", "-config", "litestream.yml", "-exec", execCmd],
        { cwd: workspaceDir, check: false },
      );
      process.exit(res.status ?? 1);
      break;
    }
    default:
      throw new Error(`Unknown durability action: ${action}`);
  }
}

// Subcommand dispatch
if (process.argv[2] === "ppcommit") {
  runPpcommitCli().catch((err) => {
    process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "durability") {
  runDurabilityCli().catch((err) => {
    process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  });
} else {
  run().catch(async (err) => {
    process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
    await closeAllLoggers();
    process.exitCode = 1;
  });
}
