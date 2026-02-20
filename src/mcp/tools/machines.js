import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AgentPool } from "../../agents/pool.js";
import { resolveConfig } from "../../config.js";
import { buildSecrets, DEFAULT_PASS_ENV } from "../../helpers.js";
import { ensureLogsDir, makeJsonlLogger } from "../../logging.js";
import { listMachines } from "../../machines/_registry.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

/**
 * Build a workflow context for standalone machine execution (not part of a workflow).
 */
async function buildStandaloneContext(workspaceDir, overrides = {}) {
  const config = resolveConfig(workspaceDir, overrides);
  const artifactsDir = path.join(workspaceDir, ".coder", "artifacts");
  const scratchpadDir = path.join(workspaceDir, ".coder", "scratchpad");

  await mkdir(path.join(workspaceDir, ".coder"), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(scratchpadDir, { recursive: true });
  ensureLogsDir(workspaceDir);

  const log = makeJsonlLogger(workspaceDir, "machines");
  const secrets = buildSecrets(DEFAULT_PASS_ENV);

  const repoRoot = path.resolve(workspaceDir, overrides.repoPath || ".");
  const agentPool = new AgentPool({
    config,
    workspaceDir,
    repoRoot,
    verbose: config.verbose,
  });

  return {
    workspaceDir,
    repoPath: overrides.repoPath || ".",
    config,
    agentPool,
    log,
    cancelToken: { cancelled: false, paused: false },
    secrets,
    artifactsDir,
    scratchpadDir,
  };
}

/**
 * Auto-register each machine in the registry as an MCP tool.
 *
 * Tool name: `coder_{machine.name.replace(/\./g, "_")}`
 * e.g. machine "develop.planning" -> tool "coder_develop_planning"
 */
export function registerMachineTools(server, defaultWorkspace) {
  const machines = listMachines();

  for (const machine of machines) {
    const toolName = `coder_${machine.name.replace(/\./g, "_")}`;

    // Build input schema: machine's inputSchema + workspace override
    const inputProps = {
      workspace: z
        .string()
        .optional()
        .describe("Workspace directory (default: cwd)"),
    };

    // Extract shape from the machine's inputSchema if it's a ZodObject
    if (machine.inputSchema?.shape) {
      for (const [key, schema] of Object.entries(machine.inputSchema.shape)) {
        inputProps[key] = schema;
      }
    }

    server.registerTool(
      toolName,
      {
        description: machine.description,
        inputSchema: inputProps,
        annotations: machine.mcpAnnotations,
      },
      async (params) => {
        let ctx;
        try {
          const ws = resolveWorkspaceForMcp(params.workspace, defaultWorkspace);
          const { workspace: _ws, ...machineInput } = params;
          ctx = await buildStandaloneContext(ws, machineInput);

          const result = await machine.run(machineInput, ctx);

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: result.status === "error",
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Machine ${machine.name} failed: ${err.message}`,
              },
            ],
            isError: true,
          };
        } finally {
          if (ctx?.agentPool) {
            await ctx.agentPool.killAll();
          }
        }
      },
    );
  }
}
