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

/** Verifies that artifact files exist for each step flag set. If a step flag is true
 * but the corresponding file is missing (e.g. manually deleted), returns false —
 * resume will not occur and we start fresh. */
export function artifactConsistent(workspaceDir, steps, artifactsDirOverride) {
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
