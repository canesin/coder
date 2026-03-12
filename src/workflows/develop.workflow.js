import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import {
  buildDependencyGraph,
  getTransitiveDependents,
} from "../github/dependencies.js";
import { detectDefaultBranch, detectRemoteType } from "../helpers.js";
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
import { checkpointPathFor } from "../state/machine-state.js";
import { ScratchpadPersistence } from "../state/persistence.js";
import {
  loadLoopState,
  loadState,
  loadStateFromPath,
  saveLoopState,
  saveState,
  statePathFor,
} from "../state/workflow-state.js";
import { buildIssueBranchName } from "../worktrees.js";
import { runHooks, WorkflowRunner } from "./_base.js";

/**
 * Update the loop state heartbeat timestamp.
 */
async function updateHeartbeat(ctx) {
  try {
    const ls = await loadLoopState(ctx.workspaceDir);
    ls.lastHeartbeatAt = new Date().toISOString();
    await saveLoopState(ctx.workspaceDir, ls, { guardRunId: ls.runId });
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
// ensureCleanLoopStart and resetForNextIssue are exported at their definitions

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
 * @param {{ planningMachine: object, planReviewMachine: object, maxRounds?: number, activeBranches?: Array }} opts
 */
export async function runPlanLoop(
  runner,
  ctx,
  {
    planningMachine: pm,
    planReviewMachine: prm,
    maxRounds,
    activeBranches,
  } = {},
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
      [
        {
          machine: pm,
          inputMapper: () => ({
            priorCritique,
            activeBranches: activeBranches || [],
          }),
        },
      ],
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

    if (verdict === "UNKNOWN") {
      ctx.log({ event: "plan_review_unparseable", round });
    }
    const needsRevision =
      verdict === "REVISE" || verdict === "REJECT" || verdict === "UNKNOWN";
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
    const state = await loadState(ctx.workspaceDir);
    state.steps ||= {};
    state.steps.wroteCritique = false;
    await saveState(ctx.workspaceDir, state);
  }

  return { status: "completed", results: allResults };
}

/**
 * Run a function with retries suitable for machine execution.
 * Checks for "failed" status in the result. Respects cancellation between attempts.
 */
export async function runWithMachineRetry(
  fn,
  { maxRetries, backoffMs = 5000, ctx, onFailedAttempt },
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      if (ctx.cancelToken?.cancelled) {
        return { status: "cancelled", results: [] };
      }
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
    if (typeof onFailedAttempt === "function") {
      await onFailedAttempt({ attempt, maxRetries, result });
    }
    if (attempt === maxRetries) return result;
  }
}

function findFailedMachineResult(result) {
  const results = Array.isArray(result?.results) ? result.results : [];
  for (let i = results.length - 1; i >= 0; i--) {
    const step = results[i];
    if (step?.status === "error" || step?.status === "failed") return step;
  }
  return null;
}

async function injectRetryFeedback(ctx, failedMachine, error) {
  const message = String(error || "").trim();
  if (!message) return;
  const paths = artifactPaths(ctx.artifactsDir);
  const note =
    "\n\n---\n## Retry Feedback\n\n" +
    `**${failedMachine} failed — fix these issues before re-submitting:**\n\n` +
    `\`\`\`\n${message}\n\`\`\`\n`;
  await appendFile(paths.critique, note, "utf8");
  // Clear the implementation cache so the implementation machine re-runs on retry
  const state = await loadState(ctx.workspaceDir);
  if (state?.steps?.implemented) {
    state.steps.implemented = false;
    await saveState(ctx.workspaceDir, state);
  }
  ctx.log({ event: "retry_feedback_injected", machine: failedMachine });
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
 *   activeBranches?: Array<{ branch: string, issueId: string, title: string, diffStat: string }>,
 *   loopState?: object,
 *   issueIndex?: number,
 *   resumeFromRunId?: string,
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
  await updateHeartbeat(ctx);

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
    activeBranches: opts.activeBranches,
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
  await updateHeartbeat(ctx);

  if (ctx.cancelToken.cancelled) {
    return {
      status: "cancelled",
      results: allResults,
      runId: runner.runId,
      durationMs: Date.now() - start,
    };
  }

  // Check for conflicts with active branches detected during planning.
  // Skipped when conflict detection is disabled via config.
  if (ctx.config?.workflow?.conflictDetection !== false) {
    const planPath = artifactPaths(ctx.artifactsDir).plan;
    if (existsSync(planPath)) {
      const planMd = readFileSync(planPath, "utf8").replace(/\r\n/g, "\n");
      const conflictMatch = planMd.match(
        /## CONFLICT_DETECTED\n+[-*]\s*branch:\s*(.+)\n+[-*]\s*reason:\s*(.+)/,
      );
      if (conflictMatch) {
        return {
          status: "deferred",
          reason: "conflict",
          conflictBranch: conflictMatch[1].trim(),
          error: `Conflicts with active branch ${conflictMatch[1].trim()}: ${conflictMatch[2].trim()}`,
          results: allResults,
          runId: runner.runId,
          durationMs: Date.now() - start,
        };
      }
    }
  }

  // Phase 3: implementation → quality-review → PR creation
  const maxMachineRetries = ctx.config?.workflow?.maxMachineRetries ?? 2;
  const retryBackoffMs = ctx.config?.workflow?.retryBackoffMs ?? 5000;
  let lastPhase3RunId = null;
  let isFirstAttempt = true;
  const phase3Steps = [
    { machine: implementationMachine, inputMapper: () => ({}) },
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
  ];
  const phase3 = await runWithMachineRetry(
    async () => {
      const phase3Runner = new WorkflowRunner({
        name: "develop",
        workflowContext: ctx,
        onStageChange: (stage) => {
          ctx.log({ event: "develop_stage", stage });
        },
        onResumeSkipped:
          opts.loopState && opts.issueIndex != null
            ? async (runId) => {
                opts.loopState.issueQueue[opts.issueIndex].lastFailedRunId =
                  runId;
                await saveLoopState(ctx.workspaceDir, opts.loopState, {
                  guardRunId: opts.loopState.runId,
                });
              }
            : null,
        onCheckpoint: (_i, result, machineName) => {
          if (
            machineName === "develop.implementation" &&
            result?.status === "ok"
          ) {
            try {
              const statePath = statePathFor(ctx.workspaceDir);
              if (existsSync(statePath)) {
                const state = JSON.parse(readFileSync(statePath, "utf8"));
                saveBackup(ctx.workspaceDir, state);
              }
            } catch (err) {
              ctx.log({ event: "post_impl_backup_failed", error: err.message });
            }
          }
        },
      });
      const resumeId =
        opts.loopState?.issueQueue?.[opts.issueIndex]?.lastFailedRunId ??
        opts.resumeFromRunId;
      const runOpts =
        isFirstAttempt && resumeId ? { resumeFromRunId: resumeId } : {};
      // When resuming, persist the old runId so a process crash before onResumeSkipped
      // fires (or after) still points to the correct checkpoint. onResumeSkipped will
      // update to the new runId if the checkpoint turns out not to be usable.
      const runIdToPersist = runOpts.resumeFromRunId ?? phase3Runner.runId;
      if (opts.loopState && opts.issueIndex != null) {
        opts.loopState.issueQueue[opts.issueIndex].lastFailedRunId =
          runIdToPersist;
        await saveLoopState(ctx.workspaceDir, opts.loopState, {
          guardRunId: opts.loopState.runId,
        });
      }
      isFirstAttempt = false;
      const result = await phase3Runner.run(phase3Steps, {}, runOpts);
      lastPhase3RunId = phase3Runner.runId;
      if (
        result.status !== "completed" &&
        opts.loopState &&
        opts.issueIndex != null
      ) {
        opts.loopState.issueQueue[opts.issueIndex].lastFailedRunId =
          phase3Runner.runId;
        await saveLoopState(ctx.workspaceDir, opts.loopState, {
          guardRunId: opts.loopState.runId,
        });
      }
      return result;
    },
    {
      maxRetries: maxMachineRetries,
      backoffMs: retryBackoffMs,
      ctx,
      onFailedAttempt: async ({ result }) => {
        const failed = findFailedMachineResult(result);
        if (failed?.machine !== "develop.quality_review") return;
        await injectRetryFeedback(
          ctx,
          failed.machine,
          failed.error || result.error || "",
        );
        // Overwrite the onCheckpoint backup with implemented=false so a cross-process
        // restart after quality_review failure re-runs implementation, matching
        // same-process retry behavior.
        const state = await loadState(ctx.workspaceDir);
        if (state?.selected) saveBackup(ctx.workspaceDir, state);
        try {
          rmSync(checkpointPathFor(ctx.workspaceDir, result.runId), {
            force: true,
          });
        } catch {
          // Best-effort cleanup
        }
        if (opts.loopState && opts.issueIndex != null) {
          opts.loopState.issueQueue[opts.issueIndex].lastFailedRunId = null;
          await saveLoopState(ctx.workspaceDir, opts.loopState, {
            guardRunId: opts.loopState.runId,
          });
        }
      },
    },
  );
  if (phase3.status === "completed" && lastPhase3RunId) {
    try {
      rmSync(checkpointPathFor(ctx.workspaceDir, lastPhase3RunId), {
        force: true,
      });
    } catch {
      // Best-effort cleanup
    }
    if (opts.loopState && opts.issueIndex != null) {
      opts.loopState.issueQueue[opts.issueIndex].lastFailedRunId = null;
      await saveLoopState(ctx.workspaceDir, opts.loopState, {
        guardRunId: opts.loopState.runId,
      });
    }
  }
  allResults.push(...phase3.results);

  // Heartbeat after phase 3 (implementation + review + PR)
  await updateHeartbeat(ctx);

  return { ...phase3, results: allResults, durationMs: Date.now() - start };
}

/**
 * Build a dependency-aware issue queue with topological sort and difficulty tie-breaking.
 *
 * @param {Array<{ id: string, difficulty?: number, depends_on?: string[], dependsOn?: string[] }>} issues
 * @returns {{ queue: typeof issues, rationale: { method: string, cycles: string[][], depEdges: number } }}
 */
function buildIssueQueue(issues, { source } = {}) {
  // Normalize depends_on (support both field names)
  const normalized = issues.map((iss) => ({
    ...iss,
    dependsOn: iss.depends_on || iss.dependsOn || [],
  }));

  const hasDeps = normalized.some((iss) => iss.dependsOn.length > 0);
  if (!hasDeps) {
    // Forced order: preserve caller's sequence (no difficulty re-sort)
    if (source === "forced") {
      return {
        queue: normalized,
        rationale: { method: "forced_order", cycles: [], depEdges: 0 },
      };
    }
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

/** Unstage, restore tracked files, and remove untracked files. Returns true only if all steps succeeded. */
function discardWorktreeChanges(repoRoot) {
  const resetRes = spawnSync("git", ["reset"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (resetRes.status !== 0) return false;

  const diffRes = spawnSync("git", ["diff", "--name-only"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (diffRes.status !== 0) return false;
  const hasTrackedChanges = !!(diffRes.stdout || "").trim();
  if (hasTrackedChanges) {
    const coRes = spawnSync("git", ["checkout", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (coRes.status !== 0) return false;
  }

  const cleanRes = spawnSync("git", ["clean", "-fd", "--exclude=.coder/"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return cleanRes.status === 0;
}

// --- Step-level resume helpers ---
//
// Backup lifecycle:
// - Created: when switching away from an in-progress issue (wrotePlan=true)
// - Consumed: when resuming an issue (deleted after restore)
// - Pruned: at loop startup (orphans for issues no longer in queue)
// - Deleted: when an issue completes successfully, or on destructiveReset

/** @internal Exported for testing */
export function backupKeyFor(issue) {
  const source = issue.source ?? "unknown";
  const raw = (issue.repo_path ?? ".").trim() || ".";
  const repoPart =
    raw === "."
      ? "root"
      : createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return String(`${source}-${issue.id}-${repoPart}`).replace(
    /[/\\:*?"<>|]/g,
    "-",
  );
}

/** Verifies that artifact files exist for each step flag set. If a step flag is true
 * but the corresponding file is missing (e.g. manually deleted), returns false —
 * resume will not occur and we start fresh. */
function artifactConsistent(workspaceDir, steps, artifactsDirOverride) {
  const artifactsDir =
    artifactsDirOverride ?? path.join(workspaceDir, ".coder", "artifacts");
  if (steps?.wroteIssue && !existsSync(path.join(artifactsDir, "ISSUE.md")))
    return false;
  if (steps?.wrotePlan && !existsSync(path.join(artifactsDir, "PLAN.md")))
    return false;
  if (
    steps?.wroteCritique &&
    !existsSync(path.join(artifactsDir, "PLANREVIEW.md"))
  )
    return false;
  if (
    steps?.reviewerCompleted &&
    !existsSync(path.join(artifactsDir, "REVIEW_FINDINGS.md"))
  )
    return false;
  return true;
}

function clearStateAndArtifacts(workspaceDir) {
  const sp = statePathFor(workspaceDir);
  if (existsSync(sp)) rmSync(sp, { force: true });
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
}

function saveBackup(workspaceDir, state) {
  if (!state?.selected) return;
  const key = backupKeyFor({
    ...state.selected,
    repo_path: state.repoPath ?? state.selected?.repo_path ?? ".",
  });
  const backupDir = path.join(workspaceDir, ".coder", "backups", key);
  mkdirSync(backupDir, { recursive: true });
  const stateDest = path.join(backupDir, "state.json");
  writeFileSync(stateDest, JSON.stringify(state, null, 2) + "\n", "utf8");
  const srcArtifacts = path.join(workspaceDir, ".coder", "artifacts");
  const destArtifacts = path.join(backupDir, "artifacts");
  if (existsSync(srcArtifacts)) {
    mkdirSync(destArtifacts, { recursive: true });
    for (const name of [
      "ISSUE.md",
      "PLAN.md",
      "PLANREVIEW.md",
      "REVIEW_FINDINGS.md",
    ]) {
      const src = path.join(srcArtifacts, name);
      if (existsSync(src))
        cpSync(src, path.join(destArtifacts, name), { force: true });
    }
  }
  if (state.scratchpadPath) {
    const srcMd = path.join(workspaceDir, state.scratchpadPath);
    if (existsSync(srcMd))
      cpSync(srcMd, path.join(backupDir, "scratchpad.md"), { force: true });
  }
  // Do NOT backup scratchpad.db — it is shared across all issues. Restoring
  // it would wipe other issues' scratchpad state. The per-issue .md file is enough.
}

async function restoreBackup(workspaceDir, backupDir, issue, ctx) {
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const srcArtifacts = path.join(backupDir, "artifacts");
  if (existsSync(srcArtifacts)) {
    for (const name of [
      "ISSUE.md",
      "PLAN.md",
      "PLANREVIEW.md",
      "REVIEW_FINDINGS.md",
    ]) {
      const src = path.join(srcArtifacts, name);
      if (existsSync(src))
        cpSync(src, path.join(artifactsDir, name), { force: true });
    }
  }
  const scratchpad = new ScratchpadPersistence({
    workspaceDir,
    scratchpadDir:
      ctx.scratchpadDir ?? path.join(workspaceDir, ".coder", "scratchpad"),
    sqlitePath: path.join(workspaceDir, ".coder", "scratchpad.db"),
    sqliteSync: false,
  });
  const canonicalScratchpadPath = scratchpad.issueScratchpadPath(issue);
  const backupMd = path.join(backupDir, "scratchpad.md");
  if (existsSync(backupMd)) {
    mkdirSync(path.dirname(canonicalScratchpadPath), { recursive: true });
    cpSync(backupMd, canonicalScratchpadPath, { force: true });
  }
  // Do NOT restore scratchpad.db — it is shared. Restoring would overwrite
  // other issues' scratchpad rows. The .md file is enough; DB will sync on use.
  const restored = await loadStateFromPath(path.join(backupDir, "state.json"));
  if (restored) {
    if (existsSync(backupMd))
      restored.scratchpadPath = path.relative(
        workspaceDir,
        canonicalScratchpadPath,
      );
    await saveState(workspaceDir, restored);
  }
}

/** @internal Exported for testing */
export async function prepareForIssue(workspaceDir, issue, ctx) {
  if (ctx.config?.workflow?.resumeStepState === false) {
    clearStateAndArtifacts(workspaceDir);
    return;
  }
  const state = await loadState(workspaceDir).catch(() => null);
  const normRepo = (p) => (p ?? ".").trim() || ".";
  const primaryKey = backupKeyFor(issue);
  const legacyKey =
    normRepo(issue.repo_path) !== "."
      ? backupKeyFor({ ...issue, repo_path: "." })
      : null;

  for (const key of [primaryKey, legacyKey].filter(Boolean)) {
    const backupDir = path.join(workspaceDir, ".coder", "backups", key);
    if (!existsSync(path.join(backupDir, "state.json"))) continue;

    const restored = await loadStateFromPath(
      path.join(backupDir, "state.json"),
    ).catch(() => null);
    const backupArtifactsDir = path.join(backupDir, "artifacts");
    const repoMatch =
      normRepo(restored?.repoPath ?? restored?.selected?.repo_path) ===
      normRepo(issue.repo_path);
    if (
      restored?.selected?.id === issue.id &&
      restored?.selected?.source === issue.source &&
      repoMatch &&
      artifactConsistent(workspaceDir, restored.steps, backupArtifactsDir)
    ) {
      await restoreBackup(workspaceDir, backupDir, issue, ctx);
      rmSync(backupDir, { recursive: true, force: true });
      ctx.log({
        event: "loop_resume_detected",
        issueId: issue.id,
        from: "backup",
      });
      return;
    }
  }
  const repoMatch =
    normRepo(state?.repoPath ?? state?.selected?.repo_path) ===
    normRepo(issue.repo_path);
  if (
    state?.selected?.id === issue.id &&
    state?.selected?.source === issue.source &&
    repoMatch &&
    artifactConsistent(workspaceDir, state.steps)
  ) {
    ctx.log({
      event: "loop_resume_detected",
      issueId: issue.id,
      from: "current",
    });
    return;
  }
  if (state?.selected && state?.steps?.wrotePlan) {
    saveBackup(workspaceDir, state);
  }
  clearStateAndArtifacts(workspaceDir);
}

/**
 * Ensure the workspace is in a known-clean state before starting the loop.
 * Cleans up stale per-issue state and artifacts that a previous crashed or
 * interrupted run may have left behind. Does NOT touch loop-state.json so
 * issue-level resume information is preserved.
 *
 * @param {object} [opts] - Optional. When opts.ctx is not provided (old callers), uses legacy behavior (always delete state/artifacts).
 * @param {object} [opts.ctx] - Workflow context (config, etc.)
 * @param {Array} [opts.issues] - Current issue queue for backup pruning
 * @param {boolean} [opts.destructiveReset] - When true, delete state, artifacts, and all backups
 */
export function ensureCleanLoopStart(
  workspaceDir,
  repoRoot,
  defaultBranch,
  log,
  knownBranches = new Set(),
  opts = {},
) {
  const cleaned = {
    state: false,
    artifacts: false,
    branch: false,
    wipCommitted: false,
    worktree: false,
  };

  const ctx = opts.ctx;
  const destructiveReset = opts.destructiveReset === true;
  const resumeEnabled =
    ctx && ctx.config?.workflow?.resumeStepState !== false && !destructiveReset;

  // 1. Delete stale per-issue state and artifacts (or preserve when resume enabled)
  if (!resumeEnabled) {
    const sp = statePathFor(workspaceDir);
    if (existsSync(sp)) cleaned.state = true;
    const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
    for (const name of [
      "ISSUE.md",
      "PLAN.md",
      "PLANREVIEW.md",
      "REVIEW_FINDINGS.md",
    ]) {
      if (existsSync(path.join(artifactsDir, name))) {
        cleaned.artifacts = true;
        break;
      }
    }
    clearStateAndArtifacts(workspaceDir);
  } else {
    log({ event: "loop_startup_resume_preserved" });
  }

  // 2. destructiveReset: delete all backups
  if (destructiveReset) {
    const backupsDir = path.join(workspaceDir, ".coder", "backups");
    if (existsSync(backupsDir)) {
      rmSync(backupsDir, { recursive: true, force: true });
    }
  }
  // 3. Prune orphan backups (issues no longer in queue)
  else if (resumeEnabled && opts.issues && Array.isArray(opts.issues)) {
    const validKeys = new Set(opts.issues.map((i) => backupKeyFor(i)));
    const backupsDir = path.join(workspaceDir, ".coder", "backups");
    if (existsSync(backupsDir)) {
      try {
        const entries = readdirSync(backupsDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !validKeys.has(e.name))
            rmSync(path.join(backupsDir, e.name), {
              recursive: true,
              force: true,
            });
        }
      } catch {
        // Best-effort prune
      }
    }
  }

  // 3b. Prune orphan checkpoints (runIds no longer in issue queue)
  if (resumeEnabled && opts.issues && Array.isArray(opts.issues)) {
    const validRunIds = new Set(
      opts.issues.map((q) => q?.lastFailedRunId).filter(Boolean),
    );
    const coderDir = path.join(workspaceDir, ".coder");
    if (existsSync(coderDir)) {
      try {
        const entries = readdirSync(coderDir, { withFileTypes: true });
        for (const e of entries) {
          if (
            e.isFile() &&
            e.name.startsWith("checkpoint-") &&
            e.name.endsWith(".json")
          ) {
            const runId = e.name.slice("checkpoint-".length, -".json".length);
            if (!validRunIds.has(runId))
              rmSync(path.join(coderDir, e.name), { force: true });
          }
        }
      } catch {
        // Best-effort prune
      }
    }
  }

  // 4. Ensure git is on the default branch
  const branchRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (branchRes.status !== 0) {
    const err = (branchRes.stderr || "").trim().slice(0, 200);
    log({
      event: "loop_startup_cleanup_failed",
      step: "detect_branch",
      error: err,
    });
    throw new Error(
      `Loop startup cleanup failed: could not detect current branch: ${err}`,
    );
  }
  const currentBranch = (branchRes.stdout || "").trim();
  if (currentBranch && currentBranch !== defaultBranch) {
    const wipStatus = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const hasDirty = !!(wipStatus.stdout || "").trim();

    if (hasDirty && knownBranches.has(currentBranch)) {
      // Agent-managed branch from a prior run: preserve uncommitted WIP
      const addRes = spawnSync("git", ["add", "-A"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (addRes.status !== 0) {
        throw new Error(
          `Loop startup cleanup failed: git add failed: ${(addRes.stderr || "").trim().slice(0, 200)}`,
        );
      }
      const commitRes = spawnSync(
        "git",
        ["commit", "-m", `wip: interrupted work on ${currentBranch}`],
        { cwd: repoRoot, encoding: "utf8" },
      );
      if (commitRes.status === 0) {
        cleaned.wipCommitted = true;
      } else {
        throw new Error(
          `Loop startup cleanup failed: could not preserve WIP on ${currentBranch} (commit failed): ${(commitRes.stderr || "").trim().slice(0, 150)}`,
        );
      }
    } else if (hasDirty) {
      const discardOk = discardWorktreeChanges(repoRoot);
      if (!discardOk) {
        log({
          event: "loop_startup_cleanup_failed",
          step: "discard_unknown_branch",
          error: "could not discard worktree",
        });
        throw new Error(
          "Loop startup cleanup failed: could not discard worktree on unknown branch",
        );
      }
    }

    const coRes = spawnSync("git", ["checkout", defaultBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (coRes.status !== 0) {
      const err = (coRes.stderr || "").trim().slice(0, 200);
      log({
        event: "loop_startup_cleanup_failed",
        step: "checkout_default_branch",
        error: err,
      });
      throw new Error(
        `Loop startup cleanup failed: could not checkout ${defaultBranch}: ${err}`,
      );
    }
    cleaned.branch = true;
  }

  // 4. Clean any remaining dirty files on the default branch
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const dirtyLines = (status.stdout || "")
    .split("\n")
    .filter((l) => l.trim() && !l.slice(3).startsWith(".coder/"));
  if (dirtyLines.length > 0) {
    const ok = discardWorktreeChanges(repoRoot);
    if (!ok) {
      log({
        event: "loop_startup_cleanup_failed",
        step: "clean_worktree",
        error: "discardWorktreeChanges failed",
      });
      throw new Error("Loop startup cleanup failed: could not clean worktree");
    }
    cleaned.worktree = true;
  }

  if (
    cleaned.state ||
    cleaned.artifacts ||
    cleaned.branch ||
    cleaned.wipCommitted ||
    cleaned.worktree
  ) {
    log({
      event: "loop_startup_cleanup",
      ...cleaned,
      ...(cleaned.branch && { previousBranch: currentBranch }),
    });
  }
}

/**
 * Fetch open PR/MR branches and their diff stats from the hosting platform.
 * Returns an array of { branch, issueId, title, diffStat } suitable for
 * activeBranches. Best-effort: returns [] on failure.
 *
 * @param {string} repoRoot
 * @param {string} defaultBranch
 * @param {(e: object) => void} log
 * @returns {Array<{ branch: string, issueId: string, title: string, diffStat: string }>}
 */
export function fetchOpenPrBranches(repoRoot, defaultBranch, log) {
  try {
    const platform = detectRemoteType(repoRoot);
    let prs;

    if (platform === "gitlab") {
      const res = spawnSync(
        "glab",
        ["mr", "list", "--state", "opened", "--output", "json"],
        { cwd: repoRoot, encoding: "utf8", timeout: 15000 },
      );
      if (res.status !== 0 || !res.stdout) {
        if (log)
          log({
            event: "open_prs_fetch_failed",
            error: (res.stderr || "glab failed").trim(),
          });
        return [];
      }
      const mrs = JSON.parse(res.stdout);
      prs = (Array.isArray(mrs) ? mrs : []).map((mr) => ({
        branch: mr.source_branch,
        id: `!${mr.iid}`,
        title: mr.title || "",
        fetchRef: `refs/merge-requests/${mr.iid}/head`,
      }));
    } else {
      const res = spawnSync(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--json",
          "headRefName,title,number",
          "--limit",
          "50",
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 15000 },
      );
      if (res.status !== 0 || !res.stdout) {
        if (log)
          log({
            event: "open_prs_fetch_failed",
            error: (res.stderr || "gh failed").trim(),
          });
        return [];
      }
      const items = JSON.parse(res.stdout);
      prs = (Array.isArray(items) ? items : []).map((pr) => ({
        branch: pr.headRefName,
        id: `#${pr.number}`,
        title: pr.title || "",
        fetchRef: `pull/${pr.number}/head`,
      }));
    }

    const result = [];
    for (const pr of prs) {
      // Use the platform-specific PR ref to fetch; this works for both
      // same-repo and fork-based PRs without needing the branch on origin.
      const localRef = `pr-fetch/${pr.id}`;
      const fetchRes = spawnSync(
        "git",
        ["fetch", "origin", `${pr.fetchRef}:${localRef}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 10000 },
      );
      if (fetchRes.status !== 0) continue;
      const stat = spawnSync(
        "git",
        ["diff", "--stat", `${defaultBranch}...${localRef}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 10000 },
      );
      if (stat.status !== 0) continue;
      const diffStat = (stat.stdout || "").trim();
      if (!diffStat) continue;
      result.push({
        branch: pr.branch,
        issueId: pr.id,
        title: pr.title,
        diffStat,
      });
    }

    if (log) {
      log({ event: "open_prs_fetched", platform, count: result.length });
    }
    return result;
  } catch (err) {
    if (log) {
      log({ event: "open_prs_fetch_failed", error: err.message });
    }
    return [];
  }
}

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
    resetForNextIssueOverride, // Internal: test seam, do not use
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

  // Recover from crashes / stale state before building the queue
  await ensureCleanLoopStart(ctx.workspaceDir, ctx);

  const issueListSource = listResult.data.source || "remote";
  let rawIssues;
  if (issueListSource === "forced") {
    rawIssues = listResult.data.issues;
    if (rawIssues.length > maxIssues) {
      ctx.log({
        event: "forced_exceeds_max",
        count: rawIssues.length,
        maxIssues,
      });
    }
  } else {
    rawIssues = listResult.data.issues.slice(0, maxIssues);
  }
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
  const { queue: issues, rationale } = buildIssueQueue(rawIssues, {
    source: issueListSource,
  });

  ctx.log({
    event: "queue_built",
    method: rationale.method,
    depEdges: rationale.depEdges,
    cycles: rationale.cycles.length,
    count: issues.length,
    order: issues.map((i) => i.id),
    source: issueListSource,
  });

  // Initialize loop state — merge terminal statuses from prior run.
  // When destructiveReset is true, only preserve "completed" (don't re-process
  // successes) but reset "failed"/"skipped" to "pending" so they are retried.
  const loopState = await loadLoopState(ctx.workspaceDir);
  const priorQueue = loopState.issueQueue || [];
  const priorById = new Map(priorQueue.map((q) => [q.id, q]));
  const terminalStatuses = destructiveReset
    ? ["completed"]
    : ["completed", "failed", "skipped"];

  // Keep original state for cleanup-failure path so we don't persist overwritten
  // queue (which would erase branch metadata needed for WIP preservation).
  const stateForCleanupFailure = {
    ...loopState,
    issueQueue: priorQueue.map((q) => ({ ...q })),
  };

  loopState.status = "running";
  const listSource = listResult.data.source || "remote";
  loopState.issueQueue = issues.map((iss) => {
    const prior = priorById.get(iss.id);
    const isTerminal = prior && terminalStatuses.includes(prior.status);
    // Defensive fallback for source: local/forced list results set it per-issue;
    // remote agent returns per-issue source. Use listSource when missing.
    const source =
      iss.source ??
      (listSource === "local"
        ? "local"
        : listSource === "forced"
          ? issueSource || "github"
          : "github");
    return {
      ...iss,
      source,
      dependsOn: iss.dependsOn || iss.depends_on || [],
      status: isTerminal ? prior.status : "pending",
      branch: isTerminal ? prior.branch : null,
      prUrl: isTerminal ? prior.prUrl : null,
      error: isTerminal ? prior.error : null,
      baseBranch: isTerminal ? prior.baseBranch : null,
      startedAt: isTerminal ? prior.startedAt : null,
      completedAt: isTerminal ? prior.completedAt : null,
      lastFailedRunId: isTerminal ? null : (prior?.lastFailedRunId ?? null),
    };
  });
  loopState.currentIndex = 0;
  loopState.startedAt = new Date().toISOString();
  loopState.runId = ctx.runId ?? loopState.runId; // ctx.runId typically unset; use prior if present

  const loopRunId = randomUUID().slice(0, 8);
  runHooks(ctx, loopRunId, "loop_start", "", {
    status: "running",
    total: issues.length,
    method: rationale.method,
  });

  // Ensure a clean workspace before processing any issues.
  // Run before persisting overwritten queue so a crash leaves prior branches
  // intact for WIP preservation on next startup.
  // Recovers from prior crashed/interrupted runs without touching loop-state.json.
  // Throws if git is broken — no point continuing if the workspace can't be cleaned.
  const loopRepoRoot = resolveRepoRoot(ctx.workspaceDir, ".");
  const loopDefaultBranch = detectDefaultBranch(loopRepoRoot);
  const knownBranches = new Set(
    priorQueue.map((q) => q.branch).filter(Boolean),
  );
  try {
    ensureCleanLoopStart(
      ctx.workspaceDir,
      loopRepoRoot,
      loopDefaultBranch,
      ctx.log,
      knownBranches,
      { ctx, issues: loopState.issueQueue, destructiveReset },
    );
  } catch (cleanupErr) {
    stateForCleanupFailure.status = "failed";
    stateForCleanupFailure.error = cleanupErr.message;
    stateForCleanupFailure.runId = loopState.runId;
    stateForCleanupFailure.completedAt = new Date().toISOString();
    await saveLoopState(ctx.workspaceDir, stateForCleanupFailure, {
      guardRunId: loopState.runId,
    });
    runHooks(ctx, loopRunId, "loop_complete", "", {
      status: "failed",
      completed: 0,
      failed: 0,
      skipped: 0,
      error: cleanupErr.message,
    });
    return {
      status: "failed",
      error: cleanupErr.message,
      results: [],
    };
  }

  await saveLoopState(ctx.workspaceDir, loopState, {
    guardRunId: loopState.runId,
  });

  /** @type {Map<string, { status: string, branch?: string, diffSummary?: string, repoPath?: string }>} */
  const outcomeMap = new Map();
  const results = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  // Seed outcomeMap from terminal issues in the prior run (includes
  // issues no longer in the active list, e.g. closed/merged).
  // Respects destructiveReset: failed/skipped are not seeded so their
  // dependents don't inherit stale failure outcomes.
  // For completed branches, compute diffSummary so they can serve as
  // fallback conflict context when open-PR fetching is unavailable.
  for (const prior of priorQueue) {
    if (!terminalStatuses.includes(prior.status)) continue;
    const entry = {
      status: prior.status,
      branch: prior.branch || undefined,
    };
    if (prior.status === "completed") {
      const priorRepoPath = normalizeRepoPath(
        ctx.workspaceDir,
        prior.repo_path,
      );
      entry.repoPath = priorRepoPath;
      if (prior.branch) {
        const priorRepoRoot = resolveRepoRoot(ctx.workspaceDir, priorRepoPath);
        const priorDefault = detectDefaultBranch(priorRepoRoot);
        const stat = spawnSync(
          "git",
          ["diff", "--stat", `${priorDefault}...${prior.branch}`],
          { cwd: priorRepoRoot, encoding: "utf8", timeout: 5000 },
        );
        if (stat.status === 0) {
          entry.diffSummary = (stat.stdout || "").trim() || undefined;
        }
      }
    }
    outcomeMap.set(prior.id, entry);
  }
  for (const entry of loopState.issueQueue) {
    if (entry.status === "completed") completed++;
    else if (entry.status === "failed") failed++;
    else if (entry.status === "skipped") skipped++;
  }

  // Helper: process a single issue
  async function processIssue(issue, i, { isRetry = false } = {}) {
    const currentStatus = loopState.issueQueue[i].status;
    if (["completed", "failed", "skipped"].includes(currentStatus)) {
      results.push({
        ...issue,
        status: currentStatus,
        branch: loopState.issueQueue[i].branch,
        prUrl: loopState.issueQueue[i].prUrl,
        error: loopState.issueQueue[i].error,
      });
      return currentStatus;
    }

    loopState.currentIndex = i;
    loopState.currentStage = isRetry ? "retry" : "processing";
    loopState.lastHeartbeatAt = new Date().toISOString();
    loopState.issueQueue[i].status = "in_progress";
    loopState.issueQueue[i].branch = buildIssueBranchName(issue);
    loopState.issueQueue[i].startedAt = new Date().toISOString();
    await saveLoopState(ctx.workspaceDir, loopState, {
      guardRunId: loopState.runId,
    });

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
      await saveLoopState(ctx.workspaceDir, loopState, {
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
      await saveLoopState(ctx.workspaceDir, loopState, {
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
    const issueRepoRoot = resolveRepoRoot(ctx.workspaceDir, repoPath);

    // Pull latest default branch to pick up any PRs merged while
    // earlier issues were being processed.
    const pullResult = spawnSync("git", ["pull", "--ff-only"], {
      cwd: issueRepoRoot,
      encoding: "utf8",
    });
    if (pullResult.status !== 0) {
      ctx.log({
        event: "git_pull_failed",
        issueId: issue.id,
        stderr: (pullResult.stderr || "").trim().slice(0, 200),
      });
    }

    // Resolve per-issue default branch (may differ from workspace root
    // when issue.repo_path targets a different repo).
    const issueDefaultBranch = detectDefaultBranch(issueRepoRoot);

    // Build active branch context for conflict detection (skipped when disabled).
    let activeBranches = [];
    if (ctx.config?.workflow?.conflictDetection !== false) {
      const openPrBranches = fetchOpenPrBranches(
        issueRepoRoot,
        issueDefaultBranch,
        ctx.log,
      );
      const seenBranches = new Set(openPrBranches.map((b) => b.branch));

      // Add current-run completed branches not already covered by open PRs,
      // filtering to only those from the same repo to avoid cross-repo contamination.
      for (const [id, outcome] of outcomeMap) {
        if (
          outcome.status === "completed" &&
          outcome.branch &&
          outcome.diffSummary &&
          outcome.repoPath === repoPath &&
          !seenBranches.has(outcome.branch)
        ) {
          const entry = loopState.issueQueue.find((q) => q.id === id);
          openPrBranches.push({
            branch: outcome.branch,
            issueId: id,
            title: entry?.title || "",
            diffStat: outcome.diffSummary,
          });
          seenBranches.add(outcome.branch);
        }
      }
      activeBranches = openPrBranches;
    }

    if (ctx.config?.workflow?.resumeStepState !== false) {
      await prepareForIssue(ctx.workspaceDir, issue, ctx);
    }

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
          activeBranches,
          loopState,
          issueIndex: i,
          resumeFromRunId:
            loopState.issueQueue[i]?.lastFailedRunId || undefined,
        },
        ctx,
      );

      // Conflict-based deferral: planner detected overlap with an active branch
      if (pipelineResult.status === "deferred") {
        ctx.log({
          event: "issue_deferred_conflict",
          issueId: issue.id,
          conflictBranch: pipelineResult.conflictBranch,
          error: pipelineResult.error,
        });

        // Clear planning cache so the planner re-runs on retry with updated branches
        const deferState = await loadState(ctx.workspaceDir);
        deferState.steps ||= {};
        deferState.steps.wrotePlan = false;
        deferState.steps.wroteCritique = false;
        await saveState(ctx.workspaceDir, deferState);

        const deferPaths = artifactPaths(ctx.artifactsDir);
        if (existsSync(deferPaths.plan))
          rmSync(deferPaths.plan, { force: true });
        if (existsSync(deferPaths.critique))
          rmSync(deferPaths.critique, { force: true });

        loopState.issueQueue[i].status = "deferred";
        loopState.issueQueue[i].error = pipelineResult.error;
        await saveLoopState(ctx.workspaceDir, loopState, {
          guardRunId: loopState.runId,
        });

        // Phase 1+2 ran, so workspace is on the issue branch — reset it
        await resetForNextIssue(ctx.workspaceDir, repoPath, {
          destructiveReset,
          issueStatus: "deferred",
        });

        runHooks(
          ctx,
          loopRunId,
          "issue_deferred",
          "",
          { status: "deferred", reason: "conflict" },
          issueEnv,
        );
        return "deferred";
      }

      if (pipelineResult.status === "completed") {
        const prResult =
          pipelineResult.results[pipelineResult.results.length - 1];
        const branch = prResult?.data?.branch;
        loopState.issueQueue[i].status = "completed";
        loopState.issueQueue[i].branch = branch;
        loopState.issueQueue[i].prUrl = prResult?.data?.prUrl;
        loopState.issueQueue[i].error = null;
        loopState.issueQueue[i].completedAt = new Date().toISOString();
        // Record diff stats so subsequent issues can detect file overlap
        const diffStat = spawnSync(
          "git",
          ["diff", "--stat", `${issueDefaultBranch}...${branch}`],
          { cwd: issueRepoRoot, encoding: "utf8" },
        );
        const diffSummary = (diffStat.stdout || "").trim();
        outcomeMap.set(issue.id, {
          status: "completed",
          branch,
          diffSummary,
          repoPath,
        });
        completed++;
        results.push({
          ...issue,
          status: "completed",
          prUrl: prResult?.data?.prUrl,
          branch,
        });
        const backupDir = path.join(
          ctx.workspaceDir,
          ".coder",
          "backups",
          backupKeyFor(issue),
        );
        if (existsSync(backupDir))
          rmSync(backupDir, { recursive: true, force: true });
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
          await saveLoopState(ctx.workspaceDir, loopState, {
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
        await saveLoopState(ctx.workspaceDir, loopState, {
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

    await saveLoopState(ctx.workspaceDir, loopState, {
      guardRunId: loopState.runId,
    });

    // Reset between issues — if this fails, abort the loop because
    // subsequent issues would run from the wrong branch/worktree.
    const issueStatus = loopState.issueQueue[i].status;
    const doReset = resetForNextIssueOverride ?? resetForNextIssue;
    try {
      await doReset(ctx.workspaceDir, repoPath, {
        destructiveReset,
        issueStatus,
      });
    } catch (resetErr) {
      ctx.log({
        event: "reset_for_next_issue_failed",
        issueId: issue.id,
        error: resetErr.message,
      });
      // Mark as failed so loop state/counters reflect the abort cause
      loopState.issueQueue[i].status = "failed";
      loopState.issueQueue[i].error =
        issueStatus === "completed"
          ? resetErr.message
          : `${loopState.issueQueue[i].error}; reset failed: ${resetErr.message}`;
      outcomeMap.set(issue.id, { status: "failed" });
      if (issueStatus === "completed") {
        completed--;
        failed++;
        const lastResult = results[results.length - 1];
        if (lastResult?.id === issue.id) {
          results[results.length - 1] = {
            ...issue,
            status: "failed",
            error: resetErr.message,
          };
        } else {
          results.push({ ...issue, status: "failed", error: resetErr.message });
        }
        runHooks(
          ctx,
          loopRunId,
          "issue_failed",
          "",
          {
            status: "failed",
            error: loopState.issueQueue[i].error,
          },
          {
            CODER_HOOK_ISSUE_ID: String(issue.id || ""),
            CODER_HOOK_ISSUE_TITLE: String(issue.title || ""),
          },
        );
      }
      await saveLoopState(ctx.workspaceDir, loopState, {
        guardRunId: loopState.runId,
      });
      return "failed";
    }
    return issueStatus;
  }

  // Main pass
  for (let i = 0; i < issues.length; i++) {
    if (ctx.cancelToken.cancelled) break;
    const issueStatus = await processIssue(issues[i], i);
    if (issueStatus !== "failed") continue;

    // Skip only transitive dependents of the failed issue; independent issues continue.
    const failedIssueId = issues[i]?.id;
    loopState.status = "failed";
    ctx.log({
      event: "loop_aborted_on_failure",
      issueId: failedIssueId,
      reason: "issue_failed",
    });
    const dependentIds = getTransitiveDependents(issues, failedIssueId);
    if (dependentIds.size > 0) {
      ctx.log({
        event: "skipping_dependents",
        issueId: failedIssueId,
        dependents: [...dependentIds],
      });

      for (let j = 0; j < loopState.issueQueue.length; j++) {
        const entry = loopState.issueQueue[j];
        if (!dependentIds.has(entry.id)) continue;
        if (entry.status !== "pending" && entry.status !== "deferred") continue;

        entry.status = "skipped";
        entry.error = `Skipped: depends on failed issue ${failedIssueId}`;
        entry.completedAt = new Date().toISOString();
        outcomeMap.set(entry.id, { status: "skipped" });
        skipped++;

        const issueEnv = {
          CODER_HOOK_ISSUE_ID: String(entry.id || ""),
          CODER_HOOK_ISSUE_TITLE: String(entry.title || ""),
        };
        ctx.log({
          event: "issue_skipped",
          issueId: entry.id,
          reason: "depends_on_failed",
          failedIssueId,
        });
        runHooks(
          ctx,
          loopRunId,
          "issue_skipped",
          "",
          {
            status: "skipped",
            reason: "depends_on_failed",
            failedIssueId,
          },
          issueEnv,
        );
      }

      await saveLoopState(ctx.workspaceDir, loopState, {
        guardRunId: loopState.runId,
      });
    }
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
      const retryStatus = await processIssue(issues[i], i, { isRetry: true });
      if (retryStatus === "failed") {
        const failedIssueId = issues[i]?.id;
        loopState.status = "failed";
        ctx.log({
          event: "loop_aborted_on_failure",
          issueId: failedIssueId,
          reason: "issue_failed",
        });
        for (let j = 0; j < loopState.issueQueue.length; j++) {
          const entry = loopState.issueQueue[j];
          if (entry.status !== "pending" && entry.status !== "deferred")
            continue;
          entry.status = "skipped";
          entry.error = "Skipped: prior issue failed";
          entry.completedAt = new Date().toISOString();
          outcomeMap.set(entry.id, { status: "skipped" });
          skipped++;
          const issueEnv = {
            CODER_HOOK_ISSUE_ID: String(entry.id || ""),
            CODER_HOOK_ISSUE_TITLE: String(entry.title || ""),
          };
          ctx.log({
            event: "issue_skipped",
            issueId: entry.id,
            reason: "aborted_after_failure",
            failedIssueId,
          });
          runHooks(
            ctx,
            loopRunId,
            "issue_skipped",
            "",
            {
              status: "skipped",
              reason: "aborted_after_failure",
              failedIssueId,
            },
            issueEnv,
          );
          results.push({
            ...issues[j],
            status: "skipped",
            error: entry.error,
          });
        }
        await saveLoopState(ctx.workspaceDir, loopState, {
          guardRunId: loopState.runId,
        });
        break;
      }
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
        cwd: loopRepoRoot,
        encoding: "utf8",
      });
      if (verify.status !== 0) continue; // branch never created

      const log = spawnSync(
        "git",
        ["log", `${loopDefaultBranch}..${branch}`, "--oneline"],
        { cwd: loopRepoRoot, encoding: "utf8" },
      );
      const hasCommits = (log.stdout || "").trim().length > 0;

      if (hasCommits) {
        kept.push(branch);
      } else {
        spawnSync("git", ["branch", "-D", branch], {
          cwd: loopRepoRoot,
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
          ["diff", `${loopDefaultBranch}...${q.branch}`, "--stat"],
          { cwd: loopRepoRoot, encoding: "utf8" },
        );
        const diff = spawnSync(
          "git",
          ["diff", `${loopDefaultBranch}...${q.branch}`],
          { cwd: loopRepoRoot, encoding: "utf8" },
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

      const prompt = `You are reviewing the combined changeset from ${completedBranches.length} feature branches that were implemented in parallel against the same base branch (${loopDefaultBranch}).

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

  if (loopState.status === "running") {
    loopState.status = ctx.cancelToken.cancelled ? "cancelled" : "completed";
  }
  loopState.completedAt = new Date().toISOString();
  await saveLoopState(ctx.workspaceDir, loopState, {
    guardRunId: loopState.runId,
  });

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
 * Check if the repo has any tracked files (to guard against `git restore` on empty repos).
 */
function hasTrackedFiles(repoRoot) {
  const res = spawnSync("git", ["ls-files", "--error-unmatch", "."], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return res.status === 0;
}

/**
 * Reset workspace for next issue in autonomous loop.
 */
export async function resetForNextIssue(
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
    const preStatus = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const hasDirtyFiles = !!(preStatus.stdout || "").trim();

    if (
      hasDirtyFiles &&
      (issueStatus === "failed" || issueStatus === "skipped")
    ) {
      // Preserve partial work on the issue branch for failed/skipped issues.
      const addRes = spawnSync("git", ["add", "-A"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (addRes.status !== 0) {
        throw new Error(
          `resetForNextIssue: git add failed: ${(addRes.stderr || "").trim().slice(0, 200)}`,
        );
      }
      const commitRes = spawnSync(
        "git",
        ["commit", "-m", `wip: partial work (issue ${issueStatus})`],
        { cwd: repoRoot, encoding: "utf8" },
      );
      if (commitRes.status !== 0) {
        throw new Error(
          `resetForNextIssue: could not preserve WIP (commit failed): ${(commitRes.stderr || "").trim().slice(0, 150)}`,
        );
      }
    } else if (hasDirtyFiles) {
      if (!discardWorktreeChanges(repoRoot)) {
        throw new Error(
          "resetForNextIssue: could not discard worktree changes",
        );
      }
    }

    const defaultBranch = detectDefaultBranch(repoRoot);
    const checkoutRes = spawnSync("git", ["checkout", defaultBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (checkoutRes.status !== 0) {
      throw new Error(
        `resetForNextIssue: git checkout ${defaultBranch} failed: ${(checkoutRes.stderr || "").trim().slice(0, 200)}`,
      );
    }

    // Always remove untracked files after switching to the default branch
    // to prevent them from leaking into the next issue's workspace.
    const cleanRes = spawnSync("git", ["clean", "-fd", "--exclude=.coder/"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (cleanRes.status !== 0) {
      throw new Error(
        `resetForNextIssue: git clean failed: ${(cleanRes.stderr || "").trim().slice(0, 200)}`,
      );
    }

    // Always clean untracked files after switching branches so the next
    // issue starts with a pristine working tree.
    if (destructiveReset) {
      // Redundant with discardWorktreeChanges + git clean above when hasDirtyFiles,
      // but ensures staged/worktree match HEAD when we skipped discard (no dirty files).
      // Skip when repo has no tracked files (e.g. empty initial commit) — restore
      // would fail with "pathspec '.' did not match any file(s) known to git".
      const lsRes = spawnSync("git", ["ls-files"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const hasTrackedFiles = !!(lsRes.stdout || "").trim();
      if (hasTrackedFiles) {
        const restoreRes = spawnSync(
          "git",
          ["restore", "--staged", "--worktree", "."],
          { cwd: repoRoot, encoding: "utf8" },
        );
        if (restoreRes.status !== 0) {
          throw new Error(
            `resetForNextIssue: git restore failed: ${(restoreRes.stderr || "").trim().slice(0, 200)}`,
          );
        }
      }
    }
  }
}

/**
 * Ensure the loop starts from a clean state — recover from crashes, stale branches,
 * and interrupted runs.
 *
 * Called at loop start after issue listing. No-op when already clean.
 */
export async function ensureCleanLoopStart(workspaceDir, ctx) {
  const repoRoot = resolveRepoRoot(workspaceDir, ".");
  if (!existsSync(repoRoot)) return;

  const defaultBranch = detectDefaultBranch(repoRoot);

  // 1. Detect current branch
  const headRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const currentBranch = (headRes.stdout || "").trim();

  // 2. If on wrong branch, recover
  if (
    currentBranch &&
    currentBranch !== defaultBranch &&
    currentBranch !== "HEAD"
  ) {
    const loopState = await loadLoopState(workspaceDir);
    const knownBranches = new Set(
      (loopState.issueQueue || []).filter((q) => q.branch).map((q) => q.branch),
    );

    const isDirty = (() => {
      const st = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return (st.stdout || "").trim().length > 0;
    })();

    if (knownBranches.has(currentBranch) && isDirty) {
      // WIP-commit dirty state on known branches (best-effort)
      // Exclude .coder/ so workspace state isn't captured in WIP commits
      spawnSync("git", ["add", "-A", "--", ".", ":!.coder/"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      spawnSync(
        "git",
        ["commit", "-m", "wip: crash recovery (ensureCleanLoopStart)"],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );
      ctx.log({ event: "clean_loop_start_wip_commit", branch: currentBranch });
    } else if (isDirty) {
      // Discard dirty state on unknown branches
      if (hasTrackedFiles(repoRoot)) {
        spawnSync("git", ["restore", "--staged", "--worktree", "."], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
      spawnSync("git", ["clean", "-fd", "--exclude=.coder/"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      ctx.log({ event: "clean_loop_start_discard", branch: currentBranch });
    }

    // Switch to default branch
    const coRes = spawnSync("git", ["checkout", defaultBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (coRes.status !== 0) {
      throw new Error(
        `ensureCleanLoopStart: git checkout ${defaultBranch} failed: ${(coRes.stderr || "").trim()}`,
      );
    }
    ctx.log({
      event: "clean_loop_start_checkout",
      from: currentBranch,
      to: defaultBranch,
    });
  }

  // 3. Reset stale in_progress entries to pending
  const loopState = await loadLoopState(workspaceDir);
  let resetCount = 0;
  for (const entry of loopState.issueQueue || []) {
    if (entry.status === "in_progress") {
      entry.status = "pending";
      resetCount++;
    }
  }
  if (resetCount > 0) {
    await saveLoopState(workspaceDir, loopState, {
      guardRunId: loopState.runId,
    });
    ctx.log({ event: "clean_loop_start_reset_stale", count: resetCount });
  }

  // 4. If on default branch but dirty, clean up
  if (
    !currentBranch ||
    currentBranch === defaultBranch ||
    currentBranch === "HEAD"
  ) {
    const st = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if ((st.stdout || "").trim()) {
      if (hasTrackedFiles(repoRoot)) {
        spawnSync("git", ["restore", "--staged", "--worktree", "."], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      }
      spawnSync("git", ["clean", "-fd", "--exclude=.coder/"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      ctx.log({
        event: "clean_loop_start_dirty_default",
        branch: defaultBranch,
      });
    }
  }
}
