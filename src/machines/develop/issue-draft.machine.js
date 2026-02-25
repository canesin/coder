import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Fetch the issue body/description from its source so the agent has full context.
 * Returns null if unavailable or source doesn't support pre-fetching (linear).
 *
 * @param {"github"|"gitlab"|"local"|"linear"} source
 * @param {string} id - Issue ID (e.g. "#42", "!7", "GH-60")
 * @param {string} repoRoot - Repo directory for CLI calls
 * @param {string} localIssuesDir - Resolved path to local issues dir (for "local" source)
 * @returns {string | null}
 */
function fetchIssueBody(source, id, repoRoot, localIssuesDir) {
  if (source === "github") {
    const num = id.replace(/^#/, "");
    const res = spawnSync("gh", ["issue", "view", num, "--json", "body"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    try {
      return JSON.parse(res.stdout).body || null;
    } catch {
      return null;
    }
  }

  if (source === "gitlab") {
    const iid = id.replace(/^[#!]/, "");
    const res = spawnSync("glab", ["issue", "view", iid, "--output", "json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    try {
      return JSON.parse(res.stdout).description || null;
    } catch {
      return null;
    }
  }

  if (source === "local" && localIssuesDir) {
    // Try manifest first to find the file entry for this id
    const manifestPath = path.join(localIssuesDir, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const entry = manifest.issues?.find((e) => e.id === id);
        const file = entry?.file || entry?.filePath;
        if (file) {
          const mdPath = path.isAbsolute(file)
            ? file
            : path.join(localIssuesDir, file);
          if (existsSync(mdPath)) return readFileSync(mdPath, "utf8");
        }
      } catch {
        // fall through to filename heuristic
      }
    }
    // Fallback: look for <id>.md directly
    const mdPath = path.join(localIssuesDir, `${id}.md`);
    if (existsSync(mdPath)) return readFileSync(mdPath, "utf8");
  }

  return null;
}

export default defineMachine({
  name: "develop.issue_draft",
  description:
    "Draft ISSUE.md for the selected issue: validate repo, create branch, research codebase, write structured issue spec.",
  inputSchema: z.object({
    issue: z.object({
      source: z.enum(["github", "linear", "gitlab", "local"]),
      id: z.string().min(1),
      title: z.string().min(1),
    }),
    repoPath: z.string().default("."),
    clarifications: z.string().default(""),
    baseBranch: z.string().optional(),
    force: z.boolean().default(false),
  }),

  async execute(input, ctx) {
    checkArtifactCollisions(ctx.artifactsDir, { force: input.force });

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

    if (!existsSync(repoRoot))
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
    if (!existsSync(scratchpadPath)) {
      const header = [
        `# Scratchpad for ${input.issue.source}#${input.issue.id}`,
        "",
        `- title: ${input.issue.title}`,
        `- repo_root: ${repoRoot}`,
        "",
        "Use this file for iterative issue research notes and feedback loops.",
        "",
      ].join("\n");
      mkdirSync(path.dirname(scratchpadPath), { recursive: true });
      writeFileSync(scratchpadPath, header, "utf8");
    }
    scratchpad.appendSection(scratchpadPath, "Input", [
      `- clarifications: ${(input.clarifications || "(none provided)").trim()}`,
    ]);
    state.scratchpadPath = path.relative(ctx.workspaceDir, scratchpadPath);
    saveState(ctx.workspaceDir, state);

    // Verify clean repo, then set up ignore files
    gitCleanOrThrow(repoRoot);
    ensureGitignore(ctx.workspaceDir);
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

    const rawLocalIssuesDir = ctx.config.workflow.localIssuesDir;
    const resolvedLocalIssuesDir = rawLocalIssuesDir
      ? path.isAbsolute(rawLocalIssuesDir)
        ? rawLocalIssuesDir
        : path.resolve(ctx.workspaceDir, rawLocalIssuesDir)
      : null;

    const issueBody = fetchIssueBody(
      input.issue.source,
      input.issue.id,
      repoRoot,
      resolvedLocalIssuesDir,
    );

    const issueBodySection = issueBody
      ? `\nIssue description (from ${input.issue.source}):\n${issueBody}\n`
      : input.issue.source === "linear"
        ? "\nFetch the full issue description via Linear MCP using the issue id above.\n"
        : "";

    const issuePrompt = `Draft an ISSUE.md for the chosen issue. Use the local codebase in ${repoRoot} as ground truth.

Chosen issue:
- source: ${input.issue.source}
- id: ${input.issue.id}
- title: ${input.issue.title}
- repo_root: ${repoRoot}
${issueBodySection}
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
3. **Requirements**: Behavioral requirements using EARS Syntax Patterns:
   - Ubiquitous: The <system> shall <behavior>.
   - Event-driven: WHEN <trigger>, the <system> shall <behavior>.
   - State-driven: WHILE <state>, the <system> shall <behavior>.
   - Unwanted Behavior: IF <trigger>, THEN the <system> shall <behavior>.
   - Optional Feature: WHERE <feature is present>, the <system> shall <behavior>.
4. **Changes**: Exactly which files need to change and how
5. **Verification**: A concrete shell command or test to prove the fix works (e.g. \`npm test\`, \`node -e "..."\`, \`curl ...\`). This is critical — downstream agents use this to close the feedback loop.
6. **Out of Scope**: What this does NOT include
`;

    const res = await agent.execute(issuePrompt, {
      timeoutMs: ctx.config.workflow.timeouts.issueDraft,
    });
    requireExitZero(agentName, "ISSUE.md drafting failed", res);

    // Prefer on-disk file if agent wrote it via tool use
    let issueMd;
    if (existsSync(paths.issue)) {
      const onDisk = sanitizeIssueMarkdown(readFileSync(paths.issue, "utf8"));
      if (onDisk.length > 40 && onDisk.startsWith("#")) {
        issueMd = onDisk + "\n";
        if (issueMd !== readFileSync(paths.issue, "utf8")) {
          writeFileSync(paths.issue, issueMd);
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
      writeFileSync(paths.issue, issueMd);
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
