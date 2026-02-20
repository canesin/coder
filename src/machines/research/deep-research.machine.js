import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  loadPipeline,
  resolveArtifact,
  runStructuredStep,
  skipPipelineStep,
} from "./_shared.js";

export default defineMachine({
  name: "research.deep_research",
  description:
    "Search GitHub repos and Show HN threads for external references grounding the analysis. " +
    "Requires stepsDir/pipelinePath from context_gather. Auto-loads analysisBrief from stepsDir if not passed.",
  inputSchema: z.object({
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
    analysisBrief: z.any().default({}),
    webResearch: z.boolean().default(true),
  }),

  async execute(input, ctx) {
    const { stepsDir, scratchpadPath, pipelinePath, webResearch } = input;
    const pipeline = (await loadPipeline(pipelinePath)) || {
      version: 1,
      current: "deep_research",
      history: [],
      steps: {},
    };
    const analysisBrief = await resolveArtifact(
      input.analysisBrief,
      stepsDir,
      "analysis-brief",
    );

    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    let webReferenceMap = { topics: [], missing_research: [] };

    if (webResearch) {
      ctx.log({ event: "research_web_references" });
      const referencePrompt = `Find external implementation references for these problem spaces.

Requirements:
- Search GitHub repositories and Show HN threads.
- Prioritize primary sources (repo README/docs) and practical usage examples.
- Include why each reference is relevant to this codebase.

Analysis brief:
${JSON.stringify(analysisBrief, null, 2)}

Return ONLY valid JSON in this schema:
{
  "topics": [
    {
      "topic": "string",
      "references": [
        {
          "source": "github|show_hn|docs|other",
          "title": "string",
          "url": "string",
          "why": "string",
          "library": "string"
        }
      ]
    }
  ],
  "missing_research": ["string"]
}`;
      const referencesRes = await runStructuredStep({
        stepName: "collect_web_references",
        artifactName: "web-references",
        role: "issueSelector",
        prompt: referencePrompt,
        timeoutMs: 1000 * 60 * 8,
        ...stepOpts,
      });
      webReferenceMap = referencesRes.payload || webReferenceMap;
    } else {
      await skipPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "collect_web_references",
        "webResearch disabled",
      );
    }

    return {
      status: "ok",
      data: { webReferenceMap },
    };
  },
});
