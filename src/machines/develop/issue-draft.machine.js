import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  gitCleanOrThrow,
  sanitizeIssueMarkdown,
  sanitizeUserData,
  spawnAsync,
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
 * Format an issue body with its comments into a single string.
 *
 * @param {string | null | undefined} body - Issue body/description
 * @param {Array<{author?: {login?: string, name?: string}, body?: string, createdAt?: string}> | null | undefined} comments
 * @returns {string | null}
 */
function formatBodyWithComments(body, comments) {
  const parts = [];
  if (body) parts.push(body);
  if (Array.isArray(comments) && comments.length > 0) {
    if (parts.length > 0) parts.push("\n---\n");
    parts.push("## Comments\n");
    for (const c of comments) {
      const author = c.author?.login || c.author?.name || "unknown";
      const date = c.createdAt ? ` (${c.createdAt})` : "";
      const text = c.body || "";
      parts.push(`**${author}**${date}:\n${text}\n`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

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
async function fetchIssueBody(
  source,
  id,
  repoRoot,
  localIssuesDir,
  { signal } = {},
) {
  if (source === "github") {
    const num = id.replace(/^#/, "");
    const res = await spawnAsync(
      "gh",
      ["issue", "view", num, "--json", "body,comments"],
      { cwd: repoRoot, signal, timeout: 10000 },
    );
    if (res.error?.code === "ABORT_ERR" || res.error?.code === "ETIMEDOUT")
      throw res.error;
    if (res.error || res.status !== 0 || !res.stdout) return null;
    try {
      const data = JSON.parse(res.stdout);
      return formatBodyWithComments(data.body, data.comments);
    } catch {
      return null;
    }
  }

  if (source === "gitlab") {
    const iid = id.replace(/^[#!]/, "");
    const res = await spawnAsync(
      "glab",
      ["issue", "view", iid, "--output", "json"],
      { cwd: repoRoot, signal, timeout: 10000 },
    );
    if (res.error?.code === "ABORT_ERR" || res.error?.code === "ETIMEDOUT")
      throw res.error;
    if (res.error || res.status !== 0 || !res.stdout) return null;
    try {
      const data = JSON.parse(res.stdout);
      return formatBodyWithComments(data.description, data.notes);
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
        if (entry) {
          let mdPath;
          if (entry.file) {
            // file is relative to localIssuesDir
            mdPath = path.isAbsolute(entry.file)
              ? entry.file
              : path.join(localIssuesDir, entry.file);
          } else if (entry.filePath) {
            // filePath is workspace-relative (resolve from manifest root)
            const wsRoot = manifest.repoRoot || manifest.repoPath || repoRoot;
            mdPath = path.isAbsolute(entry.filePath)
              ? entry.filePath
              : path.resolve(wsRoot, entry.filePath);
          }
          if (mdPath && existsSync(mdPath)) return readFileSync(mdPath, "utf8");
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

    const state = await loadState(ctx.workspaceDir);
    state.steps ||= {};

    // Idempotency: skip if this issue's draft is already on disk
    if (state.steps.wroteIssue && state.selected?.id === input.issue.id) {
      const earlyPaths = artifactPaths(ctx.artifactsDir);
      if (existsSync(earlyPaths.issue)) {
        const onDisk = sanitizeIssueMarkdown(
          readFileSync(earlyPaths.issue, "utf8"),
        );
        if (onDisk.length > 40 && onDisk.trim().startsWith("#")) {
          const repoPath = normalizeRepoPath(
            ctx.workspaceDir,
            state.repoPath ?? input.repoPath ?? ".",
          );
          const repoRoot = resolveRepoRoot(ctx.workspaceDir, repoPath);
          await ctx.agentPool.setRepoRoot(repoRoot);
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
    await saveState(ctx.workspaceDir, state);

    // Update pool repo root
    const repoRoot = resolveRepoRoot(ctx.workspaceDir, repoPath);
    await ctx.agentPool.setRepoRoot(repoRoot);

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
    await scratchpad.restoreFromSqlite(scratchpadPath);
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
    await scratchpad.appendSection(scratchpadPath, "Input", [
      `- clarifications: ${(input.clarifications || "(none provided)").trim()}`,
    ]);
    state.scratchpadPath = path.relative(ctx.workspaceDir, scratchpadPath);
    await saveState(ctx.workspaceDir, state);

    // When force=true (re-run), reset dirty state before branch operations.
    // Exclude .coder/ from cleanup to preserve workflow state and artifacts dir.
    if (input.force) {
      spawnSync("git", ["checkout", "--", "."], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      spawnSync("git", ["clean", "-fd", "--exclude=.coder/"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    }

    // Ensure .gitignore rules exist AFTER cleanup (checkout -- . reverts .gitignore
    // to committed version, which may lack .coder/ rules).
    ensureGitignore(ctx.workspaceDir);
    mkdirSync(ctx.artifactsDir, { recursive: true });

    // Verify clean repo
    gitCleanOrThrow(repoRoot);
    state.steps.verifiedCleanRepo = true;
    await saveState(ctx.workspaceDir, state);

    // Optional base branch checkout for stacked PRs
    if (state.baseBranch) {
      // Fetch the branch in case it only exists on the remote (#108)
      const fetchRes = await spawnAsync(
        "git",
        ["fetch", "origin", state.baseBranch],
        { cwd: repoRoot, signal: ctx.signal },
      );
      // Propagate abort/timeout, but treat other fetch failures as best-effort
      // (offline, no remote, etc.) — the subsequent checkout will fail if needed.
      if (
        fetchRes.error &&
        (fetchRes.error.code === "ABORT_ERR" ||
          fetchRes.error.code === "ETIMEDOUT")
      ) {
        throw fetchRes.error;
      }
      const baseCheckout = spawnSync("git", ["checkout", state.baseBranch], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (baseCheckout.status !== 0) {
        // Try creating a local tracking branch from the remote
        const trackCheckout = spawnSync(
          "git",
          ["checkout", "-b", state.baseBranch, `origin/${state.baseBranch}`],
          { cwd: repoRoot, encoding: "utf8" },
        );
        if (trackCheckout.status !== 0) {
          throw new Error(
            `Failed to checkout base branch ${state.baseBranch}: ${baseCheckout.stderr || baseCheckout.stdout}`,
          );
        }
      }
    }

    ensureBranch(repoRoot, state.branch, {
      baseBranch: state.baseBranch || undefined,
      forceRecreate: input.force,
    });

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

    const issueBody = await fetchIssueBody(
      input.issue.source,
      input.issue.id,
      repoRoot,
      resolvedLocalIssuesDir,
      { signal: ctx.signal },
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
- title: <user-data field="issue.title">${sanitizeUserData(input.issue.title)}</user-data>
- repo_root: ${repoRoot}
${issueBodySection}
Clarifications from user:
<user-data field="clarifications">${sanitizeUserData(input.clarifications || "(none provided)")}</user-data>

Scratchpad for iterative notes:
- path: ${scratchpadPath}
- append hypotheses, constraints, open questions, and feedback between drafting passes
- keep temporary notes in this scratchpad (not in \`issues/\`)

Output ONLY markdown suitable for writing directly to ISSUE.md.
If you wrote ISSUE.md to disk via a tool, also output its full contents to stdout.

## Required Sections (in order)
1. **Metadata**: Source, Issue ID, Repo Root (relative path), Difficulty (1-5)
2. **Problem**: What's wrong or missing — reference specific files/functions
3. **Requirements**: Behavioral requirements using EARS Syntax Patterns:
   - Ubiquitous: The <system> shall <behavior>.
   - Event-driven: WHEN <trigger>, the <system> shall <behavior>.
   - State-driven: WHILE <state>, the <system> shall <behavior>.
   - Unwanted Behavior: IF <trigger>, THEN the <system> shall <behavior>.
   - Optional Feature: WHERE <feature is present>, the <system> shall <behavior>.
4. **Changes**: Exactly which files need to change and how
5. **Testing Strategy**: Search the codebase for existing test files/patterns, then specify:
   - **Existing tests**: Which test files cover related behavior (paths + what they test)
   - **Test patterns**: The repo's test framework, conventions, assertion style
   - **New test cases**: Concrete test cases to write — inputs, expected outputs, edge cases
   ${
     (input.issue.difficulty ?? 3) >= 3
       ? `- **Red/Green TDD**: This is a difficulty ${input.issue.difficulty ?? 3} issue — use Red/Green TDD.
     List specific failing assertions the implementation agent should write BEFORE coding:
     - Test name, assertion, and expected failure reason (missing function, wrong return value, etc.)
     - These form the RED phase — they must fail for the right reasons before implementation begins`
       : `- For this low-complexity issue, a lightweight test-after approach is acceptable if a failing-test-first approach isn't practical`
   }
6. **Verification**: A concrete shell command or test to prove the fix works (e.g. \`npm test\`, \`node -e "..."\`, \`curl ...\`). This is critical — downstream agents use this to close the feedback loop.
7. **Out of Scope**: What this does NOT include
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
          // Try extracting markdown that starts after a preamble (find first `# ` line)
          const lines = (res.stdout || "").split("\n");
          const mdStart = lines.findIndex((l) => /^#\s/.test(l));
          if (mdStart >= 0) {
            issueMd =
              sanitizeIssueMarkdown(lines.slice(mdStart).join("\n").trimEnd()) +
              "\n";
          } else if (fallback.length > 100) {
            // Content present but no header — synthesize one from issue metadata
            issueMd = `# ${input.issue.id}: ${input.issue.title}\n\n${fallback}\n`;
            ctx.log({
              event: "issue_draft_header_synthesized",
              issue: input.issue,
            });
          } else {
            // Last resort: sanitizeIssueMarkdown strips code fences, so if the
            // agent wrapped output in ```markdown...``` with bold-style section
            // headers (no `#`), we get valid content back without a title line.
            // Prepend a synthesized title rather than failing.
            const candidateMd = sanitizeIssueMarkdown(res.stdout || "").trim();
            if (candidateMd.length > 100) {
              issueMd = `# ${input.issue.title}\n\n${candidateMd}\n`;
            } else {
              const rawPreview = (res.stdout || "")
                .slice(0, 300)
                .replace(/\n/g, "\\n");
              throw new Error(
                `${agentName} draft output did not contain valid ISSUE.md markdown. ` +
                  `Check .coder/artifacts/ISSUE.md — the agent may have written it to disk ` +
                  `without outputting it. Raw output preview: "${rawPreview}"`,
              );
            }
          }
        } else {
          issueMd = fallback + "\n";
        }
      }
      writeFileSync(paths.issue, issueMd);
    }

    state.steps.wroteIssue = true;
    await saveState(ctx.workspaceDir, state);

    await scratchpad.appendSection(scratchpadPath, "Drafted ISSUE.md", [
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
