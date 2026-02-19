import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  gitCleanOrThrow,
  sanitizeIssueMarkdown,
  stripAgentNoise,
} from "../../helpers.js";
import { ScratchpadPersistence } from "../../state/persistence.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import { buildIssueBranchName } from "../../worktrees.js";
import { defineMachine } from "../_base.js";
import {
  artifactPaths,
  checkArtifactCollisions,
  ensureBranch,
  ensureGitignore,
  maybeCheckpointWip,
  normalizeRepoPath,
  requireExitZero,
  resolveRepoRoot,
} from "./_shared.js";

export default defineMachine({
  name: "develop.issue_draft",
  description:
    "Draft ISSUE.md for the selected issue: validate repo, create branch, research codebase, write structured issue spec.",
  inputSchema: z.object({
    issue: z.object({
      source: z.enum(["github", "gitlab", "linear", "local"]),
      id: z.string().min(1),
      title: z.string().min(1),
    }),
    repoPath: z.string().default("."),
    clarifications: z.string().default(""),
    baseBranch: z.string().optional(),
    force: z.boolean().default(false),
  }),

  async execute(input, ctx) {
    await checkArtifactCollisions(ctx.artifactsDir, { force: input.force });

    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};

    // Idempotency: skip if this issue's draft is already on disk
    if (state.steps.wroteIssue && state.selected?.id === input.issue.id) {
      const earlyPaths = artifactPaths(ctx.artifactsDir);
      if (existsSync(earlyPaths.issue)) {
        const onDisk = sanitizeIssueMarkdown(
          readFileSync(earlyPaths.issue, "utf8"),
        );
        if (onDisk.length > 40 && onDisk.trim().startsWith("#")) {
          ctx.log({
            event: "issue_draft_skipped",
            issue: input.issue,
            reason: "already_drafted",
          });
          return { status: "ok", data: { issueMd: onDisk + "\n" } };
        }
      }
    }

    // Stale workflow check
    if (state.selected && !input.force) {
      const active = state.selected;
      if (
        active.source !== input.issue.source ||
        active.id !== input.issue.id
      ) {
        throw new Error(
          `Stale workflow: state has issue ${active.source}#${active.id} ("${active.title}") ` +
            `but you are trying to start ${input.issue.source}#${input.issue.id} ("${input.issue.title}"). ` +
            `Remove .coder/state.json and artifacts, or pass force=true.`,
        );
      }
    }

    // Store issue and repo path
    state.selected = input.issue;
    const repoPath = normalizeRepoPath(ctx.workspaceDir, input.repoPath);
    state.repoPath = repoPath;
    state.baseBranch = input.baseBranch || null;
    state.branch = buildIssueBranchName(input.issue);
    saveState(ctx.workspaceDir, state);

    // Update pool repo root
    const repoRoot = resolveRepoRoot(ctx.workspaceDir, repoPath);
    ctx.agentPool.setRepoRoot(repoRoot);

    if (!(await access(repoRoot).then(() => true).catch(() => false)))
      throw new Error(`Repo root does not exist: ${repoRoot}`);

    const isGit = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (isGit.status !== 0)
      throw new Error(`Not a git repository: ${repoRoot}`);

    // Set up scratchpad
    const scratchpad = new ScratchpadPersistence({
      workspaceDir: ctx.workspaceDir,
      scratchpadDir: ctx.scratchpadDir,
      sqlitePath: path.join(ctx.workspaceDir, ".coder", "scratchpad.db"),
      sqliteSync: ctx.config.workflow.scratchpad.sqliteSync,
    });
    const scratchpadPath = scratchpad.issueScratchpadPath(input.issue);
    scratchpad.restoreFromSqlite(scratchpadPath);
    if (!(await access(scratchpadPath).then(() => true).catch(() => false))) {
      const header = [
        `# Scratchpad for ${input.issue.source}#${input.issue.id}`,
        "",
        `- title: ${input.issue.title}`,
        `- repo_root: ${repoRoot}`,
        "",
        "Use this file for iterative issue research notes and feedback loops.",
        "",
      ].join("\n");
      await writeFile(scratchpadPath, header, "utf8");
    }
    scratchpad.appendSection(scratchpadPath, "Input", [
      `- clarifications: ${(input.clarifications || "(none provided)").trim()}`,
    ]);
    state.scratchpadPath = path.relative(ctx.workspaceDir, scratchpadPath);
    saveState(ctx.workspaceDir, state);

    // Verify clean repo, then set up ignore files
    gitCleanOrThrow(repoRoot);
    await ensureGitignore(ctx.workspaceDir);
    state.steps.verifiedCleanRepo = true;
    saveState(ctx.workspaceDir, state);

    // Optional base branch checkout for stacked PRs
    if (state.baseBranch) {
      const baseCheckout = spawnSync("git", ["checkout", state.baseBranch], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (baseCheckout.status !== 0) {
        throw new Error(
          `Failed to checkout base branch ${state.baseBranch}: ${baseCheckout.stderr || baseCheckout.stdout}`,
        );
      }
    }

    ensureBranch(repoRoot, state.branch);

    // Draft ISSUE.md
    ctx.log({ event: "step2_draft_issue", issue: input.issue });
    const paths = artifactPaths(ctx.artifactsDir);
    const { agentName, agent } = ctx.agentPool.getAgent("issueSelector", {
      scope: "workspace",
    });

    const issuePrompt = `Draft an ISSUE.md for the chosen issue. Use the local codebase in ${repoRoot} as ground truth.

Chosen issue:
- source: ${input.issue.source}
- id: ${input.issue.id}
- title: ${input.issue.title}
- repo_root: ${repoRoot}

Clarifications from user:
${input.clarifications || "(none provided)"}

Scratchpad for iterative notes:
- path: ${scratchpadPath}
- append hypotheses, constraints, open questions, and feedback between drafting passes
- keep temporary notes in this scratchpad (not in \`issues/\`)

Output ONLY markdown suitable for writing directly to ISSUE.md.

## Required Sections (in order)
1. **Metadata**: Source, Issue ID, Repo Root (relative path)
2. **Problem**: What's wrong or missing — reference specific files/functions
3. **Changes**: Exactly which files need to change and how
4. **Verification**: A concrete shell command or test to prove the fix works (e.g. \`npm test\`, \`node -e "..."\`, \`curl ...\`). This is critical — downstream agents use this to close the feedback loop.
5. **Out of Scope**: What this does NOT include
`;

    const res = await agent.execute(issuePrompt, {
      timeoutMs: 1000 * 60 * 10,
    });
    requireExitZero(agentName, "ISSUE.md drafting failed", res);

    // Prefer on-disk file if agent wrote it via tool use
    let issueMd;
    if (await access(paths.issue).then(() => true).catch(() => false)) {
      const onDisk = sanitizeIssueMarkdown(await readFile(paths.issue, "utf8"));
      if (onDisk.length > 40 && onDisk.startsWith("#")) {
        issueMd = onDisk + "\n";
        if (issueMd !== await readFile(paths.issue, "utf8")) {
          await writeFile(paths.issue, issueMd);
        }
      }
    }
    if (!issueMd) {
      issueMd = sanitizeIssueMarkdown(res.stdout.trimEnd()) + "\n";
      if (!issueMd.trim().startsWith("#")) {
        const fallback = stripAgentNoise(res.stdout || "", {
          dropLeadingOnly: true,
        }).trim();
        if (!fallback.startsWith("#")) {
          const rawPreview = (res.stdout || "")
            .slice(0, 300)
            .replace(/\n/g, "\\n");
          throw new Error(
            `${agentName} draft output did not contain valid ISSUE.md markdown. ` +
              `Raw output preview: "${rawPreview}"`,
          );
        }
        issueMd = fallback + "\n";
      }
      await writeFile(paths.issue, issueMd);
    }

    state.steps.wroteIssue = true;
    saveState(ctx.workspaceDir, state);

    scratchpad.appendSection(scratchpadPath, "Drafted ISSUE.md", [
      `- issue_artifact: ${paths.issue}`,
      "- status: complete",
    ]);
    maybeCheckpointWip(
      repoRoot,
      state.branch,
      ctx.config.workflow.wip,
      ctx.log,
    );

    return { status: "ok", data: { issueMd } };
  },
});
