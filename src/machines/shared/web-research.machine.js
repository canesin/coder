import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  beginPipelineStep,
  endPipelineStep,
  initPipeline,
  initRunDirectory,
  parseAgentPayload,
} from "../research/_shared.js";

export default defineMachine({
  name: "shared.web_research",
  description:
    "Reusable deep web research: search GitHub repos, articles, and Show HN threads for references on a topic.",

  inputSchema: z.object({
    topic: z.string().min(1).describe("Research topic or question"),
    queries: z
      .array(z.string())
      .default([])
      .describe("Explicit search queries (generated from topic if empty)"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Max references to collect"),
    scratchpadPath: z
      .string()
      .default("")
      .describe("Path to scratchpad (auto-created if empty)"),
    pipelinePath: z
      .string()
      .default("")
      .describe("Path to pipeline state (auto-created if empty)"),
  }),

  async execute(input, ctx) {
    const { agentName, agent } = ctx.agentPool.getAgent("planner", {
      scope: "workspace",
    });

    let scratchpadPath = input.scratchpadPath;
    let pipelinePath = input.pipelinePath;
    let pipeline;

    if (!scratchpadPath || !pipelinePath) {
      const dirs = initRunDirectory(ctx.scratchpadDir);
      scratchpadPath = scratchpadPath || dirs.scratchpadPath;
      pipelinePath = pipelinePath || dirs.pipelinePath;
      pipeline = initPipeline(dirs.runId, pipelinePath);
    } else {
      pipeline = {
        version: 1,
        runId: "web-research",
        current: "init",
        history: [],
        steps: {},
      };
    }

    beginPipelineStep(pipeline, pipelinePath, scratchpadPath, "web_research", {
      agent: agentName,
    });

    const queries =
      input.queries.length > 0
        ? input.queries
        : [`${input.topic} site:github.com`, `${input.topic} Show HN`];

    const prompt = `You are a research assistant. Search the web for references on the following topic.

Topic: ${input.topic}

Search queries to use:
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Find up to ${input.maxResults} relevant references. For each reference provide:
- source: "github" | "hackernews" | "article" | "docs" | "other"
- title: descriptive title
- url: full URL
- summary: 1-2 sentence summary of relevance
- stars: GitHub stars if applicable (0 otherwise)

Return JSON:
{
  "references": [{ "source": "...", "title": "...", "url": "...", "summary": "...", "stars": 0 }],
  "searchSummary": "brief summary of findings"
}`;

    const res = await agent.executeWithRetry(prompt, {
      timeoutMs: 1000 * 60 * 5,
    });
    if (res.exitCode !== 0) {
      endPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "web_research",
        "failed",
        { agent: agentName },
      );
      return {
        status: "error",
        error: `Web research failed: ${(res.stderr || res.stdout || "").slice(0, 500)}`,
      };
    }

    const payload = parseAgentPayload(agentName, res.stdout);
    const references = payload?.references || [];

    appendScratchpad(scratchpadPath, "Web Research Results", [
      `- topic: ${input.topic}`,
      `- references_found: ${references.length}`,
      `- agent: ${agentName}`,
    ]);

    endPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      "web_research",
      "completed",
      { agent: agentName, count: references.length },
    );

    return {
      status: "ok",
      data: {
        references,
        searchSummary: payload?.searchSummary || "",
        webReferenceMap: Object.fromEntries(
          references.map((ref) => [ref.url, ref]),
        ),
      },
    };
  },
});
