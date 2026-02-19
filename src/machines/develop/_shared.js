import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  extractGeminiPayloadJson,
  extractJson,
  formatCommandFailure,
} from "../../helpers.js";

export const ISSUE_FILE = "ISSUE.md";
export const PLAN_FILE = "PLAN.md";
export const CRITIQUE_FILE = "PLANREVIEW.md";

export function artifactPaths(artifactsDir) {
  return {
    issue: path.join(artifactsDir, ISSUE_FILE),
    plan: path.join(artifactsDir, PLAN_FILE),
    critique: path.join(artifactsDir, CRITIQUE_FILE),
  };
}

export function ensureBranch(repoRoot, branch) {
  if (!branch) throw new Error("No branch set. Run issue-draft first.");

  const current = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (current.status !== 0)
    throw new Error("Failed to determine current git branch.");

  const currentBranch = (current.stdout || "").trim();
  if (currentBranch === branch) return;

  const checkout = spawnSync("git", ["checkout", branch], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (checkout.status === 0) return;

  const create = spawnSync("git", ["checkout", "-b", branch], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (create.status !== 0) {
    throw new Error(`Failed to create branch ${branch}: ${create.stderr}`);
  }
}

export async function ensureGitignore(workspaceDir) {
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  let giContent = (await access(gitignorePath).then(() => true).catch(() => false))
    ? await readFile(gitignorePath, "utf8")
    : "";
  const giLines = giContent.split("\n").map((l) => l.trim());
  const needed = [".coder/", ".gemini/", ".coder/logs/"];
  const missing = needed.filter((rule) => !giLines.includes(rule));
  if (missing.length > 0) {
    const suffix = giContent.endsWith("\n") || giContent === "" ? "" : "\n";
    giContent += `${suffix}# coder workflow artifacts\n${missing.join("\n")}\n`;
    await writeFile(gitignorePath, giContent);
  }

  const artifacts = [ISSUE_FILE, PLAN_FILE, CRITIQUE_FILE];
  const geminiIgnorePath = path.join(workspaceDir, ".geminiignore");
  const gmContent = (await access(geminiIgnorePath).then(() => true).catch(() => false))
    ? await readFile(geminiIgnorePath, "utf8")
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
    await writeFile(
      geminiIgnorePath,
      gmContent +
        `${suffix}# coder workflow artifacts must remain readable\n${missingGeminiRules.join("\n")}\n`,
    );
  }
}

export function resolveRepoRoot(workspaceDir, repoPath) {
  return path.resolve(workspaceDir, repoPath || ".");
}

export function normalizeRepoPath(workspaceDir, repoPath) {
  const raw = (repoPath || ".").trim();
  if (!raw) return ".";
  const abs = path.resolve(workspaceDir, raw);
  const rel = path.relative(workspaceDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return ".";
  return rel || ".";
}

export function parseAgentPayload(agentName, stdout) {
  return agentName === "gemini"
    ? extractGeminiPayloadJson(stdout)
    : extractJson(stdout);
}

export async function checkArtifactCollisions(artifactsDir, { force = false } = {}) {
  if (force) return;
  const paths = artifactPaths(artifactsDir);
  const checks = await Promise.all(
    Object.entries(paths).map(async ([k, p]) => {
      const exists = await access(p).then(() => true).catch(() => false);
      return exists ? k : null;
    }),
  );
  const existing = checks.filter(Boolean);
  if (existing.length > 0) {
    throw new Error(
      `Artifact collision: ${existing.join(", ")} already exist in ${artifactsDir}. ` +
        `Remove them or pass force=true to overwrite.`,
    );
  }
}

export function requireExitZero(agentName, label, res) {
  if (res.exitCode !== 0) {
    throw new Error(formatCommandFailure(`${agentName} ${label}`, res));
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

    const push = runGit(["push", "-u", remote, `HEAD:${branch}`]);
    if (push.status !== 0)
      throw new Error(`git push failed: ${push.stderr || push.stdout}`);

    if (log) log({ event: "wip_checkpoint_pushed", branch, remote });
  } catch (err) {
    if (log) log({ event: "wip_checkpoint_failed", error: err.message });
    if (failOnError) throw err;
  }
}
