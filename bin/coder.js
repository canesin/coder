#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";

import { loadConfig, resolveConfig } from "../src/config.js";
import { runPpcommitAll, runPpcommitBranch } from "../src/ppcommit.js";
import { loadLoopState, loadState } from "../src/state/workflow-state.js";

function usage() {
  return `coder — management CLI for the coder MCP server

Subcommands:
  coder status [--workspace <path>]
        Show current workflow state and progress.

  coder config [--workspace <path>]
        Show resolved configuration.

  coder ppcommit [--base <branch>]
        Run ppcommit checks on the repository.
        Without --base: checks all files in the repo.
        With --base: checks only files changed since the given branch.

  coder serve [--transport stdio|http] [--port <port>]
        Start the MCP server (delegates to coder-mcp).

Workflows are orchestrated through the MCP server tools:
  - coder_workflow { action: "start", workflow: "develop|research|design" }
  - Individual machine tools: coder_develop_*, coder_research_*, coder_design_*
  - Status: coder_status, coder_workflow { action: "status" }
`;
}

function runStatusCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
      json: { type: "boolean", default: false },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const state = loadState(workspaceDir);
  const loopState = loadLoopState(workspaceDir);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");

  const status = {
    workspace: workspaceDir,
    selected: state.selected || null,
    repoPath: state.repoPath || null,
    branch: state.branch || null,
    steps: state.steps || {},
    workflow: {
      runId: loopState.runId || null,
      status: loopState.status || "idle",
      goal: loopState.goal || null,
      currentStage: loopState.currentStage || null,
      activeAgent: loopState.activeAgent || null,
      lastHeartbeatAt: loopState.lastHeartbeatAt || null,
      issueQueue: (loopState.issueQueue || []).map((e) => ({
        source: e.source,
        id: e.id,
        title: e.title,
        status: e.status,
      })),
    },
    artifacts: {
      issueExists: existsSync(path.join(artifactsDir, "ISSUE.md")),
      planExists: existsSync(path.join(artifactsDir, "PLAN.md")),
      critiqueExists: existsSync(path.join(artifactsDir, "PLANREVIEW.md")),
    },
  };

  if (values.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write("Coder Status\n");
    process.stdout.write("============\n\n");

    if (status.selected) {
      process.stdout.write(`Issue: ${status.selected.title}\n`);
      process.stdout.write(
        `  Source: ${status.selected.source}  ID: ${status.selected.id}\n`,
      );
    } else {
      process.stdout.write("Issue: (none selected)\n");
    }

    process.stdout.write(`Repo: ${status.repoPath || "(not set)"}\n`);
    process.stdout.write(`Branch: ${status.branch || "(not set)"}\n\n`);

    process.stdout.write("Workflow:\n");
    process.stdout.write(`  Run ID: ${status.workflow.runId || "(none)"}\n`);
    process.stdout.write(`  Status: ${status.workflow.status}\n`);
    if (status.workflow.currentStage) {
      process.stdout.write(`  Stage: ${status.workflow.currentStage}\n`);
    }
    if (status.workflow.activeAgent) {
      process.stdout.write(`  Agent: ${status.workflow.activeAgent}\n`);
    }
    if (status.workflow.issueQueue.length > 0) {
      process.stdout.write(
        `  Queue: ${status.workflow.issueQueue.length} issues\n`,
      );
      for (const entry of status.workflow.issueQueue) {
        process.stdout.write(
          `    [${entry.status}] ${entry.source}:${entry.id} — ${entry.title}\n`,
        );
      }
    }

    process.stdout.write("\nArtifacts:\n");
    process.stdout.write(
      `  ISSUE.md:      ${status.artifacts.issueExists ? "exists" : "missing"}\n`,
    );
    process.stdout.write(
      `  PLAN.md:       ${status.artifacts.planExists ? "exists" : "missing"}\n`,
    );
    process.stdout.write(
      `  PLANREVIEW.md: ${status.artifacts.critiqueExists ? "exists" : "missing"}\n`,
    );

    const steps = Object.entries(status.steps);
    if (steps.length > 0) {
      process.stdout.write("\nSteps:\n");
      for (const [step, done] of steps) {
        process.stdout.write(`  ${done ? "[x]" : "[ ]"} ${step}\n`);
      }
    }
  }
}

function runConfigCli() {
  const { values } = nodeParseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      workspace: { type: "string", default: "." },
    },
  });

  const workspaceDir = path.resolve(values.workspace);
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`Workspace does not exist: ${workspaceDir}\n`);
    process.exit(1);
  }

  const config = resolveConfig(workspaceDir);
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

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

// Subcommand dispatch
const subcommand = process.argv[2];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  process.stdout.write(usage());
  process.exit(0);
}

switch (subcommand) {
  case "status":
    runStatusCli();
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
