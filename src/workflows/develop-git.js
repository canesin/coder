import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  detectDefaultBranch,
  detectRemoteType,
  spawnAsync,
  throwIfAborted,
} from "../helpers.js";
import { resolveRepoRoot } from "../machines/develop/_shared.js";
import { backupKeyFor, clearStateAndArtifacts } from "../state/issue-backup.js";
import { statePathFor } from "../state/workflow-state.js";

/** Unstage, restore tracked files, and remove untracked files. Returns true only if all steps succeeded. */
async function discardWorktreeChanges(repoRoot, opts = {}) {
  // Cooperative cancellation: check signal before each mutating git command
  // but let the command finish once started to avoid partial repo state.
  opts.signal?.throwIfAborted();
  const resetRes = await spawnAsync("git", ["reset"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (resetRes.status !== 0) return false;

  const diffRes = await spawnAsync("git", ["diff", "--name-only"], {
    cwd: repoRoot,
    encoding: "utf8",
    signal: opts.signal,
  });
  throwIfAborted(diffRes);
  if (diffRes.status !== 0) return false;
  const hasTrackedChanges = !!(diffRes.stdout || "").trim();
  if (hasTrackedChanges) {
    opts.signal?.throwIfAborted();
    const coRes = await spawnAsync("git", ["checkout", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (coRes.status !== 0) return false;
  }

  opts.signal?.throwIfAborted();
  const cleanRes = await spawnAsync(
    "git",
    ["clean", "-fd", "--exclude=.coder/"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return cleanRes.status === 0;
}

/**
 * Build argv for listing open MRs via the GitLab REST API (`glab api`).
 * Uses `glab api` instead of `glab mr list --output json` so older glab builds
 * that lack `-F`/`--output` on `mr list` still work. See docs.gitlab.com/cli/api.
 * Exported for testing.
 * @returns {string[]}
 */
export function glabMrListArgs() {
  return ["api", "projects/:id/merge_requests?state=opened&per_page=50"];
}

/** Fallback args for older glab that lacks --output (uses -F json). */
export function glabMrListArgsLegacy() {
  return ["mr", "list", "-F", "json"];
}

/**
 * Extract GitLab project path from remote URL for API calls.
 * Supports gitlab.com and self-hosted (https, ssh SCP, ssh:// URL).
 * Returns null for non-GitLab hosts (e.g. github.com).
 * @param {string} url - Remote URL (e.g. https://gitlab.company.com/group/proj.git)
 * @returns {string|null} - Project path (e.g. "group/proj") or null
 */
export function extractGitLabProjectPath(url) {
  const u = url.trim();
  const hostFromHttps = u.match(/^https?:\/\/([^/]+)/i)?.[1] ?? "";
  const hostFromScp = u.match(/^[^@]+@([^:]+):/)?.[1] ?? "";
  const hostFromSsh = u.match(/^ssh:\/\/([^/]+)/i)?.[1] ?? "";
  const host = (hostFromHttps || hostFromScp || hostFromSsh).toLowerCase();
  if (!host.includes("gitlab")) return null;
  // HTTPS: https://host/group/proj or https://host/group/proj.git
  const httpsMatch = u.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) return httpsMatch[1];
  // SSH SCP: git@host:group/proj or git@host:group/proj.git
  const scpMatch = u.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (scpMatch) return scpMatch[1];
  // SSH URL: ssh://git@host/group/proj.git
  const sshUrlMatch = u.match(/^ssh:\/\/[^/]+\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) return sshUrlMatch[1];
  return null;
}

/**
 * Fallback: fetch open MRs via glab api when mr list lacks --output/-F json.
 * Uses GitLab API projects/:id/merge_requests. Returns [] on failure.
 * Supports gitlab.com and self-hosted instances.
 * @param {string} repoRoot
 * @param {(e: object) => void} [log]
 * @returns {Promise<Array<{ source_branch: string, iid: number, title: string }>>}
 */
async function fetchMergeRequestsViaApi(repoRoot, _log, opts = {}) {
  try {
    const urlRes = await spawnAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
      signal: opts.signal,
    });
    throwIfAborted(urlRes);
    if (urlRes.status !== 0) return [];
    const url = (urlRes.stdout || "").trim();
    const projectPathRaw = extractGitLabProjectPath(url);
    if (!projectPathRaw || !projectPathRaw.includes("/")) return [];
    const projectPath = encodeURIComponent(
      projectPathRaw.replace(/\.git$/, ""),
    );
    const res = await spawnAsync(
      "glab",
      [
        "api",
        `projects/${projectPath}/merge_requests?state=opened&per_page=50`,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 15000, signal: opts.signal },
    );
    throwIfAborted(res);
    if (res.status !== 0 || !res.stdout) return [];
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err?.code === "ABORT_ERR" || err?.name === "AbortError") throw err;
    return [];
  }
}

/** True when glab stderr indicates bad CLI flags — try alternate args or API instead of failing closed. */
export function isGlabMrListFormatMismatchStderr(stderr) {
  return /unknown flag|unrecognized|invalid.*flag|shorthand flag/i.test(
    String(stderr || ""),
  );
}

/**
 * Fetch open PR/MR branches and their diff stats from the hosting platform.
 * Returns an array of { branch, issueId, title, diffStat } suitable for
 * activeBranches. Best-effort: returns [] on failure.
 *
 * @param {string} repoRoot
 * @param {string} defaultBranch
 * @param {(e: object) => void} log
 * @returns {Promise<Array<{ branch: string, issueId: string, title: string, diffStat: string }>>}
 */
export async function fetchOpenPrBranches(
  repoRoot,
  defaultBranch,
  log,
  opts = {},
) {
  try {
    opts.signal?.throwIfAborted();
    const platform = detectRemoteType(repoRoot);
    let prs;

    if (platform === "gitlab") {
      let mrs = [];
      const argsList = [glabMrListArgs(), glabMrListArgsLegacy()];
      for (const args of argsList) {
        const res = await spawnAsync("glab", args, {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 15000,
          signal: opts.signal,
        });
        throwIfAborted(res);
        if (res.status === 0 && res.stdout) {
          try {
            const parsed = JSON.parse(res.stdout);
            mrs = Array.isArray(parsed) ? parsed : [];
            break;
          } catch {
            continue;
          }
        }
        const stderr = (res.stderr || "").trim();
        const isUnknownFlag = isGlabMrListFormatMismatchStderr(stderr);
        if (!isUnknownFlag && log) {
          log({
            event: "open_prs_fetch_failed",
            error: stderr || "glab failed",
          });
          return [];
        }
      }
      if (mrs.length === 0) {
        mrs = await fetchMergeRequestsViaApi(repoRoot, log, opts);
      }
      prs = mrs.map((mr) => ({
        branch: mr.source_branch,
        id: `!${mr.iid}`,
        title: mr.title || "",
        fetchRef: `refs/merge-requests/${mr.iid}/head`,
      }));
    } else {
      const res = await spawnAsync(
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
        {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 15000,
          signal: opts.signal,
        },
      );
      throwIfAborted(res);
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
      const fetchRes = await spawnAsync(
        "git",
        ["fetch", "origin", `${pr.fetchRef}:${localRef}`],
        {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10000,
          signal: opts.signal,
        },
      );
      throwIfAborted(fetchRes);
      if (fetchRes.status !== 0) continue;
      const stat = await spawnAsync(
        "git",
        ["diff", "--stat", `${defaultBranch}...${localRef}`],
        {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10000,
          signal: opts.signal,
        },
      );
      throwIfAborted(stat);
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
    if (err?.code === "ABORT_ERR" || err?.name === "AbortError") throw err;
    if (log) {
      log({ event: "open_prs_fetch_failed", error: err.message });
    }
    return [];
  }
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
export async function ensureCleanLoopStart(
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
    const validKeys = new Set();
    const normRepo = (p) => (p ?? ".").trim() || ".";
    for (const i of opts.issues) {
      validKeys.add(backupKeyFor(i));
      if (normRepo(i.repo_path) !== ".") {
        validKeys.add(backupKeyFor({ ...i, repo_path: "." }));
      }
    }
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
  const branchRes = await spawnAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      signal: opts.signal,
    },
  );
  throwIfAborted(branchRes);
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
    const wipStatus = await spawnAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      signal: opts.signal,
    });
    throwIfAborted(wipStatus);
    const hasDirty = !!(wipStatus.stdout || "").trim();

    if (hasDirty && knownBranches.has(currentBranch)) {
      // Agent-managed branch from a prior run: preserve uncommitted WIP
      const addRes = await spawnAsync("git", ["add", "-A"], {
        cwd: repoRoot,
        encoding: "utf8",
        signal: opts.signal,
      });
      throwIfAborted(addRes);
      if (addRes.status !== 0) {
        throw new Error(
          `Loop startup cleanup failed: git add failed: ${(addRes.stderr || "").trim().slice(0, 200)}`,
        );
      }
      const commitRes = await spawnAsync(
        "git",
        ["commit", "-m", `wip: interrupted work on ${currentBranch}`],
        { cwd: repoRoot, encoding: "utf8", signal: opts.signal },
      );
      throwIfAborted(commitRes);
      if (commitRes.status === 0) {
        cleaned.wipCommitted = true;
      } else {
        throw new Error(
          `Loop startup cleanup failed: could not preserve WIP on ${currentBranch} (commit failed): ${(commitRes.stderr || "").trim().slice(0, 150)}`,
        );
      }
    } else if (hasDirty) {
      const discardOk = await discardWorktreeChanges(repoRoot, {
        signal: opts.signal,
      });
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

    const coRes = await spawnAsync("git", ["checkout", defaultBranch], {
      cwd: repoRoot,
      encoding: "utf8",
      signal: opts.signal,
    });
    throwIfAborted(coRes);
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
  const status = await spawnAsync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    signal: opts.signal,
  });
  throwIfAborted(status);
  const dirtyLines = (status.stdout || "")
    .split("\n")
    .filter((l) => l.trim() && !l.slice(3).startsWith(".coder/"));
  if (dirtyLines.length > 0) {
    const ok = await discardWorktreeChanges(repoRoot, { signal: opts.signal });
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
 * Reset workspace for next issue in autonomous loop.
 */
export async function resetForNextIssue(
  workspaceDir,
  repoPath,
  { destructiveReset = false, issueStatus = "completed", signal } = {},
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
    const preStatus = await spawnAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      signal,
    });
    throwIfAborted(preStatus);
    const hasDirtyFiles = !!(preStatus.stdout || "").trim();

    if (
      hasDirtyFiles &&
      (issueStatus === "failed" || issueStatus === "skipped")
    ) {
      // Preserve partial work on the issue branch for failed/skipped issues.
      signal?.throwIfAborted();
      const addRes = await spawnAsync("git", ["add", "-A"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      throwIfAborted(addRes);
      if (addRes.status !== 0) {
        throw new Error(
          `resetForNextIssue: git add failed: ${(addRes.stderr || "").trim().slice(0, 200)}`,
        );
      }
      signal?.throwIfAborted();
      const commitRes = await spawnAsync(
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
      signal?.throwIfAborted();
      if (!(await discardWorktreeChanges(repoRoot, { signal }))) {
        throw new Error(
          "resetForNextIssue: could not discard worktree changes",
        );
      }
    }

    const defaultBranch = await detectDefaultBranch(repoRoot, { signal });
    signal?.throwIfAborted();
    const checkoutRes = await spawnAsync("git", ["checkout", defaultBranch], {
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
    signal?.throwIfAborted();
    const cleanRes = await spawnAsync(
      "git",
      ["clean", "-fd", "--exclude=.coder/"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
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
      const lsRes = await spawnAsync("git", ["ls-files"], {
        cwd: repoRoot,
        encoding: "utf8",
        signal,
      });
      throwIfAborted(lsRes);
      const hasTrackedFiles = !!(lsRes.stdout || "").trim();
      if (hasTrackedFiles) {
        signal?.throwIfAborted();
        const restoreRes = await spawnAsync(
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
