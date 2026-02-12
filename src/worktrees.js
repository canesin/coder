import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function sanitizeBranchForRef(branch) {
  const normalized = branch
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z._/-]/g, "-")
    .replace(/-+/g, "-");

  const parts = normalized.split("/")
    .filter(Boolean)
    .map((segment) => {
      let s = segment.replace(/\.\.+/g, "-");
      s = s.replace(/^\.+/, "").replace(/\.+$/, "");
      s = s.replace(/\.lock$/i, "-lock");
      if (!s || s === "." || s === "..") return "-";
      return s;
    });

  return parts.join("/") || "branch";
}

export function worktreePath(worktreesRoot, branch) {
  const root = path.resolve(worktreesRoot);
  const safeBranch = sanitizeBranchForRef(branch);
  const wtPath = path.resolve(root, safeBranch);
  if (wtPath !== root && !wtPath.startsWith(root + path.sep)) {
    throw new Error(`Unsafe worktree path derived from branch: ${branch}`);
  }
  return wtPath;
}

export function ensureWorktree(repoRoot, worktreesRoot, branch) {
  const safeBranch = sanitizeBranchForRef(branch);
  const wtPath = worktreePath(worktreesRoot, safeBranch);
  if (existsSync(wtPath)) return wtPath;

  const res = spawnSync("git", ["worktree", "add", "-B", safeBranch, wtPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Failed to create worktree for ${safeBranch}: ${res.stderr || res.stdout}`);
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
