import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { formatCommandFailure } from "../../helpers.js";
import {
  IssueItemSchema,
  IssuesPayloadSchema,
  ProjectsPayloadSchema,
} from "../../schemas.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import { parseAgentPayload, requireExitZero } from "./_shared.js";

const HANG_TIMEOUT_MS = 1000 * 60 * 2;

/**
 * Load issues from a local manifest.json + markdown files.
 *
 * @param {string} issuesDir - Absolute path to issues directory
 * @returns {{ issues: z.infer<typeof IssueItemSchema>[], recommended_index: number } | null}
 */
function loadLocalIssues(issuesDir) {
  const manifestPath = path.join(issuesDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }

  if (!Array.isArray(manifest.issues)) return null;

  // Detect workspace root from manifest if present (research pipeline writes filePath relative to workspace)
  const workspaceRoot = manifest.repoRoot || manifest.repoPath || "";

  const issues = [];
  for (const entry of manifest.issues) {
    if (!entry.id || (!entry.file && !entry.filePath)) continue;

    // Resolve markdown path: entry.file is relative to parent of issuesDir,
    // entry.filePath (from research pipeline) is relative to workspace root
    let mdPath;
    if (entry.file) {
      mdPath = path.resolve(path.dirname(issuesDir), entry.file);
    } else if (entry.filePath) {
      mdPath = path.isAbsolute(entry.filePath)
        ? entry.filePath
        : path.resolve(
            workspaceRoot || path.dirname(issuesDir),
            entry.filePath,
          );
    }

    // Resolve title from manifest or markdown file
    let title = entry.title || "";
    if (!title && mdPath) {
      if (existsSync(mdPath)) {
        try {
          const content = readFileSync(mdPath, "utf8");
          const heading = content.match(/^#\s+(.+)/m);
          title = heading
            ? heading[1].replace(/^ISSUE-\d+\s*[—–-]\s*/, "").trim()
            : entry.id;
        } catch {
          title = entry.id;
        }
      }
    }

    const parsed = IssueItemSchema.safeParse({
      source: "local",
      id: entry.id,
      title: title || entry.id,
      repo_path: entry.repo_path || "",
      difficulty: entry.difficulty ?? 3,
      reason: entry.reason || `Priority: ${entry.priority || "P2"}`,
      depends_on: entry.dependsOn || entry.depends_on || [],
    });
    if (parsed.success) issues.push(parsed.data);
  }

  return issues.length > 0 ? { issues, recommended_index: 0 } : null;
}

/**
 * Fetch open GitHub issues via gh CLI.
 *
 * @param {string} cwd - Directory to run gh in (repo root)
 * @returns {object[]}
 */
function fetchGithubIssues(cwd) {
  const res = spawnSync(
    "gh",
    [
      "issue",
      "list",
      "--json",
      "number,title,body,labels,url",
      "--state",
      "open",
      "--limit",
      "50",
    ],
    { cwd, encoding: "utf8", timeout: 15000 },
  );
  if (res.error) {
    throw new Error(`gh: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      formatCommandFailure("gh issue list failed", {
        exitCode: res.status ?? 1,
        stderr: res.stderr || "",
        stdout: res.stdout || "",
      }),
    );
  }
  if (!res.stdout) return [];
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `gh returned invalid JSON (exit 0): ${res.stdout.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `gh returned non-array JSON (exit 0): ${res.stdout.slice(0, 200)}`,
    );
  }
  return parsed;
}

/**
 * Fetch open GitLab issues via glab CLI.
 *
 * @param {string} cwd - Directory to run glab in (repo root)
 * @returns {object[]}
 */
function fetchGitlabIssues(cwd) {
  const res = spawnSync(
    "glab",
    ["issue", "list", "--output", "json", "--state", "opened"],
    { cwd, encoding: "utf8", timeout: 15000 },
  );
  if (res.error) {
    throw new Error(`glab: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      formatCommandFailure("glab issue list failed", {
        exitCode: res.status ?? 1,
        stderr: res.stderr || "",
        stdout: res.stdout || "",
      }),
    );
  }
  if (!res.stdout) return [];
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `glab returned invalid JSON (exit 0): ${res.stdout.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `glab returned non-array JSON (exit 0): ${res.stdout.slice(0, 200)}`,
    );
  }
  return parsed;
}

export default defineMachine({
  name: "develop.issue_list",
  description:
    "List open issues from the configured source (github, linear, gitlab, or local), rate difficulty, return with recommended_index.",
  inputSchema: z.object({
    projectFilter: z.string().optional(),
    issueSource: z
      .enum(["github", "linear", "gitlab", "local"])
      .optional()
      .describe("Override config.workflow.issueSource for this run"),
    localIssuesDir: z
      .string()
      .default("")
      .describe(
        "Path to local issues directory with manifest.json (absolute or relative to workspace)",
      ),
  }),
  mcpAnnotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  async execute(input, ctx) {
    const issueSource = input.issueSource || ctx.config.workflow.issueSource;

    // Local issues — no agent needed
    if (issueSource === "local") {
      const rawDir =
        input.localIssuesDir ||
        ctx.config.workflow.localIssuesDir ||
        ".coder/local-issues";
      const resolvedDir = path.isAbsolute(rawDir)
        ? rawDir
        : path.resolve(ctx.workspaceDir, rawDir);

      const local = loadLocalIssues(resolvedDir);
      if (!local) {
        throw new Error(
          `issueSource is "local" but no valid manifest found at ${resolvedDir}`,
        );
      }
      ctx.log({
        event: "step1_local_issues",
        count: local.issues.length,
        dir: resolvedDir,
      });
      return {
        status: "ok",
        data: {
          issues: local.issues,
          recommended_index: local.recommended_index,
          source: "local",
        },
      };
    }

    // Remote issue listing via agent
    const { agentName, agent } = ctx.agentPool.getAgent("issueSelector", {
      scope: "workspace",
    });
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};

    // Sub-step: list Linear teams when source is linear
    if (
      issueSource === "linear" &&
      ctx.secrets.LINEAR_API_KEY &&
      (!state.steps.listedProjects || !state.linearProjects)
    ) {
      ctx.log({ event: "step0_list_projects" });
      try {
        const projPrompt = `Use your Linear MCP to list all teams I have access to.

Return ONLY valid JSON in this schema:
{
  "projects": [
    {
      "id": "string (team ID)",
      "name": "string (team name)",
      "key": "string (team key, e.g. ENG)"
    }
  ]
}`;
        const projRes = await agent.executeWithRetry(projPrompt, {
          structured: true,
          timeoutMs: ctx.config.workflow.timeouts.issueSelection,
          hangTimeoutMs: HANG_TIMEOUT_MS,
          retries: 2,
          retryOnRateLimit: true,
        });
        requireExitZero(agentName, "project listing failed", projRes);

        const projPayload = ProjectsPayloadSchema.parse(
          parseAgentPayload(agentName, projRes.stdout),
        );
        state.linearProjects = projPayload.projects;

        if (input.projectFilter && state.linearProjects.length > 0) {
          const match = state.linearProjects.find(
            (p) =>
              p.name
                .toLowerCase()
                .includes(input.projectFilter.toLowerCase()) ||
              p.key.toLowerCase() === input.projectFilter.toLowerCase(),
          );
          if (match) state.selectedProject = match;
        }
        state.steps.listedProjects = true;
        saveState(ctx.workspaceDir, state);
      } catch (err) {
        ctx.log({
          event: "step0_list_projects_failed",
          error: err.message || String(err),
        });
        state.steps.listedProjects = true;
        state.linearProjects ||= [];
        saveState(ctx.workspaceDir, state);
      }
    }

    // Main issue listing
    ctx.log({ event: "step1_list_issues", issueSource });

    const TAIL = `
Estimate implementation difficulty and directness for each issue (prefer small, self-contained changes). Keep this lightweight: do not do deep repository scans unless absolutely required to disambiguate repo_path.

For each issue, also identify any dependency relationships — if an issue explicitly references or requires another issue to be completed first, include the dependency in "depends_on" as the issue ID string.

Return ONLY valid JSON in this schema:
{
  "issues": [
    {
      "source": "<source>",
      "id": "string",
      "title": "string",
      "repo_path": "string (relative path to repo subfolder in workspace, or empty if unknown)",
      "difficulty": 1 | 2 | 3 | 4 | 5,
      "reason": "short explanation",
      "depends_on": ["issue-id-1"]
    }
  ],
  "recommended_index": number
}`;

    let listPrompt;
    if (issueSource === "github") {
      const issues = fetchGithubIssues(ctx.workspaceDir);
      ctx.log({
        event: "step1_fetch",
        source: "github",
        count: issues.length,
      });
      const issueList =
        issues.length > 0
          ? `Here are the open GitHub issues for this repo (fetched via gh CLI):\n${JSON.stringify(issues, null, 2)}`
          : "No open GitHub issues found.";
      listPrompt = `${issueList}

Use "github" as the source value and "#<number>" as the id (e.g. "#42").
${TAIL}`;
    } else if (issueSource === "gitlab") {
      const issues = fetchGitlabIssues(ctx.workspaceDir);
      ctx.log({
        event: "step1_fetch",
        source: "gitlab",
        count: issues.length,
      });
      const issueList =
        issues.length > 0
          ? `Here are the open GitLab issues for this repo (fetched via glab CLI):\n${JSON.stringify(issues, null, 2)}`
          : "No open GitLab issues found.";
      listPrompt = `${issueList}

Use "gitlab" as the source value and "#<iid>" as the id (e.g. "#42").
${TAIL}`;
    } else {
      // linear — agent fetches via MCP
      let projectFilterClause = "";
      if (state.selectedProject) {
        projectFilterClause = `\nOnly include issues from the "${state.selectedProject.name}" team (key: ${state.selectedProject.key}).`;
      } else if (input.projectFilter) {
        projectFilterClause = `\nOnly include issues from projects matching "${input.projectFilter}".`;
      }
      listPrompt = `Use your Linear MCP to list open issues.${projectFilterClause}

Use "linear" as the source value and the Linear issue identifier as the id (e.g. "ENG-42").
${TAIL}`;
    }

    const res = await agent.executeWithRetry(listPrompt, {
      structured: true,
      timeoutMs: ctx.config.workflow.timeouts.issueSelection,
      hangTimeoutMs: HANG_TIMEOUT_MS,
      retries: 2,
      retryOnRateLimit: true,
    });
    requireExitZero(agentName, "issue listing failed", res);

    const issuesPayload = IssuesPayloadSchema.parse(
      parseAgentPayload(agentName, res.stdout),
    );

    state.steps.listedIssues = true;
    state.issuesPayload = issuesPayload;
    saveState(ctx.workspaceDir, state);

    return {
      status: "ok",
      data: {
        issues: issuesPayload.issues,
        recommended_index: issuesPayload.recommended_index,
        linearProjects: state.linearProjects || undefined,
        source: "remote",
      },
    };
  },
});
