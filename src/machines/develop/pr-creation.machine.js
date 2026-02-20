import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  buildPrBodyFromIssue,
  computeGitWorktreeFingerprint,
  detectRemoteType,
  runPpcommit,
  stripAgentNoise,
} from "../../helpers.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import {
  buildSemanticBranchName,
  normalizeBranchType,
} from "../../worktrees.js";
import { defineMachine } from "../_base.js";
import { artifactPaths, ensureBranch, resolveRepoRoot } from "./_shared.js";

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...opts, stdio: "pipe" });
    let stdout = "",
      stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => resolve({ status: code, stdout, stderr }));
    proc.on("error", (err) =>
      resolve({ status: 1, stdout: "", stderr: err.message }),
    );
  });
}

export default defineMachine({
  name: "develop.pr_creation",
  description:
    "Create pull request or merge request: commit changes, push to remote, create PR/MR via gh/glab CLI.",
  inputSchema: z.object({
    type: z.string().default("feat"),
    semanticName: z.string().default(""),
    title: z.string().default(""),
    description: z.string().default(""),
    base: z.string().default(""),
  }),

  async execute(input, ctx) {
    const state = await loadState(ctx.workspaceDir);
    state.steps ||= {};

    if (!state.steps.testsPassed) {
      throw new Error(
        "Precondition failed: tests have not passed. Run develop.quality_review first.",
      );
    }
    if (!state.steps.ppcommitClean) {
      throw new Error(
        "Precondition failed: ppcommit has not passed. Run develop.quality_review first.",
      );
    }

    // Early return if PR already created
    if (state.steps.prCreated && state.prUrl) {
      return {
        status: "ok",
        data: {
          prUrl: state.prUrl,
          branch: state.prBranch || state.branch,
          base: state.prBase || state.baseBranch || null,
        },
      };
    }

    const repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath);
    ensureBranch(repoRoot, state.branch);
    const normalizedType = normalizeBranchType(input.type, {
      fallback: "feat",
    });

    // Worktree drift detection
    const currentFp = computeGitWorktreeFingerprint(repoRoot);
    if (state.reviewFingerprint && state.reviewFingerprint !== currentFp) {
      throw new Error(
        "Worktree changed since quality_review completed. " +
          "Re-run develop.quality_review before creating a PR.",
      );
    }

    // Defense-in-depth ppcommit check
    const ppNow = await runPpcommit(repoRoot, ctx.config.ppcommit);
    if (ppNow.exitCode !== 0) {
      throw new Error(
        `ppcommit reports issues prior to PR creation:\n${ppNow.stdout || ppNow.stderr}`,
      );
    }

    // Commit uncommitted changes
    const status = await spawnAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const hasChanges = (status.stdout || "").trim().length > 0;
    if (hasChanges) {
      const add = await spawnAsync("git", ["add", "-u"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);

      const issueTitle = state.selected?.title || "coder workflow changes";
      const commitMsg = `${normalizedType}: ${issueTitle}`;
      const commit = await spawnAsync("git", ["commit", "-m", commitMsg], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (commit.status !== 0)
        throw new Error(`git commit failed: ${commit.stderr}`);
      ctx.log({ event: "committed", message: commitMsg });
    }

    // Determine remote branch
    const remoteBranch = input.semanticName
      ? buildSemanticBranchName({
          type: normalizedType,
          semanticName: input.semanticName,
          issue: state.selected || null,
        })
      : state.branch;
    const baseBranch = input.base || state.baseBranch || null;

    // Push to remote
    const push = await spawnAsync(
      "git",
      ["push", "-u", "origin", `HEAD:${remoteBranch}`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (push.status !== 0) throw new Error(`git push failed: ${push.stderr}`);

    // Build PR body
    let body = input.description || "";
    if (!body) {
      const paths = artifactPaths(ctx.artifactsDir);
      if (
        await access(paths.issue)
          .then(() => true)
          .catch(() => false)
      ) {
        const issueMd = await readFile(paths.issue, "utf8");
        body = buildPrBodyFromIssue(issueMd, { maxLines: 10 });
      }
    }
    if (!body) {
      body = `## Summary\nAutomated changes for: ${state.selected?.title || "workflow issue"}`;
    }
    body = stripAgentNoise(body).trim();

    // Append issue link
    if (state.selected) {
      const { source, id } = state.selected;
      if (source === "github" || source === "gitlab") {
        const normalized = String(id).trim();
        body += normalized.includes("#")
          ? `\n\nCloses ${normalized}`
          : `\n\nCloses #${normalized}`;
      } else if (source === "linear") {
        body += `\n\nResolves ${id}`;
      }
    }

    const prTitle =
      input.title ||
      `${normalizedType}: ${state.selected?.title || input.semanticName || state.branch}`;

    // Create PR/MR
    const source = state.selected?.source;
    const useGitlab =
      source === "gitlab" ||
      (source === "local" && detectRemoteType(repoRoot) === "gitlab");

    let pr;
    let cliLabel;
    if (useGitlab) {
      const mrArgs = [
        "mr",
        "create",
        "--source-branch",
        remoteBranch,
        "--title",
        prTitle,
        "--description",
        body,
        "--yes",
      ];
      if (baseBranch) mrArgs.push("--target-branch", baseBranch);
      pr = await spawnAsync("glab", mrArgs, {
        cwd: repoRoot,
        encoding: "utf8",
      });
      cliLabel = "glab mr create";
    } else {
      const prArgs = [
        "pr",
        "create",
        "--head",
        remoteBranch,
        "--title",
        prTitle,
        "--body",
        body,
      ];
      if (baseBranch) prArgs.push("--base", baseBranch);
      pr = await spawnAsync("gh", prArgs, { cwd: repoRoot, encoding: "utf8" });
      cliLabel = "gh pr create";
    }
    if (pr.status !== 0)
      throw new Error(`${cliLabel} failed: ${pr.stderr || pr.stdout}`);

    const raw = (pr.stdout || "").trim();
    const lines = raw.split("\n").filter((l) => l.trim());
    const prUrl = lines.find((l) => l.startsWith("http")) || lines.pop() || "";
    if (!prUrl || !prUrl.startsWith("http")) {
      throw new Error(
        `${cliLabel} did not return a URL. Output:\n${raw || "(empty)"}`,
      );
    }

    state.prUrl = prUrl;
    state.prBranch = remoteBranch;
    state.prBase = baseBranch;
    state.steps.prCreated = true;
    await saveState(ctx.workspaceDir, state);

    ctx.log({
      event: "pr_created",
      prUrl,
      branch: remoteBranch,
      base: baseBranch,
    });
    return {
      status: "ok",
      data: { prUrl, branch: remoteBranch, base: baseBranch },
    };
  },
});
