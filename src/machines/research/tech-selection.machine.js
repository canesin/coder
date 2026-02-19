import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  beginPipelineStep,
  endPipelineStep,
  loadPipeline,
  parseAgentPayload,
  requireExitZero,
  resolveArtifact,
} from "./_shared.js";

export default defineMachine({
  name: "research.tech_selection",
  description:
    "Standalone tool: evaluate technology ecosystems and select optimal tech stack. " +
    "Not part of the automated research pipeline. Auto-loads analysisBrief and webReferenceMap from stepsDir.",

  inputSchema: z.object({
    requirements: z.string().min(1).describe("Project requirements summary"),
    categories: z
      .array(z.string())
      .default([])
      .describe(
        "Tech categories to evaluate (e.g. 'frontend framework', 'database')",
      ),
    constraints: z
      .string()
      .default("")
      .describe("Constraints (team size, budget, existing stack)"),
    analysisBrief: z
      .any()
      .default({})
      .describe("Analysis brief from context-gather"),
    webReferenceMap: z
      .any()
      .default({})
      .describe("Web references from deep-research"),
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
  }),

  async execute(input, ctx) {
    const { agentName, agent } = ctx.agentPool.getAgent("planner", {
      scope: "workspace",
    });

    const pipeline = (await loadPipeline(input.pipelinePath)) || {
      version: 1,
      runId: "tech-selection",
      current: "init",
      history: [],
      steps: {},
    };
    const analysisBrief = await resolveArtifact(
      input.analysisBrief,
      input.stepsDir,
      "analysis-brief",
    );
    const webRefs = await resolveArtifact(
      input.webReferenceMap,
      input.stepsDir,
      "web-references",
    );

    await beginPipelineStep(
      pipeline,
      input.pipelinePath,
      input.scratchpadPath,
      "tech_evaluation",
      { agent: agentName },
    );

    const refSummary = Object.values(webRefs)
      .slice(0, 10)
      .map((ref) => `- ${ref.title || ref.url}: ${ref.summary || ""}`)
      .join("\n");

    const briefSummary =
      typeof analysisBrief === "object" && analysisBrief
        ? JSON.stringify(analysisBrief).slice(0, 3000)
        : String(analysisBrief || "").slice(0, 3000);

    const categories =
      input.categories.length > 0
        ? input.categories.join(", ")
        : "auto-detect from requirements";

    const prompt = `You are a technology evaluation expert. Analyze the requirements and select the optimal tech stack.

## Requirements
${input.requirements}

## Categories to Evaluate
${categories}

## Constraints
${input.constraints || "No specific constraints."}

## Analysis Context
${briefSummary}

## Web References
${refSummary || "No web references available."}

For each technology category, evaluate 2-4 candidates. Score each on:
- maturity (0-10): ecosystem stability, community size
- fit (0-10): alignment with requirements
- devex (0-10): developer experience, docs quality
- risk (0-10): adoption risk, lock-in, maintenance burden

Return JSON:
{
  "categories": [
    {
      "name": "category name",
      "selected": "recommended technology",
      "candidates": [
        {
          "name": "tech name",
          "scores": { "maturity": 8, "fit": 9, "devex": 7, "risk": 3 },
          "totalScore": 21,
          "pros": ["pro1", "pro2"],
          "cons": ["con1"],
          "reasoning": "why this score"
        }
      ],
      "rationale": "why the selected technology wins"
    }
  ],
  "stack": {
    "summary": "one-line tech stack description",
    "technologies": ["tech1", "tech2"],
    "tradeoffs": ["tradeoff1"],
    "alternatives_considered": ["alt1"]
  }
}`;

    const res = await agent.executeWithRetry(prompt, {
      timeoutMs: 1000 * 60 * 8,
    });
    requireExitZero(agentName, "tech_selection", res);

    const payload = parseAgentPayload(agentName, res.stdout);

    await appendScratchpad(input.scratchpadPath, "Tech Selection", [
      `- agent: ${agentName}`,
      `- categories: ${(payload?.categories || []).length}`,
      `- stack: ${payload?.stack?.summary || "unknown"}`,
    ]);

    await endPipelineStep(
      pipeline,
      input.pipelinePath,
      input.scratchpadPath,
      "tech_evaluation",
      "completed",
      { agent: agentName },
    );

    return {
      status: "ok",
      data: {
        categories: payload?.categories || [],
        stack: payload?.stack || {},
      },
    };
  },
});
