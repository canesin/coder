import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function sanitizeBranchForRef(branch) {
  const normalized = branch
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z._/-]/g, "-")
    .replace(/-+/g, "-");

  const parts = normalized
    .split("/")
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

export function normalizeBranchType(type, { fallback = "feat" } = {}) {
  const normalized = String(type || "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || fallback;
}

function sourceShortCode(source) {
  if (source === "github") return "GH";
  if (source === "linear") return "LN";
  if (source === "gitlab") return "GL";
  const normalized = String(source || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, "");
  return normalized.slice(0, 2) || "IS";
}

function issueToken(id) {
  const normalized = String(id || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "0";
}

function semanticWords(text, { maxWords = 4, fallback = "work" } = {}) {
  const words = (
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  )
    .slice(0, Math.max(1, maxWords))
    .join("-");
  return words || fallback;
}

export function inferBranchTypeFromIssue(issue) {
  const haystack = `${issue?.title || ""} ${issue?.id || ""}`.toLowerCase();
  if (
    /\b(bug|fix|regress|regression|failure|failing|broken|error|crash|hotfix)\b/.test(
      haystack,
    )
  ) {
    return "bug";
  }
  return "feat";
}

export function buildIssueBranchName(issue, opts = {}) {
  const type = normalizeBranchType(
    opts.type || inferBranchTypeFromIssue(issue),
    {
      fallback: "feat",
    },
  );
  const slug = semanticWords(issue?.title, {
    maxWords: opts.maxWords || 4,
    fallback: "work",
  });
  const sourceCode = sourceShortCode(issue?.source);
  const idToken = issueToken(issue?.id);
  return sanitizeBranchForRef(`${type}/${slug}_${sourceCode}_${idToken}`);
}

export function buildSemanticBranchName({
  type = "feat",
  semanticName = "",
  issue = null,
  maxWords = 4,
} = {}) {
  const normalizedType = normalizeBranchType(type, { fallback: "feat" });
  const slug = semanticWords(semanticName || issue?.title, {
    maxWords,
    fallback: "work",
  });
  const sourceCode = sourceShortCode(issue?.source);
  const idToken = issueToken(issue?.id);
  return sanitizeBranchForRef(
    `${normalizedType}/${slug}_${sourceCode}_${idToken}`,
  );
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
    throw new Error(
      `Failed to create worktree for ${safeBranch}: ${res.stderr || res.stdout}`,
    );
  }
  return wtPath;
}

export function removeWorktree(repoRoot, wtPath) {
  const res = spawnSync("git", ["worktree", "remove", "--force", wtPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      `Failed to remove worktree ${wtPath}: ${res.stderr || res.stdout}`,
    );
  }
}
