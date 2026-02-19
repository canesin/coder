import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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
async function loadLocalIssues(issuesDir) {
  const manifestPath = path.join(issuesDir, "manifest.json");
  if (!(await access(manifestPath).then(() => true).catch(() => false))) return null;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }

  if (!Array.isArray(manifest.issues)) return null;

  const issues = [];
  for (const entry of manifest.issues) {
    if (!entry.id || !entry.file) continue;

    // Resolve title from manifest or markdown file
    let title = entry.title || "";
    if (!title && entry.file) {
      const mdPath = path.resolve(path.dirname(issuesDir), entry.file);
      if (await access(mdPath).then(() => true).catch(() => false)) {
        try {
          const content = await readFile(mdPath, "utf8");
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

export default defineMachine({
  name: "develop.issue_list",
  description:
    "List assigned GitHub, GitLab, and Linear issues, rate difficulty, return with recommended_index.",
  inputSchema: z.object({
    projectFilter: z.string().optional(),
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
    // Try local issues first if requested
    if (input.localIssuesDir) {
      const resolvedDir = path.isAbsolute(input.localIssuesDir)
        ? input.localIssuesDir
        : path.resolve(ctx.workspaceDir, input.localIssuesDir);

      const local = await loadLocalIssues(resolvedDir);
      if (local) {
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
      ctx.log({
        event: "step1_local_issues_fallback",
        reason: "manifest not found or empty, falling back to remote",
        dir: resolvedDir,
      });
    }

    // Remote issue listing via agent
    const { agentName, agent } = ctx.agentPool.getAgent("issueSelector", {
      scope: "workspace",
    });
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};

    // Sub-step: list Linear teams if LINEAR_API_KEY is available
    if (
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
          timeoutMs: 1000 * 60 * 5,
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
    ctx.log({ event: "step1_list_issues" });
    let projectFilterClause = "";
    if (state.selectedProject) {
      projectFilterClause = `\nOnly include Linear issues from the "${state.selectedProject.name}" team (key: ${state.selectedProject.key}).`;
    } else if (input.projectFilter) {
      projectFilterClause = `\nOnly include Linear issues from projects matching "${input.projectFilter}".`;
    }

    const listPrompt = `Use your GitHub MCP, GitLab MCP, and Linear MCP to list the issues assigned to me.${projectFilterClause}

Then estimate implementation difficulty and directness (prefer small, self-contained changes). Keep this lightweight: do not do deep repository scans unless absolutely required to disambiguate repo_path.

For each issue, also identify any dependency relationships — if an issue explicitly references or requires another issue to be completed first, include the dependency in "depends_on" as the issue ID string.

Return ONLY valid JSON in this schema:
{
  "issues": [
    {
      "source": "github" | "gitlab" | "linear",
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

    const res = await agent.executeWithRetry(listPrompt, {
      structured: true,
      timeoutMs: 1000 * 60 * 10,
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
