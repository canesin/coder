import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function sanitizeBranchForRef(branch) {
  return branch
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z._/-]/g, "-")
    .replace(/-+/g, "-");
}

export function worktreePath(worktreesRoot, branch) {
  return path.join(worktreesRoot, sanitizeBranchForRef(branch));
}

export function ensureWorktree(repoRoot, worktreesRoot, branch) {
  const wtPath = worktreePath(worktreesRoot, branch);
  if (existsSync(wtPath)) return wtPath;

  const res = spawnSync("git", ["worktree", "add", "-B", branch, wtPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Failed to create worktree for ${branch}: ${res.stderr || res.stdout}`);
  }
  return wtPath;
}

export function removeWorktree(repoRoot, wtPath) {
  const res = spawnSync("git", ["worktree", "remove", "--force", wtPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Failed to remove worktree ${wtPath}: ${res.stderr || res.stdout}`);
  }
}
