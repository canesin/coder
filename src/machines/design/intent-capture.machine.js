import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { extractJson } from "../../helpers.js";
import { defineMachine } from "../_base.js";

export default defineMachine({
  name: "design.intent_capture",
  description:
    "Parse design intent from text description, optionally accept screenshots/wireframes as reference.",
  inputSchema: z.object({
    intent: z.string().min(1),
    screenshotPaths: z.array(z.string()).default([]),
    projectName: z.string().default(""),
    style: z.string().default(""),
  }),

  async execute(input, ctx) {
    const specDir = path.resolve(
      ctx.workspaceDir,
      ctx.config.design?.specDir || "spec/UI",
    );
    mkdirSync(specDir, { recursive: true });

    // Load reference screenshots if provided
    const references = [];
    for (const screenshotPath of input.screenshotPaths) {
      const absPath = path.resolve(ctx.workspaceDir, screenshotPath);
      if (existsSync(absPath)) {
        references.push({
          path: screenshotPath,
          exists: true,
        });
      } else {
        ctx.log({ event: "design_screenshot_missing", path: screenshotPath });
      }
    }

    // Use AI agent to parse the intent into structured screen specs
    const { agentName, agent } = ctx.agentPool.getAgent("issueSelector", {
      scope: "workspace",
    });

    const parsePrompt = `Parse this UI design intent into structured screen specifications.

Design Intent:
${input.intent}

${input.style ? `Style Guidelines:\n${input.style}\n` : ""}
${references.length > 0 ? `Reference Screenshots:\n${references.map((r) => `- ${r.path}`).join("\n")}\n` : ""}

Return ONLY valid JSON in this schema:
{
  "projectName": "string",
  "screens": [
    {
      "name": "string",
      "description": "string",
      "type": "page|modal|component|overlay",
      "elements": ["string"],
      "interactions": ["string"],
      "responsive": ["mobile", "tablet", "desktop"]
    }
  ],
  "designSystem": {
    "colorScheme": "light|dark|both",
    "primaryColor": "string",
    "typography": "string",
    "spacing": "compact|comfortable|spacious",
    "style": "string"
  },
  "constraints": ["string"],
  "notes": "string"
}`;

    const res = await agent.execute(parsePrompt, {
      timeoutMs: ctx.config.workflow.timeouts.designStep,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `${agentName} intent capture failed: ${res.stderr || res.stdout}`,
      );
    }

    // Parse the structured response
    let parsed;
    try {
      parsed = extractJson(res.stdout || "");
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.screens)) {
      throw new Error(
        `${agentName} did not return valid screen specifications.`,
      );
    }

    // Write intent spec to disk
    const intentSpec = {
      projectName: input.projectName || parsed.projectName || "design-project",
      intent: input.intent,
      style: input.style,
      references,
      ...parsed,
      capturedAt: new Date().toISOString(),
    };
    const intentPath = path.join(specDir, "intent.json");
    writeFileSync(intentPath, `${JSON.stringify(intentSpec, null, 2)}\n`);

    ctx.log({
      event: "design_intent_captured",
      screens: parsed.screens.length,
      projectName: intentSpec.projectName,
    });

    return {
      status: "ok",
      data: {
        specDir,
        intentPath,
        intentSpec,
      },
    };
  },
});
