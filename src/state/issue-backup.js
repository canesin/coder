import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ScratchpadPersistence } from "./persistence.js";
import {
  loadState,
  loadStateFromPath,
  saveState,
  statePathFor,
} from "./workflow-state.js";

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

/** @deprecated Use reconcileSteps for graceful partial recovery. */
export function artifactConsistent(workspaceDir, steps, artifactsDirOverride) {
  const { rolledBack } = reconcileSteps(
    steps,
    artifactsDirOverride ?? path.join(workspaceDir, ".coder", "artifacts"),
  );
  return rolledBack.length === 0;
}

/**
 * Reconcile step flags with actual artifact files on disk. Instead of an
 * all-or-nothing rejection, rolls back only the broken step and its downstream
 * dependencies — preserving valid upstream work for partial resume.
 *
 * @param {object|null} steps
 * @param {string} artifactsDir
 * @returns {{ steps: object, rolledBack: string[] }}
 */
export function reconcileSteps(steps, artifactsDir) {
  if (!steps) return { steps: {}, rolledBack: [] };
  const reconciled = { ...steps };
  const rolledBack = [];

  const clearDownstreamFromPlan = () => {
    reconciled.wrotePlan = false;
    reconciled.wroteCritique = false;
    reconciled.implemented = false;
    reconciled.reviewerCompleted = false;
    delete reconciled.reviewRound;
    delete reconciled.reviewVerdict;
    delete reconciled.programmerFixedRound;
    delete reconciled.testsPassed;
    delete reconciled.ppcommitClean;
    delete reconciled.prCreated;
  };

  const clearDownstreamFromCritique = () => {
    reconciled.wroteCritique = false;
    reconciled.implemented = false;
    reconciled.reviewerCompleted = false;
    delete reconciled.reviewRound;
    delete reconciled.reviewVerdict;
    delete reconciled.programmerFixedRound;
    delete reconciled.testsPassed;
    delete reconciled.ppcommitClean;
    delete reconciled.prCreated;
  };

  // ISSUE.md is the foundation — if missing, nothing can resume
  if (
    reconciled.wroteIssue &&
    !existsSync(path.join(artifactsDir, "ISSUE.md"))
  ) {
    return { steps: {}, rolledBack: ["wroteIssue"] };
  }

  // PLAN.md missing → clear plan + all downstream, keep issue
  if (reconciled.wrotePlan && !existsSync(path.join(artifactsDir, "PLAN.md"))) {
    rolledBack.push("wrotePlan");
    clearDownstreamFromPlan();
  }

  // PLANREVIEW.md missing → clear critique + downstream, keep plan
  if (
    reconciled.wroteCritique &&
    !existsSync(path.join(artifactsDir, "PLANREVIEW.md"))
  ) {
    rolledBack.push("wroteCritique");
    clearDownstreamFromCritique();
  }

  // REVIEW_FINDINGS.md missing → clear review state, keep implementation
  if (
    reconciled.reviewerCompleted &&
    !existsSync(path.join(artifactsDir, "REVIEW_FINDINGS.md"))
  ) {
    rolledBack.push("reviewerCompleted");
    reconciled.reviewerCompleted = false;
    delete reconciled.reviewRound;
    delete reconciled.reviewVerdict;
    delete reconciled.programmerFixedRound;
    delete reconciled.testsPassed;
    delete reconciled.ppcommitClean;
    delete reconciled.prCreated;
  }

  return { steps: reconciled, rolledBack };
}

/** Artifact names archived on failure — all optional, whatever exists gets copied. */
const FAILURE_ARTIFACT_NAMES = [
  "ISSUE.md",
  "PLAN.md",
  "PLANREVIEW.md",
  "REVIEW_FINDINGS.md",
];

/**
 * Archive all available workflow artifacts to .coder/failures/ for debugging
 * when an issue fails, is deferred, or is skipped. Archives whatever exists
 * at the time of failure — works at any stage.
 *
 * @param {string} workspaceDir
 * @param {{ source?: string, id: string, title?: string }} issue
 * @param {string} [reason] - e.g. "plan_review_exhausted", "failed", "deferred", "issue_switch"
 * @param {{ stage?: string }} [extra] - optional metadata (which stage failed)
 */
export function archiveFailureArtifacts(
  workspaceDir,
  issue,
  reason = "",
  extra = {},
) {
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  // Only archive if at least one artifact file exists
  const hasAny = FAILURE_ARTIFACT_NAMES.some((name) =>
    existsSync(path.join(artifactsDir, name)),
  );
  if (!hasAny) return;

  const safeId = String(issue?.id ?? "unknown").replace(/[/\\:*?"<>|]/g, "-");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archiveDir = path.join(
    workspaceDir,
    ".coder",
    "failures",
    `${safeId}-${ts}`,
  );
  mkdirSync(archiveDir, { recursive: true });

  for (const name of FAILURE_ARTIFACT_NAMES) {
    const src = path.join(artifactsDir, name);
    if (existsSync(src))
      cpSync(src, path.join(archiveDir, name), { force: true });
  }
  const reasonLines = [reason, extra.stage ? `stage: ${extra.stage}` : ""]
    .filter(Boolean)
    .join("\n");
  if (reasonLines)
    writeFileSync(
      path.join(archiveDir, "reason.txt"),
      `${reasonLines}\n`,
      "utf8",
    );
}

/** @deprecated Use archiveFailureArtifacts — kept for backwards compat. */
export const archivePlanFailureArtifacts = archiveFailureArtifacts;

export function clearStateAndArtifacts(workspaceDir) {
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

export function saveBackup(workspaceDir, state) {
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

export async function restoreBackup(workspaceDir, backupDir, issue, ctx) {
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
    // Cross-process restore: sessions from the old run are stale.
    // sessionsDisabled may have been set due to a transient auth failure —
    // clear it so the new run starts with sessions enabled.
    restored.sessionsDisabled = false;
    restored.planningSessionId = null;
    restored.planReviewSessionId = null;
    restored.implementationSessionId = null;
    restored.programmerFixSessionId = null;
    restored.reviewerSessionId = null;
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

  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");

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
      repoMatch
    ) {
      // Check what's recoverable from the backup's artifacts
      const { steps: reconciledSteps, rolledBack } = reconcileSteps(
        restored.steps,
        backupArtifactsDir,
      );
      // If the foundation (ISSUE.md) is missing, backup is unusable — skip it
      if (rolledBack.includes("wroteIssue")) continue;

      // Clear workspace artifacts before restoring to prevent stale files
      // from a different issue bleeding into the restored state.
      clearStateAndArtifacts(workspaceDir);
      await restoreBackup(workspaceDir, backupDir, issue, ctx);

      // Apply reconciled steps to the restored state
      if (rolledBack.length > 0) {
        const current = await loadState(workspaceDir).catch(() => null);
        if (current) {
          current.steps = reconciledSteps;
          await saveState(workspaceDir, current);
        }
        ctx.log({
          event: "loop_resume_partial",
          issueId: issue.id,
          from: "backup",
          rolledBack,
        });
      }

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
    repoMatch
  ) {
    // Reconcile steps against what's actually on disk
    const { steps: reconciledSteps, rolledBack } = reconcileSteps(
      state.steps,
      artifactsDir,
    );
    // Foundation gone — fall through to fresh start
    if (rolledBack.includes("wroteIssue")) {
      clearStateAndArtifacts(workspaceDir);
      return;
    }
    if (rolledBack.length > 0) {
      state.steps = reconciledSteps;
      await saveState(workspaceDir, state);
      ctx.log({
        event: "loop_resume_partial",
        issueId: issue.id,
        from: "current",
        rolledBack,
      });
    }
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
  // Archive artifacts only for interrupted/failed issues — not completed ones.
  // Best-effort — don't let archival failure block the issue switch.
  if (state?.selected && !state?.steps?.prCreated) {
    try {
      archiveFailureArtifacts(workspaceDir, state.selected, "issue_switch");
    } catch {
      /* best-effort */
    }
  }
  clearStateAndArtifacts(workspaceDir);
}
