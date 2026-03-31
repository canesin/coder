import path from "node:path";
import { z } from "zod";

/**
 * Tagged error for cancellation — thrown by `checkCancel()`.
 * WorkflowRunner recognises this and converts it to `{ status: "cancelled" }`
 * instead of `{ status: "error" }`.
 */
export class CancelledError extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/**
 * Check whether the workflow has been cancelled and throw if so.
 * Use inside machine loops to allow prompt cancellation.
 *
 * @param {{ cancelToken: { cancelled: boolean } }} ctx
 */
export function checkCancel(ctx) {
  if (ctx.cancelToken.cancelled) throw new CancelledError();
}

export const MachineResultSchema = z.object({
  status: z.enum(["ok", "error", "skipped", "cancelled"]),
  data: z.any().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});

export const WorkflowContextSchema = z.object({
  workspaceDir: z.string().min(1),
  repoPath: z.string().default("."),
  config: z.any().optional(),
  agentPool: z.any().optional(),
  log: z.any().optional(),
  cancelToken: z
    .object({
      cancelled: z.boolean().default(false),
      paused: z.boolean().default(false),
    })
    .default({ cancelled: false, paused: false }),
  secrets: z.record(z.string(), z.string()).default({}),
  artifactsDir: z.string().optional(),
  scratchpadDir: z.string().optional(),
  steeringContext: z.string().optional(),
  /** Set by WorkflowRunner — prefixes Claude/Codex session ids so runs do not share a global session key. */
  workflowRunId: z.string().optional(),
  /** MCP launcher: notify workflow lifecycle actor of stage (and optional agent) changes. */
  onWorkflowStage: z.any().optional(),
});

/**
 * Provide safe defaults for workflow context so tests and programmatic callers
 * don't have to fully populate workflow-only fields.
 */
function normalizeWorkflowContext(workflowContext) {
  const wc = workflowContext || {};
  const workspaceDir = wc.workspaceDir || "";
  const cancelToken = wc.cancelToken || { cancelled: false, paused: false };
  // Preserve object identity so callers/tests can flip `cancelToken.cancelled`
  // and have in-flight steps observe it.
  if (cancelToken.cancelled === undefined) cancelToken.cancelled = false;
  if (cancelToken.paused === undefined) cancelToken.paused = false;
  return {
    ...wc,
    cancelToken,
    secrets: wc.secrets || {},
    artifactsDir:
      wc.artifactsDir ||
      (workspaceDir ? path.join(workspaceDir, ".coder", "artifacts") : ""),
    scratchpadDir:
      wc.scratchpadDir ||
      (workspaceDir ? path.join(workspaceDir, ".coder", "scratchpad") : ""),
    log: wc.log || (() => {}),
    config: wc.config || {},
  };
}

/**
 * Define a machine — the atomic unit of workflow composition.
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   inputSchema: z.ZodType,
 *   outputSchema?: z.ZodType,
 *   execute: (input: any, ctx: any) => Promise<{ status: string, data?: any, error?: string, durationMs: number }>,
 *   mcpAnnotations?: object,
 * }} def
 */
export function defineMachine(def) {
  if (!def.name || typeof def.name !== "string") {
    throw new Error("Machine name is required");
  }
  if (!def.execute || typeof def.execute !== "function") {
    throw new Error(`Machine ${def.name}: execute function is required`);
  }
  if (!def.inputSchema) {
    throw new Error(`Machine ${def.name}: inputSchema is required`);
  }
  if (!def.description || typeof def.description !== "string") {
    throw new Error(`Machine ${def.name}: description is required`);
  }

  const machine = {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema || MachineResultSchema,
    mcpAnnotations: def.mcpAnnotations || {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },

    async run(rawInput, workflowContext) {
      const start = Date.now();
      workflowContext = normalizeWorkflowContext(workflowContext);
      // Fast-path cancellation so we don't accidentally surface unrelated errors
      // (e.g. IO / input validation) when a run is already cancelled.
      if (workflowContext?.cancelToken?.cancelled) {
        return {
          status: "cancelled",
          error: "Run cancelled",
          durationMs: Date.now() - start,
        };
      }
      let input;
      try {
        input = def.inputSchema.parse(rawInput);
      } catch (err) {
        return {
          status: "error",
          error: err.message || String(err),
          durationMs: Date.now() - start,
        };
      }
      try {
        const result = await def.execute(input, workflowContext);
        const durationMs = Date.now() - start;
        return {
          status: result.status || "ok",
          data: result.data,
          error: result.error,
          durationMs: result.durationMs ?? durationMs,
        };
      } catch (err) {
        // `instanceof` can fail if multiple copies of this module are loaded (e.g. differing paths in CI).
        // Fall back to the tagged name check so cancellation reliably maps to `{ status: "cancelled" }`.
        if (err instanceof CancelledError || err?.name === "CancelledError") {
          return {
            status: "cancelled",
            error: err.message,
            durationMs: Date.now() - start,
          };
        }
        return {
          status: "error",
          error: err.message || String(err),
          durationMs: Date.now() - start,
        };
      }
    },
  };

  return Object.freeze(machine);
}
