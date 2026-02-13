import { z } from "zod";
import { AgentRolesInputSchema } from "../../config.js";
import { CoderOrchestrator } from "../../orchestrator.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

const IdeaIssueShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  priority: z.string(),
  dependsOn: z.array(z.string()),
  referenceCount: z.number().int().nonnegative(),
  validationStatus: z.string(),
  filePath: z.string().min(1),
};

const IdeaIssuesResultShape = {
  runId: z.string().min(1),
  runDir: z.string().min(1),
  scratchpadPath: z.string().min(1),
  manifestPath: z.string().min(1),
  pipelinePath: z.string().min(1),
  repoPath: z.string().min(1),
  iterations: z.number().int().positive(),
  webResearch: z.boolean(),
  validateIdeas: z.boolean(),
  validationMode: z.enum(["auto", "bug_repro", "poc"]),
  issues: z.array(z.object(IdeaIssueShape)),
};
const IdeaIssuesResultSchema = z.object(IdeaIssuesResultShape);

const AgentRolesInput = AgentRolesInputSchema;

export function registerWorkflowTools(server, defaultWorkspace) {
  // --- Step 1: coder_list_issues ---
  server.registerTool(
    "coder_list_issues",
    {
      description:
        "Step 1 of the coder workflow. Lists assigned issues from GitHub and Linear, " +
        "analyzes them against the local codebase, and rates difficulty. " +
        "Returns issues with a recommended_index. Next step: coder_draft_issue.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        projectFilter: z
          .string()
          .optional()
          .describe("Optional project/team name to filter issues by"),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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
          content: [
            { type: "text", text: `Failed to list issues: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Idea mode: pointers -> issue backlog ---
  server.registerTool(
    "coder_generate_issues_from_pointers",
    {
      description:
        "Generates a researched issue backlog from free-form idea pointers. " +
        "Runs iterative draft/critique passes and writes artifacts to .coder/scratchpad " +
        "(no temporary files under issues/).",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        repoPath: z
          .string()
          .default(".")
          .describe("Relative path to the repo subfolder in the workspace"),
        pointers: z
          .string()
          .describe("Free-form idea pointers, goals, constraints, and context"),
        clarifications: z
          .string()
          .default("")
          .describe("Optional extra constraints from the user conversation"),
        maxIssues: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(6)
          .describe("Maximum number of issues to emit"),
        iterations: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(2)
          .describe("Number of draft/critique refinement iterations"),
        webResearch: z
          .boolean()
          .default(true)
          .describe(
            "Search GitHub and Show HN references to ground library/usage recommendations",
          ),
        validateIdeas: z
          .boolean()
          .default(true)
          .describe(
            "Validate directions by bug reproduction probes or PoCs before finalizing issues",
          ),
        validationMode: z
          .enum(["auto", "bug_repro", "poc"])
          .default("auto")
          .describe(
            "Preferred validation style: auto-detect, force bug repro, or force PoC",
          ),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      workspace,
      repoPath,
      pointers,
      clarifications,
      maxIssues,
      iterations,
      webResearch,
      validateIdeas,
      validationMode,
      agentRoles,
    }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.generateIssuesFromPointers({
          repoPath,
          pointers,
          clarifications,
          maxIssues,
          iterations,
          webResearch,
          validateIdeas,
          validationMode,
        });
        const normalized = IdeaIssuesResultSchema.parse(result);
        return {
          structuredContent: normalized,
          content: [
            { type: "text", text: JSON.stringify(normalized, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to generate issues from pointers: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Step 2: coder_draft_issue ---
  server.registerTool(
    "coder_draft_issue",
    {
      description:
        "Step 2 of the coder workflow. Drafts ISSUE.md for the selected issue. " +
        "Requires an issue from coder_list_issues. Pass the user's clarifications as free text. " +
        "Next step: coder_create_plan.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        issue: z
          .object({
            source: z.enum(["github", "linear"]).describe("Issue source"),
            id: z.string().describe("Issue ID"),
            title: z.string().describe("Issue title"),
          })
          .describe("The selected issue from coder_list_issues"),
        repoPath: z
          .string()
          .describe("Relative path to the repo subfolder in the workspace"),
        baseBranch: z
          .string()
          .optional()
          .describe("Optional base branch to stack this issue on top of"),
        clarifications: z
          .string()
          .default("")
          .describe("Free-text clarifications from the user conversation"),
        force: z
          .boolean()
          .default(false)
          .describe(
            "Bypass artifact collision checks (use when restarting a workflow)",
          ),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      workspace,
      issue,
      repoPath,
      baseBranch,
      clarifications,
      force,
      agentRoles,
    }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.draftIssue({
          issue,
          repoPath,
          baseBranch,
          clarifications,
          force,
        });
        return {
          content: [{ type: "text", text: result.issueMd }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to draft issue: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Step 3: coder_create_plan ---
  server.registerTool(
    "coder_create_plan",
    {
      description:
        "Step 3 of the coder workflow. Uses the configured planner and plan reviewer to create " +
        "PLAN.md and PLANREVIEW.md. Requires coder_draft_issue to have been called first. " +
        "Next step: coder_implement.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace, agentRoles }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
        const result = await orch.createPlan();
        return {
          content: [
            {
              type: "text",
              text: `## PLAN.md\n\n${result.planMd}\n\n## PLANREVIEW.md\n\n${result.critiqueMd}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Failed to create plan: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Step 4: coder_implement ---
  server.registerTool(
    "coder_implement",
    {
      description:
        "Step 4 of the coder workflow. Uses the configured programmer agent to implement based on " +
        "PLAN.md and PLANREVIEW.md. Requires coder_create_plan to have been called " +
        "first. Long-running. Next step: coder_review_and_test.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
          content: [
            { type: "text", text: `Implementation failed: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Step 5: coder_review_and_test ---
  server.registerTool(
    "coder_review_and_test",
    {
      description:
        "Step 5 of the coder workflow. Uses the configured reviewer/committer, runs ppcommit for commit " +
        "hygiene, and executes tests. Requires coder_implement first. Long-running. " +
        "Next step: coder_create_pr.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        allowNoTests: z
          .boolean()
          .default(false)
          .describe(
            "Allow the workflow to proceed even if no test command is detected",
          ),
        testCmd: z
          .string()
          .default("")
          .describe("Explicit test command to run (e.g. 'npm test')"),
        testConfigPath: z
          .string()
          .default("")
          .describe("Path to test config JSON"),
        strictMcpStartup: z
          .boolean()
          .default(false)
          .describe("Fail if any agent has failed MCP servers at startup"),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      workspace,
      allowNoTests,
      testCmd,
      testConfigPath,
      strictMcpStartup,
      agentRoles,
    }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, {
          allowNoTests,
          testCmd,
          testConfigPath,
          strictMcpStartup,
          agentRoles,
        });
        const result = await orch.reviewAndTest();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Review and test failed: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // --- Step 6: coder_create_pr ---
  server.registerTool(
    "coder_create_pr",
    {
      description:
        "Step 6 (optional). Creates a PR from the feature branch. " +
        "Requires coder_review_and_test to have been called first.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        type: z
          .string()
          .default("feat")
          .describe("Branch type prefix (e.g. feat, bug, fix, chore)"),
        semanticName: z
          .string()
          .default("")
          .describe(
            "Semantic name for the remote branch (e.g. 'add-login-page')",
          ),
        base: z
          .string()
          .default("")
          .describe("Optional PR base branch (for stacked PRs)"),
        title: z
          .string()
          .default("")
          .describe("PR title (default: auto-generated from issue)"),
        description: z
          .string()
          .default("")
          .describe("PR body (default: first lines of ISSUE.md)"),
        agentRoles: AgentRolesInput.optional().describe(
          "Optional per-step agent selection overrides",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      workspace,
      type,
      semanticName,
      base,
      title,
      description,
      agentRoles,
    }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const orch = new CoderOrchestrator(ws, { agentRoles });
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
          content: [
            { type: "text", text: `PR creation failed: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
