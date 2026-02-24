import { z } from "zod";
import { AgentPool } from "../../agents/pool.js";
import { resolveConfig } from "../../config.js";
import { buildSecrets, DEFAULT_PASS_ENV } from "../../helpers.js";
import {
  buildSteeringGenerationPrompt,
  loadSteeringContext,
  parseSteeringResponse,
  steeringDirFor,
  writeSteeringFiles,
} from "../../steering.js";
import { resolveWorkspaceForMcp } from "../workspace.js";

export function registerSteeringTools(server, defaultWorkspace) {
  server.registerTool(
    "coder_steering_generate",
    {
      description:
        "Scan the repository and generate steering context files (.coder/steering/) " +
        "that give AI agents institutional memory about the project's architecture, " +
        "conventions, and tech stack. Creates product.md, structure.md, and tech.md.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
        force: z
          .boolean()
          .default(false)
          .describe("Overwrite existing steering files"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace, force }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const config = resolveConfig(ws);

        // Check if steering files already exist
        const existing = loadSteeringContext(ws);
        if (existing && !force) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Steering files already exist at ${steeringDirFor(ws)}. ` +
                  "Use force=true to regenerate.",
              },
            ],
          };
        }

        // Use gemini agent for generation (fast, cheap)
        const secrets = buildSecrets(DEFAULT_PASS_ENV);
        const pool = new AgentPool({
          config,
          workspaceDir: ws,
          verbose: false,
        });

        const prompt = buildSteeringGenerationPrompt(ws);
        const agent = pool.getAgent("gemini");
        const result = await agent.execute(prompt, {
          timeoutMs: 120_000,
          env: secrets,
        });

        if (!result?.stdout) {
          await pool.killAll();
          return {
            content: [
              {
                type: "text",
                text: "Steering generation failed: no agent output",
              },
            ],
            isError: true,
          };
        }

        const parsed = parseSteeringResponse(result.stdout);
        const sections = Object.keys(parsed);
        if (sections.length === 0) {
          await pool.killAll();
          return {
            content: [
              {
                type: "text",
                text: "Steering generation failed: could not parse agent output into product/structure/tech sections",
              },
            ],
            isError: true,
          };
        }

        const written = writeSteeringFiles(ws, parsed);
        await pool.killAll();

        return {
          content: [
            {
              type: "text",
              text: `Generated ${written.length} steering files in ${steeringDirFor(ws)}: ${written.join(", ")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Steering generation failed: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "coder_steering_update",
    {
      description:
        "Refresh steering context files after significant codebase changes. " +
        "Re-scans the repository and updates .coder/steering/ files.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace directory (default: cwd)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace }) => {
      try {
        const ws = resolveWorkspaceForMcp(workspace, defaultWorkspace);
        const config = resolveConfig(ws);
        const secrets = buildSecrets(DEFAULT_PASS_ENV);
        const pool = new AgentPool({
          config,
          workspaceDir: ws,
          verbose: false,
        });

        const prompt = buildSteeringGenerationPrompt(ws);
        const agent = pool.getAgent("gemini");
        const result = await agent.execute(prompt, {
          timeoutMs: 120_000,
          env: secrets,
        });

        if (!result?.stdout) {
          await pool.killAll();
          return {
            content: [
              {
                type: "text",
                text: "Steering update failed: no agent output",
              },
            ],
            isError: true,
          };
        }

        const parsed = parseSteeringResponse(result.stdout);
        const sections = Object.keys(parsed);
        if (sections.length === 0) {
          await pool.killAll();
          return {
            content: [
              {
                type: "text",
                text: "Steering update failed: could not parse agent output",
              },
            ],
            isError: true,
          };
        }

        const written = writeSteeringFiles(ws, parsed);
        await pool.killAll();

        return {
          content: [
            {
              type: "text",
              text: `Updated ${written.length} steering files in ${steeringDirFor(ws)}: ${written.join(", ")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Steering update failed: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
