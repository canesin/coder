import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  buildPrBodyFromIssue,
  computeGitWorktreeFingerprint,
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

export default defineMachine({
  name: "develop.pr_creation",
  description:
    "Create pull request: commit changes, push to remote, create PR via gh CLI.",
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
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const hasChanges = (status.stdout || "").trim().length > 0;
    if (hasChanges) {
      const add = spawnSync("git", ["add", "."], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);

      const issueTitle = state.selected?.title || "coder workflow changes";
      const commitMsg = `${normalizedType}: ${issueTitle}`;
      const commit = spawnSync("git", ["commit", "-m", commitMsg], {
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

    // Detect GitLab remote
    const remoteResult = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const isGitLab = /gitlab/i.test((remoteResult.stdout || "").trim());

    // Push to remote
    const push = spawnSync(
      "git",
      ["push", "--force-with-lease", "-u", "origin", `HEAD:${remoteBranch}`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (push.status !== 0) throw new Error(`git push failed: ${push.stderr}`);

    // Build PR body
    let body = input.description || "";
    if (!body) {
      const paths = artifactPaths(ctx.artifactsDir);
      if (existsSync(paths.issue)) {
        const issueMd = readFileSync(paths.issue, "utf8");
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
      if (source === "github") {
        const normalized = String(id).trim();
        body += normalized.includes("#")
          ? `\n\nCloses ${normalized}`
          : `\n\nCloses #${normalized}`;
      } else if (source === "linear") {
        body += `\n\nResolves ${id}`;
      } else if (source === "gitlab") {
        const normalized = String(id).trim();
        body += normalized.includes("#")
          ? `\n\nCloses ${normalized}`
          : `\n\nCloses #${normalized}`;
      }
    }

    const prTitle =
      input.title ||
      `${normalizedType}: ${state.selected?.title || input.semanticName || state.branch}`;

    // Create PR or MR depending on the hosting platform
    let prUrl;
    if (isGitLab) {
      const mrArgs = [
        "mr",
        "create",
        "--title",
        prTitle,
        "--description",
        body,
        "--source-branch",
        remoteBranch,
        "--yes",
      ];
      if (baseBranch) mrArgs.push("--target-branch", baseBranch);
      const mr = spawnSync("glab", mrArgs, { cwd: repoRoot, encoding: "utf8" });
      if (mr.status !== 0)
        throw new Error(`glab mr create failed: ${mr.stderr || mr.stdout}`);
      const mrRaw = (mr.stdout || "").trim();
      const mrLines = mrRaw.split("\n").filter((l) => l.trim());
      prUrl = mrLines.find((l) => l.startsWith("http")) || mrLines.pop() || "";
      if (!prUrl || !prUrl.startsWith("http")) {
        throw new Error(
          `glab mr create did not return an MR URL. Output:\n${mrRaw || "(empty)"}`,
        );
      }
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
      const pr = spawnSync("gh", prArgs, { cwd: repoRoot, encoding: "utf8" });
      if (pr.status !== 0)
        throw new Error(`gh pr create failed: ${pr.stderr || pr.stdout}`);
      const raw = (pr.stdout || "").trim();
      const lines = raw.split("\n").filter((l) => l.trim());
      prUrl = lines.find((l) => l.startsWith("http")) || lines.pop() || "";
      if (!prUrl || !prUrl.startsWith("http")) {
        throw new Error(
          `gh pr create did not return a PR URL. Output:\n${raw || "(empty)"}`,
        );
      }
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
