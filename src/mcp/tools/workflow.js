import { z } from "zod";
import { CoderOrchestrator } from "../../orchestrator.js";
import { AgentRolesInputSchema } from "../../config.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

const LoopIssueResultShape = {
  source: z.enum(["github", "linear"]),
  id: z.string().min(1),
  title: z.string().min(1),
  repoPath: z.string(),
  baseBranch: z.string().nullable(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  dependsOn: z.array(z.string()),
};

const AutoResultShape = {
  status: z.enum(["completed", "failed", "cancelled"]),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  results: z.array(z.object(LoopIssueResultShape)),
};

const AgentRolesInput = AgentRolesInputSchema;

export function registerWorkflowTools(server, defaultWorkspace) {
  // --- Step 1: coder_list_issues ---
  server.tool(
    "coder_list_issues",
    "Step 1 of the coder workflow. Lists assigned issues from GitHub and Linear, " +
      "analyzes them against the local codebase, and rates difficulty. " +
      "Returns issues with a recommended_index. Next step: coder_draft_issue.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      projectFilter: z.string().optional().describe("Optional project/team name to filter issues by"),
      agentRoles: AgentRolesInput.optional().describe("Optional per-step agent selection overrides"),
    },
    async ({ workspace, projectFilter, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.listIssues({ projectFilter });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to list issues: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- Step 2: coder_draft_issue ---
  server.tool(
    "coder_draft_issue",
    "Step 2 of the coder workflow. Drafts ISSUE.md for the selected issue. " +
      "Requires an issue from coder_list_issues. Pass the user's clarifications as free text. " +
      "Next step: coder_create_plan.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      issue: z.object({
        source: z.enum(["github", "linear"]).describe("Issue source"),
        id: z.string().describe("Issue ID"),
        title: z.string().describe("Issue title"),
      }).describe("The selected issue from coder_list_issues"),
      repoPath: z.string().describe("Relative path to the repo subfolder in the workspace"),
      baseBranch: z.string().optional().describe("Optional base branch to stack this issue on top of"),
      clarifications: z.string().default("").describe("Free-text clarifications from the user conversation"),
      force: z.boolean().default(false).describe("Bypass artifact collision checks (use when restarting a workflow)"),
      agentRoles: AgentRolesInput.optional().describe("Optional per-step agent selection overrides"),
    },
    async ({ workspace, issue, repoPath, baseBranch, clarifications, force, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.draftIssue({ issue, repoPath, baseBranch, clarifications, force });
        return {
          content: [{ type: "text", text: result.issueMd }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to draft issue: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- Step 3: coder_create_plan ---
  server.tool(
    "coder_create_plan",
    "Step 3 of the coder workflow. Uses the configured planner and plan reviewer to create " +
      "PLAN.md and PLANREVIEW.md. Requires coder_draft_issue to have been called first. " +
      "Next step: coder_implement.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      agentRoles: AgentRolesInput.optional().describe("Optional per-step agent selection overrides"),
    },
    async ({ workspace, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.createPlan();
        return {
          content: [
            { type: "text", text: `## PLAN.md\n\n${result.planMd}\n\n## PLANREVIEW.md\n\n${result.critiqueMd}` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to create plan: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- Step 4: coder_implement ---
  server.tool(
    "coder_implement",
    "Step 4 of the coder workflow. Uses the configured programmer agent to implement based on " +
      "PLAN.md and PLANREVIEW.md. Requires coder_create_plan to have been called " +
      "first. Long-running. Next step: coder_review_and_test.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      agentRoles: AgentRolesInput.optional().describe("Optional per-step agent selection overrides"),
    },
    async ({ workspace, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.implement();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Implementation failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- Step 5: coder_review_and_test ---
  server.tool(
    "coder_review_and_test",
    "Step 5 of the coder workflow. Uses the configured reviewer/committer, runs ppcommit for commit " +
      "hygiene, and executes tests. Requires coder_implement first. Long-running. " +
      "Next step: coder_create_pr.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      allowNoTests: z.boolean().default(false).describe("Allow the workflow to proceed even if no test command is detected"),
      testCmd: z.string().default("").describe("Explicit test command to run (e.g. 'npm test')"),
      testConfigPath: z.string().default("").describe("Path to test config JSON (default: .coder/test.json)"),
      strictMcpStartup: z.boolean().default(false).describe("Fail if any agent has failed MCP servers at startup"),
      agentRoles: AgentRolesInput.optional().describe("Optional per-step agent selection overrides"),
    },
    async ({ workspace, allowNoTests, testCmd, testConfigPath, strictMcpStartup, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { allowNoTests, testCmd, testConfigPath, strictMcpStartup, agentRoles });
        const result = await orch.reviewAndTest();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Review and test failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- Step 6: coder_create_pr ---
  server.tool(
    "coder_create_pr",
    "Step 6 (optional). Creates a PR from the feature branch. " +
      "Requires coder_review_and_test to have been called first.",
    {
      workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      type: z.enum(["bug", "feat", "refactor"]).default("feat").describe("PR type prefix for branch naming"),
      semanticName: z.string().default("").describe("Semantic name for the remote branch (e.g. 'add-login-page')"),
      base: z.string().default("").describe("Optional PR base branch (for stacked PRs)"),
      title: z.string().default("").describe("PR title (default: auto-generated from issue)"),
      description: z.string().default("").describe("PR body (default: first lines of ISSUE.md)"),
    },
    async ({ workspace, type, semanticName, base, title, description }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws);
        const result = await orch.createPR({
          type,
          semanticName: semanticName || undefined,
          base: base || undefined,
          title: title || undefined,
          description: description || undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `PR creation failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- Autonomous loop: coder_auto ---
  server.registerTool(
    "coder_auto",
    {
      description:
        "Autonomous loop: processes multiple assigned issues end-to-end without human intervention. " +
        "Lists issues, sorts by difficulty (easiest first), then for each issue runs the full pipeline " +
        "(draft → plan → implement → review → PR). Dependency issues run in stacked mode " +
        "(dependent issue branch + PR base are set to dependency branch). Failed issues are isolated and the loop keeps attempting downstream work. " +
        "Saves progress to loop-state.json for crash recovery. Long-running.",
      inputSchema: {
        workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
        goal: z.string().default("resolve all assigned issues").describe("High-level goal passed as context to each issue"),
        projectFilter: z.string().optional().describe("Optional project/team name to filter issues by"),
        maxIssues: z.number().int().min(1).optional().describe("Max number of issues to process (must be >= 1, default: all)"),
        allowNoTests: z.boolean().default(false).describe("Allow the workflow to proceed even if no test command is detected"),
        testCmd: z.string().default("").describe("Explicit test command to run (e.g. 'npm test')"),
        testConfigPath: z.string().default("").describe("Path to test config JSON (default: .coder/test.json)"),
        destructiveReset: z.boolean().default(false).describe("If true, aggressively discard repo changes between issues (uses git restore/clean)"),
        strictMcpStartup: z.boolean().default(false).describe("Fail if any agent has failed MCP servers at startup"),
        agentRoles: AgentRolesInput.optional().describe("Optional per-step agent selection overrides"),
      },
      outputSchema: AutoResultShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace, goal, projectFilter, maxIssues, allowNoTests, testCmd, testConfigPath, destructiveReset, strictMcpStartup, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { allowNoTests, testCmd, testConfigPath, strictMcpStartup, agentRoles });
        const result = await orch.runAuto({
          goal,
          projectFilter: projectFilter || undefined,
          maxIssues: maxIssues || undefined,
          testCmd,
          testConfigPath,
          allowNoTests,
          destructiveReset,
        });
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Autonomous loop failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
