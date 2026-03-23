import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { logsDir } from "../logging.js";
import { saveLoopState } from "../state/workflow-state.js";
import { runHooks } from "./_base.js";

/** Max chars per artifact included in RCA context. */
const ARTIFACT_TRUNCATE = 4000;
/** Max lines from agent log tail. */
const LOG_TAIL_LINES = 50;

const ARTIFACT_NAMES = [
  { file: "ISSUE.md", key: "issue" },
  { file: "PLAN.md", key: "plan" },
  { file: "PLANREVIEW.md", key: "planReview" },
  { file: "REVIEW_FINDINGS.md", key: "reviewFindings" },
];

/**
 * Collect all available context for RCA regardless of which stage failed.
 * Reads artifacts, agent logs, git state — all best-effort (missing files skipped).
 *
 * @param {string} workspaceDir
 * @param {{ id: string, title?: string }} issue
 * @param {object} loopState
 * @param {number} issueIndex
 * @returns {object}
 */
export function gatherFailureContext(
  workspaceDir,
  _issue,
  loopState,
  issueIndex,
) {
  const entry = loopState.issueQueue?.[issueIndex] ?? {};
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");

  // Read whatever artifacts exist
  const artifacts = {};
  for (const { file, key } of ARTIFACT_NAMES) {
    const p = path.join(artifactsDir, file);
    try {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf8");
        artifacts[key] = content.slice(0, ARTIFACT_TRUNCATE);
      } else {
        artifacts[key] = null;
      }
    } catch {
      artifacts[key] = null;
    }
  }

  // Agent log tail (best-effort)
  let agentLogTail = "";
  const activeAgent = loopState.activeAgent || entry.activeAgent;
  if (activeAgent) {
    try {
      const logPath = path.join(logsDir(workspaceDir), `${activeAgent}.jsonl`);
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, "utf8").split("\n");
        agentLogTail = lines.slice(-LOG_TAIL_LINES).join("\n");
      }
    } catch {
      /* best-effort */
    }
  }

  // Git state (best-effort)
  let gitLog = "";
  let gitDiffStat = "";
  try {
    const logRes = spawnSync("git", ["log", "--oneline", "-20"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 5000,
    });
    if (logRes.status === 0) gitLog = (logRes.stdout || "").trim();
  } catch {
    /* best-effort */
  }
  try {
    const diffRes = spawnSync("git", ["diff", "--stat"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 5000,
    });
    if (diffRes.status === 0) gitDiffStat = (diffRes.stdout || "").trim();
  } catch {
    /* best-effort */
  }

  return {
    error: entry.error || "",
    stage: loopState.currentStage || null,
    deferredReason: entry.deferredReason || null,
    artifacts,
    agentLogTail,
    gitLog,
    gitDiffStat,
    branch: entry.branch || null,
  };
}

/**
 * Build the RCA agent prompt from gathered context.
 * @param {{ id: string, title?: string }} issue
 * @param {object} failureContext
 * @returns {string}
 */
function buildRcaPrompt(issue, failureContext) {
  const sections = [];
  sections.push(
    `You are analyzing a workflow failure for issue "${issue.title || issue.id}" (${issue.id}).`,
  );

  sections.push(`\n## Error\n${failureContext.error || "(no error captured)"}`);

  if (failureContext.stage) {
    sections.push(`\n## Failed Stage\n${failureContext.stage}`);
  }
  if (failureContext.deferredReason) {
    sections.push(`\n## Deferred Reason\n${failureContext.deferredReason}`);
  }

  for (const { file, key } of ARTIFACT_NAMES) {
    if (failureContext.artifacts[key]) {
      sections.push(`\n## ${file}\n${failureContext.artifacts[key]}`);
    }
  }

  if (failureContext.agentLogTail) {
    sections.push(
      `\n## Agent Log Tail (last ${LOG_TAIL_LINES} lines)\n\`\`\`\n${failureContext.agentLogTail}\n\`\`\``,
    );
  }

  if (failureContext.gitLog) {
    sections.push(
      `\n## Recent Git Log\n\`\`\`\n${failureContext.gitLog}\n\`\`\``,
    );
  }

  sections.push(`
Perform a root cause analysis. Structure your response as:

### Root Cause
What went wrong and why.

### Contributing Factors
Secondary issues that made the failure more likely.

### Suggested Fix
Concrete steps to resolve this, including code changes if applicable.

### Prevention
How to prevent similar failures in the future.`);

  return sections.join("\n");
}

/**
 * Build the GitHub issue body from context and RCA analysis.
 */
function buildIssueBody(issue, failureContext, rcaAnalysis, loopRunId) {
  const lines = [];
  lines.push("## Failure Summary\n");
  lines.push(`- **Issue:** ${issue.title || issue.id} (${issue.id})`);
  lines.push(`- **Stage:** ${failureContext.stage || "unknown"}`);
  lines.push(`- **Branch:** ${failureContext.branch || "n/a"}`);
  lines.push(`- **Error:** ${(failureContext.error || "").slice(0, 500)}`);
  if (failureContext.deferredReason) {
    lines.push(`- **Deferred Reason:** ${failureContext.deferredReason}`);
  }

  lines.push("\n## Root Cause Analysis\n");
  lines.push(rcaAnalysis);

  lines.push("\n## Context\n");

  // Artifacts
  lines.push("<details><summary>Artifacts at time of failure</summary>\n");
  for (const { file, key } of ARTIFACT_NAMES) {
    const content = failureContext.artifacts[key];
    lines.push(`### ${file}`);
    lines.push(content ? content.slice(0, 2000) : "_not yet created_");
    lines.push("");
  }
  lines.push("</details>\n");

  // Agent log
  if (failureContext.agentLogTail) {
    lines.push("<details><summary>Agent log tail</summary>\n");
    lines.push("```");
    lines.push(failureContext.agentLogTail.slice(0, 3000));
    lines.push("```\n");
    lines.push("</details>\n");
  }

  // Git state
  if (failureContext.gitLog || failureContext.gitDiffStat) {
    lines.push("<details><summary>Git state</summary>\n");
    lines.push("```");
    if (failureContext.gitLog) lines.push(failureContext.gitLog);
    if (failureContext.gitDiffStat) {
      lines.push("\n--- diff stat ---");
      lines.push(failureContext.gitDiffStat);
    }
    lines.push("```\n");
    lines.push("</details>\n");
  }

  lines.push("---");
  lines.push(
    `*Filed automatically by coder failure monitor (run ${loopRunId})*`,
  );

  return lines.join("\n");
}

/**
 * File an RCA issue via gh CLI.
 *
 * @param {{ repoRoot: string, title: string, body: string, labels: string[] }} opts
 * @returns {{ issueUrl: string }}
 */
export function fileRcaIssue({ repoRoot, title, body, labels }) {
  const args = ["issue", "create", "--title", title, "--body", body];
  if (labels.length > 0) {
    args.push("--label", labels.join(","));
  }
  const res = spawnSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`gh issue create failed: ${res.stderr || res.stdout}`);
  }
  const raw = (res.stdout || "").trim();
  const lines = raw.split("\n").filter((l) => l.trim());
  const issueUrl = lines.find((l) => l.startsWith("http")) || lines.pop() || "";
  if (!issueUrl || !issueUrl.startsWith("http")) {
    throw new Error(
      `gh issue create did not return an issue URL. Output:\n${raw || "(empty)"}`,
    );
  }
  return { issueUrl };
}

/**
 * Check for existing open RCA issue for this issue ID.
 * @returns {boolean} true if a duplicate exists
 */
function hasDuplicateRcaIssue(repoRoot, issueId) {
  try {
    const res = spawnSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--search",
        `[coder-rca] ${issueId}`,
        "--json",
        "url",
        "--limit",
        "1",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
    );
    if (res.status !== 0) return false;
    const parsed = JSON.parse(res.stdout || "[]");
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Launch non-blocking RCA for a failed issue. Best-effort — never throws.
 *
 * @param {{
 *   issue: { source?: string, id: string, title?: string },
 *   error: string,
 *   loopRunId: string,
 *   loopState: object,
 *   issueIndex: number,
 *   deferredReason?: string,
 * }} failureCtx
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 * @returns {Promise<{ issueUrl: string|null, skipped: boolean, error?: string }>}
 */
export async function runFailureRca(failureCtx, ctx) {
  try {
    const monitorConfig = ctx.config?.workflow?.failureMonitor;
    if (!monitorConfig?.enabled) {
      return { issueUrl: null, skipped: true };
    }
    if (ctx.cancelToken?.cancelled) {
      return { issueUrl: null, skipped: true };
    }

    const { issue, loopRunId, loopState, issueIndex } = failureCtx;
    const repoRoot = ctx.workspaceDir;

    // Dedup check
    if (hasDuplicateRcaIssue(repoRoot, issue.id)) {
      ctx.log({
        event: "failure_monitor_dedup",
        issueId: issue.id,
      });
      return { issueUrl: null, skipped: true };
    }

    // Gather context
    const failureContext = gatherFailureContext(
      ctx.workspaceDir,
      issue,
      loopState,
      issueIndex,
    );

    // Get agent and run RCA
    const { agent, agentName } = ctx.agentPool.getAgent("failureMonitor", {
      scope: "repo",
    });
    ctx.log({
      event: "failure_monitor_rca_start",
      issueId: issue.id,
      agent: agentName,
      stage: failureContext.stage,
    });

    const prompt = buildRcaPrompt(issue, failureContext);
    const rcaResult = await agent.executeWithRetry(prompt, {
      retries: 1,
      timeoutMs: monitorConfig.timeoutMs || 300_000,
    });

    const rcaAnalysis =
      rcaResult.exitCode === 0
        ? (rcaResult.stdout || "").trim() || "(empty agent response)"
        : `(agent failed with exit code ${rcaResult.exitCode})\n${(rcaResult.stderr || "").slice(0, 1000)}`;

    // Cancel check before filing
    if (ctx.cancelToken?.cancelled) {
      return { issueUrl: null, skipped: true };
    }

    // Build and file the issue
    const title = `[coder-rca] ${issue.title || issue.id} (${issue.id})`;
    const body = buildIssueBody(issue, failureContext, rcaAnalysis, loopRunId);
    const labels = monitorConfig.labels || ["coder-rca", "automated"];

    const { issueUrl } = fileRcaIssue({ repoRoot, title, body, labels });

    ctx.log({
      event: "failure_monitor_rca_filed",
      issueId: issue.id,
      rcaIssueUrl: issueUrl,
    });

    // Update loop state with RCA URL
    if (loopState.issueQueue?.[issueIndex]) {
      loopState.issueQueue[issueIndex].rcaIssueUrl = issueUrl;
      try {
        await saveLoopState(ctx.workspaceDir, loopState, {
          guardRunId: loopState.runId,
        });
      } catch {
        /* best-effort — don't fail RCA because of state save */
      }
    }

    // Fire hook
    runHooks(ctx, loopRunId, "rca_filed", "", {
      issueUrl,
      originalIssueId: issue.id,
      originalIssueTitle: issue.title || "",
    });

    return { issueUrl, skipped: false };
  } catch (err) {
    ctx.log({
      event: "failure_monitor_error",
      issueId: failureCtx.issue?.id,
      error: err.message || String(err),
    });
    return {
      issueUrl: null,
      skipped: false,
      error: err.message || String(err),
    };
  }
}
