import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadLoopState } from "../../state.js";

const HEARTBEAT_STALE_MS = 30_000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === "EPERM") return true;
    return false;
  }
}

export function registerAutoStatusTools(server, defaultWorkspace) {
  // --- coder_auto_status: lightweight read-only snapshot ---
  server.registerTool(
    "coder_auto_status",
    {
      description:
        "Read-only snapshot of the autonomous loop: run ID, queue status, current stage, " +
        "heartbeat, agent activity, and MCP health. Lightweight — does not create an orchestrator.",
      inputSchema: {
        workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace }) => {
      const ws = workspace || defaultWorkspace;
      try {
        const loopState = loadLoopState(ws);
        const heartbeatTs = loopState.lastHeartbeatAt ? Date.parse(loopState.lastHeartbeatAt) : NaN;
        const heartbeatAgeMs = Number.isFinite(heartbeatTs) ? Math.max(0, Date.now() - heartbeatTs) : null;
        const runnerPid = loopState.runnerPid ?? null;
        const runnerAlive = isPidAlive(runnerPid);
        const heartbeatStale = heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_MS;
        const shouldCheckStale = loopState.status === "running" || loopState.status === "paused";
        const pidStale = shouldCheckStale && runnerAlive === false;
        const isStale = shouldCheckStale && (heartbeatStale || pidStale);
        const staleReason = isStale
          ? (pidStale ? "runner_process_not_alive" : "heartbeat_stale")
          : null;

        const counts = { total: 0, completed: 0, failed: 0, skipped: 0, pending: 0, inProgress: 0 };
        for (const entry of loopState.issueQueue) {
          counts.total++;
          if (entry.status === "completed") counts.completed++;
          else if (entry.status === "failed") counts.failed++;
          else if (entry.status === "skipped") counts.skipped++;
          else if (entry.status === "in_progress") counts.inProgress++;
          else counts.pending++;
        }

        const issueQueue = loopState.issueQueue.map((e) => ({
          source: e.source,
          id: e.id,
          title: e.title,
          status: e.status,
          prUrl: e.prUrl || null,
          error: e.error || null,
        }));

        // Read agent activity (best-effort)
        let agentActivity = null;
        const activityPath = path.join(ws, ".coder", "activity.json");
        if (existsSync(activityPath)) {
          try { agentActivity = JSON.parse(readFileSync(activityPath, "utf8")); } catch { /* */ }
        }

        // Read MCP health (best-effort)
        let mcpHealth = null;
        const healthPath = path.join(ws, ".coder", "mcp-health.json");
        if (existsSync(healthPath)) {
          try { mcpHealth = JSON.parse(readFileSync(healthPath, "utf8")); } catch { /* */ }
        }

        const result = {
          runId: loopState.runId || null,
          runStatus: isStale ? "stale" : loopState.status,
          rawRunStatus: loopState.status,
          isStale,
          staleReason,
          goal: loopState.goal,
          counts,
          currentStage: loopState.currentStage || null,
          activeAgent: loopState.activeAgent || null,
          lastHeartbeatAt: loopState.lastHeartbeatAt || null,
          heartbeatAgeMs,
          runnerPid,
          runnerAlive,
          issueQueue,
          agentActivity,
          mcpHealth,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to get auto status: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- coder_auto_events: cursor-based event log reader ---
  server.registerTool(
    "coder_auto_events",
    {
      description:
        "Read structured events from the autonomous loop log (.coder/logs/auto.jsonl). " +
        "Supports cursor-based pagination via afterSeq/limit for polling.",
      inputSchema: {
        workspace: z.string().optional().describe("Workspace directory (default: cwd)"),
        afterSeq: z.number().int().min(0).default(0).describe("0-based line offset — return events after this sequence number (default: 0 = from start)"),
        limit: z.number().int().min(1).max(500).default(50).describe("Max events to return (default: 50, max: 500)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, afterSeq = 0, limit = 50 }) => {
      const ws = workspace || defaultWorkspace;
      const logPath = path.join(ws, ".coder", "logs", "auto.jsonl");

      try {
        if (!existsSync(logPath)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ events: [], nextSeq: 0, totalLines: 0 }) }],
          };
        }

        const content = readFileSync(logPath, "utf8");
        const allLines = content.split("\n").filter((l) => l.trim());
        const totalLines = allLines.length;

        const events = [];
        const start = afterSeq;
        const end = Math.min(start + limit, totalLines);
        for (let i = start; i < end; i++) {
          try {
            const parsed = JSON.parse(allLines[i]);
            events.push({ seq: i + 1, ...parsed });
          } catch {
            events.push({ seq: i + 1, raw: allLines[i] });
          }
        }

        const result = { events, nextSeq: end, totalLines };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to read auto events: ${err.message}` }],
          isError: true,
        };
      }
    },
  );
}
