import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnAsync, throwIfAborted } from "../../helpers.js";

export {
  parseAgentPayload,
  requireExitZero,
} from "../../core/agent-payload.js";

import {
  CRITIQUE_FILE,
  ISSUE_FILE,
  PLAN_FILE,
  RCA_FILE,
  REVIEW_FINDINGS_FILE,
} from "../../core/coder-paths.js";

export { CRITIQUE_FILE, ISSUE_FILE, PLAN_FILE, RCA_FILE, REVIEW_FINDINGS_FILE };

export function artifactPaths(artifactsDir) {
  return {
    issue: path.join(artifactsDir, ISSUE_FILE),
    plan: path.join(artifactsDir, PLAN_FILE),
    critique: path.join(artifactsDir, CRITIQUE_FILE),
    reviewFindings: path.join(artifactsDir, REVIEW_FINDINGS_FILE),
    rca: path.join(artifactsDir, RCA_FILE),
  };
}

/**
 * Per-step CLI agent options: wall-clock timeout only, hang detection off.
 * Prevents agents.retry.hangTimeoutMs (default 5m) from killing long silent
 * planning/plan-review while workflow.timeouts.* allows much longer.
 *
 * @param {number} timeoutMs
 * @returns {{ timeoutMs: number, hangTimeoutMs: number }}
 */
export function buildStepCliOpts(timeoutMs) {
  return { timeoutMs, hangTimeoutMs: 0 };
}

export async function ensureBranch(
  repoRoot,
  branch,
  { baseBranch, forceRecreate, signal } = {},
) {
  if (!branch) throw new Error("No branch set. Run issue-draft first.");

  const current = await spawnAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      signal,
    },
  );
  throwIfAborted(current);
  if (current.status !== 0)
    throw new Error("Failed to determine current git branch.");

  const currentBranch = (current.stdout || "").trim();

  // Force-recreate: delete existing branch and recreate from baseBranch or HEAD
  if (forceRecreate) {
    const verify = await spawnAsync("git", ["rev-parse", "--verify", branch], {
      cwd: repoRoot,
      encoding: "utf8",
      signal,
    });
    throwIfAborted(verify);
    if (verify.status === 0) {
      // Switch off the branch before deleting it
      if (currentBranch === branch) {
        const detach = await spawnAsync("git", ["checkout", "--detach"], {
          cwd: repoRoot,
          encoding: "utf8",
          signal,
        });
        throwIfAborted(detach);
      }
      const del = await spawnAsync("git", ["branch", "-D", branch], {
        cwd: repoRoot,
        encoding: "utf8",
        signal,
      });
      throwIfAborted(del);
    }
    const startPoint = baseBranch || "HEAD";
    const create = await spawnAsync(
      "git",
      ["checkout", "-b", branch, startPoint],
      {
        cwd: repoRoot,
        encoding: "utf8",
        signal,
      },
    );
    throwIfAborted(create);
    if (create.status !== 0) {
      throw new Error(`Failed to recreate branch ${branch}: ${create.stderr}`);
    }
    return;
  }

  if (currentBranch === branch) return;

  const checkout = await spawnAsync("git", ["checkout", branch], {
    cwd: repoRoot,
    encoding: "utf8",
    signal,
  });
  throwIfAborted(checkout);
  if (checkout.status === 0) return;

  // Create new branch with optional baseBranch as start-point
  const createArgs = baseBranch
    ? ["checkout", "-b", branch, baseBranch]
    : ["checkout", "-b", branch];
  const create = await spawnAsync("git", createArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    signal,
  });
  throwIfAborted(create);
  if (create.status !== 0) {
    throw new Error(`Failed to create branch ${branch}: ${create.stderr}`);
  }
}

export function ensureGitignore(workspaceDir) {
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  let giContent = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  const giLines = giContent.split("\n").map((l) => l.trim());
  const needed = [".coder/", ".gemini/", ".coder/logs/"];
  const missing = needed.filter((rule) => !giLines.includes(rule));
  if (missing.length > 0) {
    const suffix = giContent.endsWith("\n") || giContent === "" ? "" : "\n";
    giContent += `${suffix}# coder workflow artifacts\n${missing.join("\n")}\n`;
    writeFileSync(gitignorePath, giContent);
  }

  const artifacts = [
    ISSUE_FILE,
    PLAN_FILE,
    CRITIQUE_FILE,
    REVIEW_FINDINGS_FILE,
  ];
  const geminiIgnorePath = path.join(workspaceDir, ".geminiignore");
  const gmContent = existsSync(geminiIgnorePath)
    ? readFileSync(geminiIgnorePath, "utf8")
    : "";
  const keepRules = [
    "!.coder/",
    "!.coder/artifacts/",
    ...artifacts.map((name) => `!.coder/artifacts/${name}`),
    "!.coder/scratchpad/",
    "!.coder/scratchpad/**",
  ];
  const missingGeminiRules = keepRules.filter(
    (rule) => !gmContent.split("\n").some((line) => line.trim() === rule),
  );
  if (missingGeminiRules.length > 0) {
    const suffix = gmContent.endsWith("\n") || gmContent === "" ? "" : "\n";
    writeFileSync(
      geminiIgnorePath,
      gmContent +
        `${suffix}# coder workflow artifacts must remain readable\n${missingGeminiRules.join("\n")}\n`,
    );
  }
}

export function resolveRepoRoot(workspaceDir, repoPath) {
  const resolved = path.resolve(workspaceDir, repoPath || ".");
  try {
    const stat = statSync(resolved);
    if (stat.isFile()) {
      const dir = path.dirname(resolved);
      process.stderr.write(
        `[coder] resolveRepoRoot: corrected file path to directory: ${resolved} → ${dir}\n`,
      );
      return dir;
    }
  } catch {
    // Path may not exist yet; use as-is
  }
  return resolved;
}

export function normalizeRepoPath(workspaceDir, repoPath) {
  const raw = (repoPath || ".").trim();
  if (!raw) return ".";
  const abs = path.resolve(workspaceDir, raw);
  const rel = path.relative(workspaceDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return ".";
  return rel || ".";
}

export function checkArtifactCollisions(artifactsDir, { force = false } = {}) {
  if (force) return;
  const paths = artifactPaths(artifactsDir);
  const existing = Object.entries(paths)
    .filter(([, p]) => existsSync(p))
    .map(([k]) => k);
  if (existing.length > 0) {
    throw new Error(
      `Artifact collision: ${existing.join(", ")} already exist in ${artifactsDir}. ` +
        `Remove them or pass force=true to overwrite.`,
    );
  }
}

export function maybeCheckpointWip(repoRoot, branch, wipConfig, log) {
  if (!wipConfig?.push) return;
  if (!branch || !repoRoot) return;

  const remote = wipConfig.remote || "origin";
  const autoCommit = wipConfig.autoCommit !== false;
  const includeUntracked = wipConfig.includeUntracked === true;
  const failOnError = wipConfig.failOnError === true;

  const runGit = (args) =>
    spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });

  try {
    const remoteCheck = runGit(["remote", "get-url", remote]);
    if (remoteCheck.status !== 0) return;

    if (autoCommit) {
      const status = runGit(["status", "--porcelain"]);
      if (status.status !== 0) throw new Error("git status failed");
      const rawLines = (status.stdout || "").trim().split("\n").filter(Boolean);
      const hasChanges = includeUntracked
        ? rawLines.length > 0
        : rawLines.some((l) => !l.startsWith("?? "));
      if (hasChanges) {
        const add = includeUntracked
          ? runGit(["add", "-A"])
          : runGit(["add", "-u"]);
        if (add.status !== 0)
          throw new Error(`git add failed: ${add.stderr || add.stdout}`);

        const msg = "chore(wip): checkpoint [skip ci]";
        const commit = runGit(["commit", "--no-verify", "-m", msg]);
        const commitOut = `${commit.stdout || ""}\n${commit.stderr || ""}`;
        if (
          commit.status !== 0 &&
          !/nothing to commit|no changes added/i.test(commitOut)
        ) {
          throw new Error(`git commit failed: ${commitOut.trim()}`);
        }
      }
    }

    const push = runGit([
      "push",
      "--force-with-lease",
      "-u",
      remote,
      `HEAD:${branch}`,
    ]);
    if (push.status !== 0)
      throw new Error(`git push failed: ${push.stderr || push.stdout}`);

    if (log) log({ event: "wip_checkpoint_pushed", branch, remote });
  } catch (err) {
    if (log) log({ event: "wip_checkpoint_failed", error: err.message });
    if (failOnError) throw err;
  }
}
