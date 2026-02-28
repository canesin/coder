#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";

import { loadConfig, resolveConfig } from "../src/config.js";
import { buildSecrets, resolvePassEnv } from "../src/helpers.js";
import { logsDir } from "../src/logging.js";
import { runPpcommitAll, runPpcommitBranch } from "../src/ppcommit.js";
import {
  loadLoopState,
  loadState,
  loadWorkflowSnapshot,
  writeControlSignal,
} from "../src/state/workflow-state.js";

function usage() {
  return `coder — management CLI for the coder MCP server

Subcommands:
  coder status [--workspace <path>] [--watch] [--json]
        Show current workflow state and progress.
        --watch  Refresh every 3 s until interrupted.
        --json   Output raw JSON.

  coder events [--workspace <path>] [--log <name>] [-n <count>]
               [--follow] [--run <runId>] [--json]
        Stream formatted log events from .coder/logs/<name>.jsonl.
        --log     Log file name without extension (default: develop).
                  Also accepts: machines, claude, gemini, codex, or any name.
        -n        Number of recent lines to show (default: 20).
        --follow  Follow the log file as new events are appended (like tail -f).
        --run     Filter by runId.
        --json    Output raw JSONL.

  coder cancel [--workspace <path>] [--run <runId>]
        Request cancellation of the current workflow run.

  coder pause [--workspace <path>] [--run <runId>]
        Request pause of the current workflow run.

  coder resume [--workspace <path>] [--run <runId>]
        Resume a paused workflow run.

  coder steering <generate|update> [--workspace <path>] [--force]
        Generate or update .coder/steering/ context files.
        generate  Scan the repo and create product.md, structure.md, tech.md.
        update    Re-scan and overwrite existing steering files.
        --force   Overwrite existing files (for generate).

  coder config [--workspace <path>]
        Show resolved configuration.

  coder ppcommit [--base <branch>]
        Run ppcommit checks on the repository.

  coder serve [--transport stdio|http] [--port <port>]
        Start the MCP server (delegates to coder-mcp).
`;
}

// --- Helpers ---

function resolveWorkspace(args) {
  const { values } = nodeParseArgs({
    args,
    strict: false,
    options: {
      workspace: { type: "string", default: "." },
    },
  });
  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }
  return workspaceDir;
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "EPERM") return true;
    return false;
  }
}

// --- coder status ---

function formatStatusHuman(status) {
  const lines = [];
  lines.push("Coder Status");
  lines.push("============\n");

  if (status.selected) {
    lines.push(`Issue: ${status.selected.title}`);
    lines.push(
      `  Source: ${status.selected.source}  ID: ${status.selected.id}`,
    );
  } else {
    lines.push("Issue: (none selected)");
  }

  lines.push(`Repo: ${status.repoPath || "(not set)"}`);
  lines.push(`Branch: ${status.branch || "(not set)"}`);
  if (status.lastError) {
    lines.push(`Last Error: ${String(status.lastError).slice(0, 120)}`);
  }
  if (status.prUrl) {
    lines.push(`PR: ${status.prUrl}`);
  }

  lines.push("\nWorkflow:");
  lines.push(`  Run ID: ${status.workflow.runId || "(none)"}`);
  lines.push(`  Status: ${status.workflow.status}`);
  if (status.workflow.currentStage) {
    lines.push(`  Stage:  ${status.workflow.currentStage}`);
  }
  if (status.workflow.activeAgent) {
    lines.push(`  Agent:  ${status.workflow.activeAgent}`);
  }
  if (status.workflow.runnerPid != null) {
    const alive = isPidAlive(status.workflow.runnerPid);
    const tag = alive === true ? "alive" : alive === false ? "dead" : "unknown";
    lines.push(`  Runner: PID ${status.workflow.runnerPid} (${tag})`);
  }
  if (status.workflow.lastHeartbeatAt) {
    const ago = Math.round(
      (Date.now() - new Date(status.workflow.lastHeartbeatAt)) / 1000,
    );
    lines.push(
      `  Heartbeat: ${ago}s ago (${status.workflow.lastHeartbeatAt.slice(11, 19)} UTC)`,
    );
  }

  if (status.workflow.issueQueue.length > 0) {
    lines.push(`  Queue: ${status.workflow.issueQueue.length} issues`);
    for (const e of status.workflow.issueQueue) {
      const statusIcon =
        { completed: "✓", failed: "✗", in_progress: "→", skipped: "~" }[
          e.status
        ] || " ";
      let detail = `    [${statusIcon}] ${e.source}:${e.id} — ${e.title}`;
      if (e.branch) detail += `\n         branch: ${e.branch}`;
      if (e.prUrl) detail += `\n         pr:     ${e.prUrl}`;
      if (e.error)
        detail += `\n         error:  ${String(e.error).slice(0, 100)}`;
      lines.push(detail);
    }
  }

  lines.push("\nArtifacts:");
  lines.push(
    `  ISSUE.md:         ${status.artifacts.issueExists ? "exists" : "missing"}`,
  );
  lines.push(
    `  PLAN.md:          ${status.artifacts.planExists ? "exists" : "missing"}`,
  );
  lines.push(
    `  PLANREVIEW.md:    ${status.artifacts.critiqueExists ? "exists" : "missing"}`,
  );
  lines.push(
    `  REVIEW_FINDINGS:  ${status.artifacts.reviewFindingsExists ? "exists" : "missing"}`,
  );

  if (status.wip?.enabled) {
    lines.push("\nWIP Push:");
    lines.push(`  Remote: ${status.wip.remote}`);
    lines.push(`  Auto-commit: ${status.wip.autoCommit}`);
    if (status.wip.lastPushedAt)
      lines.push(`  Last pushed: ${status.wip.lastPushedAt}`);
  }

  if (status.research) {
    lines.push("\nResearch:");
    lines.push(`  Run ID: ${status.research.runId || "(none)"}`);
    if (status.research.pipeline) {
      const p = status.research.pipeline;
      lines.push(
        `  Stages: ${Object.keys(p).length} (${Object.keys(p).join(", ")})`,
      );
    }
  }

  if (status.agentActivity) {
    lines.push("\nAgent Activity:");
    const act = status.agentActivity;
    if (act.lastActivityTs) {
      const ago = Math.round((Date.now() - act.lastActivityTs) / 1000);
      lines.push(`  Last activity: ${ago}s ago`);
    }
    if (act.currentCommand)
      lines.push(`  Command: ${String(act.currentCommand).slice(0, 80)}`);
  }

  if (status.mcpHealth) {
    const h = status.mcpHealth;
    const servers = Object.entries(h);
    if (servers.length > 0) {
      lines.push("\nMCP Servers:");
      for (const [name, info] of servers) {
        const st = info?.status || "unknown";
        lines.push(`  ${name}: ${st}`);
      }
    }
  }

  const steps = Object.entries(status.steps);
  if (steps.length > 0) {
    lines.push("\nSteps:");
    for (const [step, done] of steps) {
      lines.push(`  ${done ? "[x]" : "[ ]"} ${step}`);
    }
  }

  return lines.join("\n");
}

async function buildStatus(workspaceDir) {
  const state = await loadState(workspaceDir);
  const loopState = await loadLoopState(workspaceDir);
  const wfSnapshot = await loadWorkflowSnapshot(workspaceDir);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  const config = resolveConfig(workspaceDir);

  const activity = readJsonFile(
    path.join(workspaceDir, ".coder", "activity.json"),
  );
  const mcpHealth = readJsonFile(
    path.join(workspaceDir, ".coder", "mcp-health.json"),
  );
  const researchState = readJsonFile(
    path.join(workspaceDir, ".coder", "research-state.json"),
  );

  let research = null;
  if (researchState?.runId) {
    const pipelinePath = path.join(
      workspaceDir,
      ".coder",
      "scratchpad",
      researchState.runId,
      "pipeline.json",
    );
    research = {
      runId: researchState.runId,
      pipeline: readJsonFile(pipelinePath),
    };
  }

  return {
    workspace: workspaceDir,
    selected: state.selected || null,
    repoPath: state.repoPath || null,
    baseBranch: state.baseBranch || null,
    branch: state.branch || null,
    lastError: state.lastError || null,
    prUrl: state.prUrl || null,
    prBranch: state.prBranch || null,
    prBase: state.prBase || null,
    steps: state.steps || {},
    workflow: {
      runId: loopState.runId || wfSnapshot?.runId || null,
      status: loopState.status || "idle",
      goal: loopState.goal || null,
      currentStage:
        loopState.currentStage || wfSnapshot?.value?.currentStage || null,
      activeAgent: loopState.activeAgent || null,
      lastHeartbeatAt: loopState.lastHeartbeatAt || null,
      runnerPid: loopState.runnerPid || null,
      issueQueue: (loopState.issueQueue || []).map((e) => ({
        source: e.source,
        id: e.id,
        title: e.title,
        status: e.status,
        branch: e.branch || null,
        prUrl: e.prUrl || null,
        error: e.error || null,
      })),
    },
    wip: {
      enabled: config.workflow?.wip?.push || false,
      remote: config.workflow?.wip?.remote || "origin",
      autoCommit: config.workflow?.wip?.autoCommit || false,
      lastPushedAt: state.lastWipPushAt || null,
    },
    artifacts: {
      issueExists: existsSync(path.join(artifactsDir, "ISSUE.md")),
      planExists: existsSync(path.join(artifactsDir, "PLAN.md")),
      critiqueExists: existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
      reviewFindingsExists: existsSync(
        path.join(artifactsDir, "REVIEW_FINDINGS.md"),
      ),
    },
    agentActivity: activity,
    mcpHealth,
    research,
  };
}

async function runStatusCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      json: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const printStatus = async () => {
    const status = await buildStatus(workspaceDir);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatStatusHuman(status)}\n`);
    }
  };

  if (values.watch) {
    const redraw = async () => {
      process.stdout.write("\x1b[2J\x1b[H");
      await printStatus();
      process.stdout.write("\n\x1b[2m[watch mode — Ctrl+C to stop]\x1b[0m\n");
    };
    await redraw();
    const timer = setInterval(() => redraw().catch(() => {}), 3000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.stdout.write("\n");
      process.exit(0);
    });
  } else {
    await printStatus();
  }
}

// --- coder events ---

function isAgentLog(logName) {
  return ["claude", "gemini", "codex", "openai"].includes(logName);
}

function formatEventLine(d) {
  const ts = (d.ts || "").slice(11, 19);
  const event = String(d.event || "?").padEnd(26);
  const runId = d.runId ? `[${String(d.runId).slice(0, 8)}] ` : "";

  const parts = [];
  if (d.stage) parts.push(d.stage);
  if (d.machine) parts.push(d.machine);
  const issueId =
    d.issue && typeof d.issue === "object"
      ? d.issue.id
      : (d.issueId ?? d.issue);
  if (issueId) parts.push(String(issueId));
  if (d.verdict) parts.push(`verdict=${d.verdict}`);
  if (d.count != null && d.event !== "develop_stage")
    parts.push(`count=${d.count}`);
  if (d.branch) parts.push(`branch=${d.branch}`);
  if (d.prUrl) parts.push(`pr=${d.prUrl}`);
  if (d.message) parts.push(String(d.message).slice(0, 80));
  if (d.error) parts.push(`ERROR: ${String(d.error).slice(0, 80)}`);

  return `${ts}  ${event}  ${runId}${parts.join("  ")}`;
}

function formatAgentLine(d) {
  const ts = (d.ts || "").slice(11, 19);
  if (d.stream) {
    const tag = d.stream === "stderr" ? "[stderr]" : "[stdout]";
    const text = String(d.data || "").replace(/\n$/, "");
    const indent = `${ts}          `;
    return text
      .split("\n")
      .map((line, i) =>
        i === 0 ? `${ts}  ${tag}  ${line}` : `${indent}${line}`,
      )
      .join("\n");
  }
  return formatEventLine(d);
}

function readLastLines(filePath, n, runIdFilter) {
  if (!existsSync(filePath)) return [];
  const size = statSync(filePath).size;
  if (size === 0) return [];

  const maxRead = Math.min(size, 512 * 1024);
  const buf = Buffer.allocUnsafe(maxRead);
  const fd = openSync(filePath, "r");
  readSync(fd, buf, 0, maxRead, size - maxRead);
  closeSync(fd);

  const rawLines = buf
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim());
  const parsed = [];
  for (const line of rawLines) {
    try {
      const d = JSON.parse(line);
      if (!runIdFilter || d.runId === runIdFilter) parsed.push(d);
    } catch {}
  }
  return parsed.slice(-n);
}

async function runEventsCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      log: { type: "string", default: "develop" },
      n: { type: "string", default: "20" },
      follow: { type: "boolean", default: false },
      f: { type: "boolean", default: false },
      run: { type: "string", default: "" },
      json: { type: "boolean", default: false },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const logName = values.log;
  const count = Math.max(1, Number.parseInt(values.n, 10) || 20);
  const doFollow = values.follow || values.f;
  const runIdFilter = values.run || "";
  const logDir = logsDir(workspaceDir);

  if (logName === "" || logName === "list") {
    if (existsSync(logDir)) {
      const files = readdirSync(logDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""));
      process.stdout.write(`Available logs: ${files.join(", ")}\n`);
    } else {
      process.stdout.write("No logs directory found.\n");
    }
    return;
  }

  const logFile = path.join(logDir, `${logName}.jsonl`);
  const agentLog = isAgentLog(logName);
  const formatLine = agentLog ? formatAgentLine : formatEventLine;

  const printLines = (lines) => {
    if (values.json) {
      for (const d of lines) process.stdout.write(`${JSON.stringify(d)}\n`);
    } else {
      for (const d of lines) process.stdout.write(`${formatLine(d)}\n`);
    }
  };

  const initial = readLastLines(logFile, count, runIdFilter);
  if (initial.length === 0 && !doFollow) {
    process.stdout.write(
      `(no events${runIdFilter ? ` for run ${runIdFilter}` : ""} in ${logName}.jsonl)\n`,
    );
    return;
  }
  printLines(initial);

  if (!doFollow) return;

  process.stdout.write(
    `\x1b[2m--- following ${logName}.jsonl (Ctrl+C to stop) ---\x1b[0m\n`,
  );

  let position = existsSync(logFile) ? statSync(logFile).size : 0;
  let partial = "";

  const readNew = () => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size <= position) return;

    const toRead = size - position;
    const buf = Buffer.allocUnsafe(toRead);
    const fd = openSync(logFile, "r");
    const bytesRead = readSync(fd, buf, 0, toRead, position);
    closeSync(fd);
    position += bytesRead;

    const text = partial + buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    partial = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (!runIdFilter || d.runId === runIdFilter) printLines([d]);
      } catch {}
    }
  };

  const watchTarget = existsSync(logFile) ? logFile : logDir;
  const watcher = watch(watchTarget, { persistent: true }, (eventType) => {
    if (eventType === "change" || eventType === "rename") readNew();
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.stdout.write("\n");
    process.exit(0);
  });
}

// --- coder cancel / pause / resume ---

async function runControlCli(action) {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      run: { type: "string", default: "" },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const loopState = await loadLoopState(workspaceDir);
  const runId = values.run || loopState.runId;

  if (!runId) {
    process.stderr.write(
      "No active run found. Use --run <runId> to specify.\n",
    );
    process.exit(1);
  }

  if (
    action === "cancel" &&
    !["running", "paused"].includes(loopState.status)
  ) {
    process.stderr.write(
      `Run ${runId} is ${loopState.status}, not running/paused.\n`,
    );
    process.exit(1);
  }
  if (action === "pause" && loopState.status !== "running") {
    process.stderr.write(`Run ${runId} is ${loopState.status}, not running.\n`);
    process.exit(1);
  }
  if (action === "resume" && loopState.status !== "paused") {
    process.stderr.write(`Run ${runId} is ${loopState.status}, not paused.\n`);
    process.exit(1);
  }

  await writeControlSignal(workspaceDir, { action, runId });
  process.stdout.write(`${action} signal written for run ${runId}\n`);

  // For cancel, also check if runner is alive and send SIGTERM
  if (action === "cancel" && loopState.runnerPid) {
    const alive = isPidAlive(loopState.runnerPid);
    if (alive) {
      process.stdout.write(
        `Runner PID ${loopState.runnerPid} is alive — signal file will be picked up within ~2s.\n`,
      );
    } else {
      process.stdout.write(
        `Runner PID ${loopState.runnerPid} is not alive — run may already be dead.\n`,
      );
    }
  }
}

// --- coder steering ---

async function runSteeringCli() {
  const subAction = process.argv[3];
  if (!subAction || !["generate", "update"].includes(subAction)) {
    process.stderr.write(
      "Usage: coder steering <generate|update> [--workspace <path>] [--force]\n",
    );
    process.exit(1);
  }

  const { values } = nodeParseArgs({
    args: process.argv.slice(4),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      force: { type: "boolean", default: false },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  // Dynamic imports to avoid loading heavy deps for other subcommands
  const { AgentPool } = await import("../src/agents/pool.js");
  const {
    buildSteeringGenerationPrompt,
    loadSteeringContext,
    parseSteeringResponse,
    steeringDirFor,
    writeSteeringFiles,
  } = await import("../src/steering.js");

  const config = resolveConfig(workspaceDir);

  if (subAction === "generate" && !values.force) {
    const existing = loadSteeringContext(workspaceDir);
    if (existing) {
      process.stdout.write(
        `Steering files already exist at ${steeringDirFor(workspaceDir)}.\nUse --force to regenerate.\n`,
      );
      return;
    }
  }

  process.stdout.write(
    `${subAction === "generate" ? "Generating" : "Updating"} steering context...\n`,
  );

  const secrets = buildSecrets(resolvePassEnv(config));
  const pool = new AgentPool({
    config,
    workspaceDir,
    verbose: false,
  });

  try {
    const prompt = buildSteeringGenerationPrompt(workspaceDir);
    const { agent } = pool.getAgent("gemini");
    const result = await agent.execute(prompt, {
      timeoutMs: 120_000,
      env: secrets,
    });

    if (!result?.stdout) {
      process.stderr.write("Steering generation failed: no agent output.\n");
      process.exit(1);
    }

    const parsed = parseSteeringResponse(result.stdout);
    const sections = Object.keys(parsed);
    if (sections.length === 0) {
      process.stderr.write(
        "Steering generation failed: could not parse output into sections.\n",
      );
      process.exit(1);
    }

    const written = writeSteeringFiles(workspaceDir, parsed);
    process.stdout.write(
      `${subAction === "generate" ? "Generated" : "Updated"} ${written.length} steering files in ${steeringDirFor(workspaceDir)}: ${written.join(", ")}\n`,
    );
  } finally {
    await pool.killAll();
  }
}

// --- coder config ---

function runConfigCli() {
  const workspaceDir = resolveWorkspace(process.argv.slice(3));
  const config = resolveConfig(workspaceDir);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

// --- coder ppcommit ---

async function runPpcommitCli() {
  const args = process.argv.slice(3);
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

// --- coder serve ---

function runServeCli() {
  const args = process.argv.slice(3);
  const binDir = new URL(".", import.meta.url).pathname;
  const mcpPath = path.join(binDir, "coder-mcp.js");
  const result = spawnSync(process.execPath, [mcpPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

// --- Subcommand dispatch ---

const subcommand = process.argv[2];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  process.stdout.write(usage());
  process.exit(0);
}

switch (subcommand) {
  case "status":
    runStatusCli().catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "events":
    runEventsCli().catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "cancel":
    runControlCli("cancel").catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "pause":
    runControlCli("pause").catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "resume":
    runControlCli("resume").catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "steering":
    runSteeringCli().catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "config":
    runConfigCli();
    break;
  case "ppcommit":
    runPpcommitCli().catch((err) => {
      process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
      process.exitCode = 1;
    });
    break;
  case "serve":
    runServeCli();
    break;
  default:
    process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
    process.stdout.write(usage());
    process.exit(1);
}
