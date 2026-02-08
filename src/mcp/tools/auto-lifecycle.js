import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CoderOrchestrator } from "../../orchestrator.js";
import { loadLoopState, saveLoopState } from "../../state.js";

/** @type {Map<string, { orchestrator: CoderOrchestrator, workspace: string, promise: Promise, startedAt: string }>} */
const activeRuns = new Map();

export function registerAutoLifecycleTools(server, defaultWorkspace) {
  // --- coder_auto_start: fire-and-forget async launch ---
  server.registerTool(
    "coder_auto_start",
    {
      description:
        "Start an autonomous run in the background. Returns immediately with a runId. " +
        "Use coder_auto_status to poll progress and coder_auto_cancel to stop.",
      inputSchema: {
        workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
        goal: z.string().default("resolve all assigned issues").describe("High-level goal passed as context to each issue"),
        projectFilter: z.string().optional().describe("Optional project/team name to filter issues by"),
        maxIssues: z.number().int().min(1).optional().describe("Max number of issues to process"),
        allowNoTests: z.boolean().default(false).describe("Allow the workflow to proceed even if no test command is detected"),
        testCmd: z.string().default("").describe("Explicit test command to run"),
        testConfigPath: z.string().default("").describe("Path to test config JSON"),
        destructiveReset: z.boolean().default(false).describe("Aggressively discard repo changes between issues"),
        strictMcpStartup: z.boolean().default(false).describe("Fail if any agent has failed MCP servers"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace, goal, projectFilter, maxIssues, allowNoTests, testCmd, testConfigPath, destructiveReset, strictMcpStartup }) => {
      const ws = workspace || defaultWorkspace;

      // Prevent concurrent runs on the same workspace.
      // Release stale locks where the disk state shows a terminal status.
      for (const [id, run] of activeRuns) {
        if (run.workspace === ws) {
          const diskState = loadLoopState(ws);
          if (["completed", "failed", "cancelled"].includes(diskState.status)) {
            activeRuns.delete(id);
            continue;
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Workspace already has active run: ${id}` }) }],
            isError: true,
          };
        }
      }

      const runId = randomUUID().slice(0, 8);

      // Write initial state to disk immediately so coder_auto_status sees it
      saveLoopState(ws, {
        version: 1,
        runId,
        goal,
        status: "running",
        projectFilter: projectFilter || null,
        maxIssues: maxIssues || null,
        issueQueue: [],
        currentIndex: 0,
        currentStage: "listing_issues",
        currentStageStartedAt: new Date().toISOString(),
        activeAgent: "gemini",
        lastHeartbeatAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      const orch = new CoderOrchestrator(ws, { allowNoTests, testCmd, testConfigPath, strictMcpStartup });

      const promise = orch.runAuto({
        goal,
        projectFilter: projectFilter || undefined,
        maxIssues: maxIssues || undefined,
        testCmd,
        testConfigPath,
        allowNoTests,
        destructiveReset,
        runId,
      }).catch((err) => {
        // Keep background failures from surfacing as unhandled rejections.
        console.error(`[coder_auto_start] Run ${runId} failed:`, err);
        return {
          status: "failed",
          completed: 0,
          failed: 0,
          skipped: 0,
          results: [],
        };
      }).finally(() => {
        activeRuns.delete(runId);
      });

      activeRuns.set(runId, {
        orchestrator: orch,
        workspace: ws,
        promise,
        startedAt: new Date().toISOString(),
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "started" }) }],
      };
    },
  );

  // --- coder_auto_cancel ---
  server.registerTool(
    "coder_auto_cancel",
    {
      description: "Request cancellation of a running autonomous loop by runId.",
      inputSchema: {
        runId: z.string().describe("The run ID returned by coder_auto_start"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) => {
      const run = activeRuns.get(runId);
      if (!run) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `No active run found: ${runId}` }) }],
          isError: true,
        };
      }
      run.orchestrator.requestCancel();
      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "cancel_requested" }) }],
      };
    },
  );

  // --- coder_auto_pause ---
  server.registerTool(
    "coder_auto_pause",
    {
      description: "Request pause of a running autonomous loop. The loop will pause between stages.",
      inputSchema: {
        runId: z.string().describe("The run ID returned by coder_auto_start"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) => {
      const run = activeRuns.get(runId);
      if (!run) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `No active run found: ${runId}` }) }],
          isError: true,
        };
      }
      run.orchestrator.requestPause();
      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "pause_requested" }) }],
      };
    },
  );

  // --- coder_auto_resume ---
  server.registerTool(
    "coder_auto_resume",
    {
      description: "Resume a paused autonomous loop.",
      inputSchema: {
        runId: z.string().describe("The run ID returned by coder_auto_start"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ runId }) => {
      const run = activeRuns.get(runId);
      if (!run) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `No active run found: ${runId}` }) }],
          isError: true,
        };
      }
      run.orchestrator.requestResume();
      return {
        content: [{ type: "text", text: JSON.stringify({ runId, status: "resumed" }) }],
      };
    },
  );
}
