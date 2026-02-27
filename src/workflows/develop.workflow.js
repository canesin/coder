import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildDependencyGraph } from "../github/dependencies.js";
import { detectDefaultBranch } from "../helpers.js";
import { registerMachine } from "../machines/_registry.js";
import {
  artifactPaths,
  normalizeRepoPath,
  resolveRepoRoot,
} from "../machines/develop/_shared.js";
import implementationMachine from "../machines/develop/implementation.machine.js";
import issueDraftMachine from "../machines/develop/issue-draft.machine.js";
import issueListMachine from "../machines/develop/issue-list.machine.js";
import planReviewMachine from "../machines/develop/plan-review.machine.js";
import planningMachine from "../machines/develop/planning.machine.js";
import prCreationMachine from "../machines/develop/pr-creation.machine.js";
import qualityReviewMachine from "../machines/develop/quality-review.machine.js";
import {
  loadLoopState,
  loadState,
  saveLoopState,
  saveState,
  statePathFor,
} from "../state/workflow-state.js";
import { buildIssueBranchName } from "../worktrees.js";
import { runHooks, WorkflowRunner } from "./_base.js";

/**
 * Update the loop state heartbeat timestamp.
 */
function updateHeartbeat(ctx) {
  try {
    const ls = loadLoopState(ctx.workspaceDir);
    ls.lastHeartbeatAt = new Date().toISOString();
    saveLoopState(ctx.workspaceDir, ls, { guardRunId: ls.runId });
  } catch {
    // Best-effort — don't fail the pipeline over a heartbeat update
  }
}

// Re-export machines for direct use
export {
  issueListMachine,
  issueDraftMachine,
  planningMachine,
  planReviewMachine,
  implementationMachine,
  qualityReviewMachine,
  prCreationMachine,
};

export const developMachines = [
  issueListMachine,
  issueDraftMachine,
  planningMachine,
  planReviewMachine,
  implementationMachine,
  qualityReviewMachine,
  prCreationMachine,
];

/**
 * Register all develop machines in the global registry.
 */
export function registerDevelopMachines() {
  for (const m of developMachines) {
    registerMachine(m);
  }
}

/**
 * Run the planning + plan-review loop (up to maxRounds) using an existing WorkflowRunner.
 * Between revision rounds, stale PLAN.md and PLANREVIEW.md are deleted so agents cannot
 * silently reuse old artifacts via file-existence fallback paths.
 *
 * @param {import("./_base.js").WorkflowRunner} runner
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 * @param {{ planningMachine: object, planReviewMachine: object, maxRounds?: number }} opts
 */
export async function runPlanLoop(
  runner,
  ctx,
  { planningMachine: pm, planReviewMachine: prm, maxRounds } = {},
) {
  maxRounds = maxRounds ?? ctx.config?.workflow?.maxPlanRevisions ?? 3;
  const allResults = [];
  let priorCritique = "";

  for (let round = 0; round < maxRounds; round++) {
    if (round > 0) {
      const paths = artifactPaths(ctx.artifactsDir);
      rmSync(paths.plan, { force: true });
      rmSync(paths.critique, { force: true });
    }

    const planRound = await runner.run(
      [{ machine: pm, inputMapper: () => ({ priorCritique }) }],
      {},
    );
    allResults.push(...planRound.results);
    if (planRound.status !== "completed") {
      return {
        status: planRound.status,
        error: planRound.error,
        results: allResults,
      };
    }

    const reviewRound = await runner.run(
      [{ machine: prm, inputMapper: () => ({ round }) }],
      {},
    );
    allResults.push(...reviewRound.results);
    if (reviewRound.status !== "completed") {
      return {
        status: reviewRound.status,
        error: reviewRound.error,
        results: allResults,
      };
    }

    const verdict = reviewRound.results[0]?.data?.verdict;
    ctx.log({ event: "plan_review_verdict", verdict, round, maxRounds });

    const needsRevision = verdict === "REVISE" || verdict === "REJECT";
    if (!needsRevision || round === maxRounds - 1) {
      if (needsRevision && round === maxRounds - 1) {
        ctx.log({
          event: "plan_review_exhausted",
          lastVerdict: verdict,
          roundsUsed: round + 1,
          maxRounds,
        });
      }
      break;
    }

    priorCritique = reviewRound.results[0]?.data?.critiqueMd || "";
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};
    state.steps.wroteCritique = false;
    saveState(ctx.workspaceDir, state);
  }

  return { status: "completed", results: allResults };
}

/**
 * Run a function with retries suitable for machine execution.
 * Checks for "failed" status in the result.
 */
export async function runWithMachineRetry(
  fn,
  { maxRetries, backoffMs = 5000, ctx },
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      ctx.log({ event: "machine_retry_attempt", attempt, maxRetries });
      if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs));
    }
    const result = await fn();
    if (result.status !== "failed") return result;
    ctx.log({
      event: "machine_retry_failed",
      attempt,
      maxRetries,
      error: result.error,
    });
    if (attempt === maxRetries) return result;
  }
}

/**
 * Run the full develop pipeline for a single issue.
 *
 * @param {{
 *   issue: { source: string, id: string, title: string },
 *   repoPath: string,
 *   clarifications?: string,
 *   baseBranch?: string,
 *   testCmd?: string,
 *   testConfigPath?: string,
 *   allowNoTests?: boolean,
 *   ppcommitPreset?: string,
 *   prType?: string,
 *   prSemanticName?: string,
 *   prTitle?: string,
 *   prDescription?: string,
 *   prBase?: string,
 *   force?: boolean,
 * }} opts
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 */
export async function runDevelopPipeline(opts, ctx) {
  const start = Date.now();
  const allResults = [];

  const runner = new WorkflowRunner({
    name: "develop",
    workflowContext: ctx,
    onStageChange: (stage) => {
      ctx.log({ event: "develop_stage", stage });
    },
  });

  // Phase 1: issue draft
  const phase1 = await runner.run(
    [
      {
        machine: issueDraftMachine,
        inputMapper: () => ({
          issue: opts.issue,
          repoPath: opts.repoPath,
          clarifications: opts.clarifications || "",
          baseBranch: opts.baseBranch,
          force: opts.force ?? false,
        }),
      },
    ],
    {},
  );
  allResults.push(...phase1.results);
  if (phase1.status !== "completed") {
    return { ...phase1, results: allResults, durationMs: Date.now() - start };
  }

  // Heartbeat after phase 1 (issue draft)
  updateHeartbeat(ctx);

  if (ctx.cancelToken.cancelled) {
    return {
      status: "cancelled",
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Phase 2: planning + review loop
  const loopResult = await runPlanLoop(runner, ctx, {
    planningMachine,
    planReviewMachine,
  });
  allResults.push(...loopResult.results);
  if (loopResult.status !== "completed") {
    return {
      status: loopResult.status,
      error: loopResult.error,
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Heartbeat after phase 2 (planning + review)
  updateHeartbeat(ctx);

  if (ctx.cancelToken.cancelled) {
    return {
      status: "cancelled",
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Phase 3: implementation → quality-review → PR creation
  const maxMachineRetries = ctx.config?.workflow?.maxMachineRetries ?? 3;
  const phase3 = await runWithMachineRetry(
    () =>
      runner.run(
        [
          {
            machine: implementationMachine,
            inputMapper: () => ({}),
          },
          {
            machine: qualityReviewMachine,
            inputMapper: () => ({
              testCmd: opts.testCmd || "",
              testConfigPath: opts.testConfigPath || "",
              allowNoTests: opts.allowNoTests ?? false,
              ppcommitPreset: opts.ppcommitPreset || "strict",
            }),
          },
          {
            machine: prCreationMachine,
            inputMapper: () => ({
              type: opts.prType || "feat",
              semanticName: opts.prSemanticName || "",
              title: opts.prTitle || "",
              description: opts.prDescription || "",
              base: opts.prBase || "",
            }),
          },
        ],
        {},
      ),
    { maxRetries: maxMachineRetries, backoffMs: 5000, ctx },
  );
  allResults.push(...phase3.results);

  // Heartbeat after phase 3 (implementation + review + PR)
  updateHeartbeat(ctx);

  return { ...phase3, results: allResults, durationMs: Date.now() - start };
}

/**
 * Build a dependency-aware issue queue with topological sort and difficulty tie-breaking.
 *
 * @param {Array<{ id: string, difficulty?: number, depends_on?: string[], dependsOn?: string[] }>} issues
 * @returns {{ queue: typeof issues, rationale: { method: string, cycles: string[][], depEdges: number } }}
 */
function buildIssueQueue(issues) {
  // Normalize depends_on (support both field names)
  const normalized = issues.map((iss) => ({
    ...iss,
    dependsOn: iss.depends_on || iss.dependsOn || [],
  }));

  const hasDeps = normalized.some((iss) => iss.dependsOn.length > 0);
  if (!hasDeps) {
    // No dependencies — sort by difficulty (ascending), stable for ties
    const sorted = [...normalized].sort(
      (a, b) => (a.difficulty || 3) - (b.difficulty || 3),
    );
    return {
      queue: sorted,
      rationale: { method: "difficulty_sort", cycles: [], depEdges: 0 },
    };
  }

  // Topological sort respecting dependencies
  const { sorted: sortedIds, cycles } = buildDependencyGraph(normalized);
  const byId = new Map(normalized.map((iss) => [iss.id, iss]));

  // Apply difficulty tie-break within each dependency tier
  const inDegreeMap = new Map();
  for (const iss of normalized) {
    const internalDeps = iss.dependsOn.filter((d) => byId.has(d));
    inDegreeMap.set(iss.id, internalDeps.length);
  }

  // Group by tier (same in-degree level in the topological order)
  const queue = sortedIds.map((id) => byId.get(id)).filter(Boolean);

  const depEdges = normalized.reduce(
    (sum, iss) => sum + iss.dependsOn.filter((d) => byId.has(d)).length,
    0,
  );

  return {
    queue,
    rationale: {
      method: "topological_sort",
      cycles,
      depEdges,
    },
  };
}

/**
 * Resolve the base branch for an issue from its completed dependencies.
 *
 * @param {Array<{ id: string, dependsOn?: string[] }>} issue
 * @param {Map<string, { status: string, branch?: string }>} outcomeMap
 * @returns {{ baseBranch: string | null, allDepsFailed: boolean, depOutcomes: object }}
 */
function resolveDependencyBranch(issue, outcomeMap) {
  const deps = issue.dependsOn || issue.depends_on || [];
  if (deps.length === 0) {
    return { baseBranch: null, allDepsFailed: false, depOutcomes: {} };
  }

  const outcomes = {};
  let _successCount = 0;
  let failCount = 0;
  let baseBranch = null;

  for (const depId of deps) {
    const outcome = outcomeMap.get(depId);
    if (!outcome) {
      outcomes[depId] = "pending";
      continue;
    }
    outcomes[depId] = outcome.status;
    if (outcome.status === "completed" && outcome.branch) {
      _successCount++;
      // Use the first successful dependency branch as base
      if (!baseBranch) baseBranch = outcome.branch;
    } else if (outcome.status === "failed" || outcome.status === "skipped") {
      failCount++;
    }
  }

  const knownDeps = deps.filter((d) => outcomeMap.has(d));
  const allDepsFailed = knownDeps.length > 0 && failCount === knownDeps.length;

  return { baseBranch, allDepsFailed, depOutcomes: outcomes };
}

const isRateLimitError = (text) =>
  /rate limit|429|resource_exhausted|quota/i.test(String(text || ""));

/**
 * Run the autonomous develop loop — process multiple issues.
 */
export async function runDevelopLoop(opts, ctx) {
  const {
    goal = "resolve all assigned issues",
    projectFilter,
    maxIssues = 10,
    destructiveReset = false,
    testCmd,
    testConfigPath,
    allowNoTests = false,
    issueSource = "",
    localIssuesDir = "",
    ppcommitPreset = "",
    issueIds = [],
  } = opts;

  // List issues (local or remote)
  const listResult = await issueListMachine.run(
    {
      projectFilter,
      issueSource: issueSource || undefined,
      localIssuesDir,
      issueIds: issueIds.length > 0 ? issueIds : undefined,
    },
    ctx,
  );
  if (listResult.status !== "ok") {
    return {
      status: "failed",
      error: listResult.error || "Issue listing failed",
      results: [],
    };
  }

  const rawIssues = listResult.data.issues.slice(0, maxIssues);
  if (rawIssues.length === 0) {
    return {
      status: "completed",
      results: [],
      completed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  // Build dependency-aware queue
  const { queue: issues, rationale } = buildIssueQueue(rawIssues);

  ctx.log({
    event: "queue_built",
    method: rationale.method,
    depEdges: rationale.depEdges,
    cycles: rationale.cycles.length,
    count: issues.length,
    order: issues.map((i) => i.id),
    source: listResult.data.source || "remote",
  });

  // Initialize loop state
  const loopState = loadLoopState(ctx.workspaceDir);
  loopState.status = "running";
  loopState.issueQueue = issues.map((iss) => ({
    ...iss,
    dependsOn: iss.dependsOn || iss.depends_on || [],
    status: "pending",
    branch: null,
    prUrl: null,
    error: null,
    baseBranch: null,
  }));
  loopState.currentIndex = 0;
  loopState.startedAt = new Date().toISOString();
  const prevLoopRunId = loopState.runId;
  loopState.runId = ctx.runId || loopState.runId;
  saveLoopState(ctx.workspaceDir, loopState, { guardRunId: prevLoopRunId });

  const loopRunId = randomUUID().slice(0, 8);
  runHooks(ctx, loopRunId, "loop_start", "", {
    status: "running",
    total: issues.length,
    method: rationale.method,
  });

  /** @type {Map<string, { status: string, branch?: string }>} */
  const outcomeMap = new Map();
  const results = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  // Helper: process a single issue
  async function processIssue(issue, i, { isRetry = false } = {}) {
    loopState.currentIndex = i;
    loopState.currentStage = isRetry ? "retry" : "processing";
    loopState.lastHeartbeatAt = new Date().toISOString();
    loopState.issueQueue[i].status = "in_progress";
    loopState.issueQueue[i].branch = buildIssueBranchName(issue);
    loopState.issueQueue[i].startedAt = new Date().toISOString();
    saveLoopState(ctx.workspaceDir, loopState, { guardRunId: loopState.runId });

    const issueEnv = {
      CODER_HOOK_ISSUE_ID: String(issue.id || ""),
      CODER_HOOK_ISSUE_TITLE: String(issue.title || ""),
    };
    runHooks(ctx, loopRunId, "issue_start", "", {}, issueEnv);

    const { baseBranch, allDepsFailed, depOutcomes } = resolveDependencyBranch(
      issue,
      outcomeMap,
    );

    if (allDepsFailed) {
      ctx.log({
        event: "issue_skipped",
        issueId: issue.id,
        reason: "all_dependencies_failed",
        depOutcomes,
      });
      loopState.issueQueue[i].status = "skipped";
      loopState.issueQueue[i].error = "All dependencies failed";
      outcomeMap.set(issue.id, { status: "skipped" });
      skipped++;
      results.push({
        ...issue,
        status: "skipped",
        error: "All dependencies failed",
      });
      saveLoopState(ctx.workspaceDir, loopState, {
        guardRunId: loopState.runId,
      });
      runHooks(
        ctx,
        loopRunId,
        "issue_skipped",
        "",
        { status: "skipped", reason: "all_dependencies_failed" },
        issueEnv,
      );
      return "skipped";
    }

    // Defer if any dependency hasn't been processed yet (first pass only)
    const hasUnresolvedDeps = Object.values(depOutcomes).some(
      (s) => s === "pending",
    );
    if (hasUnresolvedDeps && !isRetry) {
      ctx.log({ event: "issue_deferred", issueId: issue.id, depOutcomes });
      loopState.issueQueue[i].status = "deferred";
      saveLoopState(ctx.workspaceDir, loopState, {
        guardRunId: loopState.runId,
      });
      runHooks(
        ctx,
        loopRunId,
        "issue_deferred",
        "",
        { status: "deferred" },
        issueEnv,
      );
      return "deferred";
    }

    if (baseBranch) {
      ctx.log({
        event: "dependency_branch_resolved",
        issueId: issue.id,
        baseBranch,
        depOutcomes,
      });
      loopState.issueQueue[i].baseBranch = baseBranch;
    }

    const repoPath = normalizeRepoPath(ctx.workspaceDir, issue.repo_path);

    try {
      const pipelineResult = await runDevelopPipeline(
        {
          issue,
          repoPath,
          clarifications: `Autonomous mode. Goal: ${goal}`,
          baseBranch: baseBranch || undefined,
          prBase: baseBranch || "",
          testCmd,
          testConfigPath,
          allowNoTests,
          ppcommitPreset,
          force: true,
        },
        ctx,
      );

      if (pipelineResult.status === "completed") {
        const prResult =
          pipelineResult.results[pipelineResult.results.length - 1];
        const branch = prResult?.data?.branch;
        loopState.issueQueue[i].status = "completed";
        loopState.issueQueue[i].branch = branch;
        loopState.issueQueue[i].prUrl = prResult?.data?.prUrl;
        outcomeMap.set(issue.id, { status: "completed", branch });
        completed++;
        results.push({
          ...issue,
          status: "completed",
          prUrl: prResult?.data?.prUrl,
          branch,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_complete",
          "",
          { status: "completed", prUrl: prResult?.data?.prUrl, branch },
          issueEnv,
        );
      } else {
        const errText = pipelineResult.error || "";
        if (isRateLimitError(errText) && !isRetry) {
          ctx.log({ event: "issue_rate_limited", issueId: issue.id });
          loopState.issueQueue[i].status = "deferred";
          loopState.issueQueue[i].error = errText;
          saveLoopState(ctx.workspaceDir, loopState, {
            guardRunId: loopState.runId,
          });
          runHooks(
            ctx,
            loopRunId,
            "issue_deferred",
            "",
            { status: "deferred" },
            issueEnv,
          );
          return "deferred";
        }
        loopState.issueQueue[i].status = "failed";
        loopState.issueQueue[i].error = errText;
        outcomeMap.set(issue.id, { status: "failed" });
        failed++;
        results.push({
          ...issue,
          status: "failed",
          error: errText,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_failed",
          "",
          { status: "failed", error: errText },
          issueEnv,
        );
      }
    } catch (err) {
      if (isRateLimitError(err.message) && !isRetry) {
        ctx.log({ event: "issue_rate_limited", issueId: issue.id });
        loopState.issueQueue[i].status = "deferred";
        loopState.issueQueue[i].error = err.message;
        saveLoopState(ctx.workspaceDir, loopState, {
          guardRunId: loopState.runId,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_deferred",
          "",
          { status: "deferred" },
          issueEnv,
        );
        return "deferred";
      }
      loopState.issueQueue[i].status = "failed";
      loopState.issueQueue[i].error = err.message;
      outcomeMap.set(issue.id, { status: "failed" });
      failed++;
      results.push({ ...issue, status: "failed", error: err.message });
      runHooks(
        ctx,
        loopRunId,
        "issue_failed",
        "",
        { status: "failed", error: err.message },
        issueEnv,
      );
    }

    saveLoopState(ctx.workspaceDir, loopState, { guardRunId: loopState.runId });

    // Reset between issues
    const issueStatus = loopState.issueQueue[i].status;
    await resetForNextIssue(ctx.workspaceDir, repoPath, {
      destructiveReset,
      issueStatus,
    });
    return issueStatus;
  }

  // Main pass
  for (let i = 0; i < issues.length; i++) {
    if (ctx.cancelToken.cancelled) break;
    await processIssue(issues[i], i);
  }

  // Retry pass for deferred issues whose dependencies are now resolved
  const deferredIndices = issues
    .map((_, i) => i)
    .filter((i) => loopState.issueQueue[i].status === "deferred");

  if (deferredIndices.length > 0 && !ctx.cancelToken.cancelled) {
    ctx.log({
      event: "deferred_retry_pass",
      count: deferredIndices.length,
      ids: deferredIndices.map((i) => issues[i].id),
    });

    for (const i of deferredIndices) {
      if (ctx.cancelToken.cancelled) break;
      await processIssue(issues[i], i, { isRetry: true });
    }
  }

  // Coalesce pass: summary and cleanup
  const stillDeferred = loopState.issueQueue.filter(
    (q) => q.status === "deferred",
  ).length;
  ctx.log({
    event: "loop_summary",
    total: issues.length,
    completed,
    failed,
    skipped,
    deferred: stillDeferred,
  });

  const coalesceRepoRoot = resolveRepoRoot(ctx.workspaceDir, ".");
  const defaultBranch = detectDefaultBranch(coalesceRepoRoot);

  // Smart branch cleanup: only delete branches with no commits beyond default
  const failedOrSkipped = loopState.issueQueue.filter(
    (q) => q.status === "failed" || q.status === "skipped",
  );
  if (failedOrSkipped.length > 0) {
    const deleted = [];
    const kept = [];
    for (const q of failedOrSkipped) {
      const branch = q.branch || buildIssueBranchName(q);
      const verify = spawnSync("git", ["rev-parse", "--verify", branch], {
        cwd: coalesceRepoRoot,
        encoding: "utf8",
      });
      if (verify.status !== 0) continue; // branch never created

      const log = spawnSync(
        "git",
        ["log", `${defaultBranch}..${branch}`, "--oneline"],
        { cwd: coalesceRepoRoot, encoding: "utf8" },
      );
      const hasCommits = (log.stdout || "").trim().length > 0;

      if (hasCommits) {
        kept.push(branch);
      } else {
        spawnSync("git", ["branch", "-D", branch], {
          cwd: coalesceRepoRoot,
          encoding: "utf8",
        });
        deleted.push(branch);
      }
    }
    ctx.log({ event: "smart_branch_cleanup", deleted, kept });
  }

  // Agent-driven coalesce analysis for cross-branch integration review
  const completedBranches = loopState.issueQueue.filter(
    (q) => q.status === "completed" && q.branch,
  );
  if (completedBranches.length >= 2 && !ctx.cancelToken.cancelled) {
    try {
      ctx.log({
        event: "coalesce_analysis_start",
        branches: completedBranches.map((q) => q.branch),
      });

      const branchDiffs = [];
      for (const q of completedBranches) {
        const stat = spawnSync(
          "git",
          ["diff", `${defaultBranch}...${q.branch}`, "--stat"],
          { cwd: coalesceRepoRoot, encoding: "utf8" },
        );
        const diff = spawnSync(
          "git",
          ["diff", `${defaultBranch}...${q.branch}`],
          { cwd: coalesceRepoRoot, encoding: "utf8" },
        );
        branchDiffs.push({
          branch: q.branch,
          issueId: q.id,
          title: q.title,
          stat: (stat.stdout || "").trim(),
          diff: (diff.stdout || "").slice(0, 8000),
        });
      }

      const diffSections = branchDiffs
        .map(
          (d) =>
            `## Branch: ${d.branch} (Issue ${d.issueId}: ${d.title})\n\n### File Stats\n\`\`\`\n${d.stat}\n\`\`\`\n\n### Diff (truncated)\n\`\`\`diff\n${d.diff}\n\`\`\``,
        )
        .join("\n\n---\n\n");

      const prompt = `You are reviewing the combined changeset from ${completedBranches.length} feature branches that were implemented in parallel against the same base branch (${defaultBranch}).

Your task is to analyze the branches for integration issues and produce a structured report.

${diffSections}

Analyze and produce a markdown report with these sections:
1. **Overlapping File Changes** — files modified by multiple branches, with risk assessment
2. **Duplicate Code / Helpers** — similar functions, utilities, or patterns introduced independently
3. **Potential Merge Conflicts** — specific regions likely to conflict when merging
4. **Cross-Cutting Concerns** — shared changes (config, types, deps) that need coordination
5. **Simplification Opportunities** — code that could be consolidated after merging
6. **Recommended Merge Order** — optimal sequence to minimize conflict resolution effort

Be concrete: reference file paths, line ranges, and function names. If no issues exist for a section, say "None detected."`;

      const { agent } = ctx.agentPool.getAgent("coalesce", {
        scope: "repo",
      });
      const res = await agent.execute(prompt, {
        timeoutMs: 1000 * 60 * 15,
      });

      const artifactsDir = path.join(ctx.workspaceDir, ".coder", "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(
        path.join(artifactsDir, "COALESCE.md"),
        res.stdout || res.output || String(res),
        "utf8",
      );

      ctx.log({
        event: "coalesce_analysis_complete",
        branches: completedBranches.length,
      });
    } catch (err) {
      ctx.log({
        event: "coalesce_analysis_error",
        error: err.message,
      });
    }
  }

  loopState.status = ctx.cancelToken.cancelled ? "cancelled" : "completed";
  loopState.completedAt = new Date().toISOString();
  saveLoopState(ctx.workspaceDir, loopState, { guardRunId: loopState.runId });

  runHooks(ctx, loopRunId, "loop_complete", "", {
    status: loopState.status,
    completed,
    failed,
    skipped,
    deferred: stillDeferred,
  });

  return {
    status: loopState.status,
    results,
    completed,
    failed,
    skipped,
    deferred: stillDeferred,
  };
}

/**
 * Reset workspace for next issue in autonomous loop.
 */
async function resetForNextIssue(
  workspaceDir,
  repoPath,
  { destructiveReset = false, issueStatus = "completed" } = {},
) {
  // Delete per-issue state
  const statePath = statePathFor(workspaceDir);
  if (existsSync(statePath)) rmSync(statePath, { force: true });

  // Delete workflow artifacts
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  for (const name of [
    "ISSUE.md",
    "PLAN.md",
    "PLANREVIEW.md",
    "REVIEW_FINDINGS.md",
  ]) {
    const p = path.join(artifactsDir, name);
    if (existsSync(p)) rmSync(p, { force: true });
  }

  // Git cleanup
  const repoRoot = resolveRepoRoot(workspaceDir, repoPath);
  if (existsSync(repoRoot)) {
    // For failed/skipped issues, preserve partial work on the issue branch
    // before switching back to the default branch.
    const needsPreserve = issueStatus === "failed" || issueStatus === "skipped";

    if (needsPreserve) {
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if ((status.stdout || "").trim()) {
        // Commit partial work to the current (issue) branch so it's not lost
        spawnSync("git", ["add", "-A"], { cwd: repoRoot, encoding: "utf8" });
        spawnSync(
          "git",
          ["commit", "-m", `wip: partial work (issue ${issueStatus})`],
          { cwd: repoRoot, encoding: "utf8" },
        );
      }
    }

    const defaultBranch = detectDefaultBranch(repoRoot);
    spawnSync("git", ["checkout", defaultBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (destructiveReset) {
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if ((status.stdout || "").trim()) {
        spawnSync("git", ["restore", "--staged", "--worktree", "."], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        spawnSync("git", ["clean", "-fd"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
    }
  }
}
