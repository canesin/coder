import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  loadPipeline,
  resolveArtifact,
  runStructuredStep,
  skipPipelineStep,
} from "./_shared.js";

export default defineMachine({
  name: "research.poc_validation",
  description:
    "Plan and execute validation tracks (bug repro or PoC) to ground research findings. " +
    "Requires stepsDir/pipelinePath from context_gather. Auto-loads analysisBrief and webReferenceMap from stepsDir.",
  inputSchema: z.object({
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
    analysisBrief: z.any().default({}),
    webReferenceMap: z.any().default({}),
    validateIdeas: z.boolean().default(true),
    validationMode: z.enum(["auto", "bug_repro", "poc"]).default("auto"),
  }),

  async execute(input, ctx) {
    const {
      stepsDir,
      scratchpadPath,
      pipelinePath,
      validateIdeas,
      validationMode,
    } = input;
    const pipeline = (await loadPipeline(pipelinePath)) || {
      version: 1,
      current: "poc_validation",
      history: [],
      steps: {},
    };
    const analysisBrief = await resolveArtifact(
      input.analysisBrief,
      stepsDir,
      "analysis-brief",
    );
    const webReferenceMap = await resolveArtifact(
      input.webReferenceMap,
      stepsDir,
      "web-references",
    );

    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    let validationPlan = { tracks: [] };
    let validationResults = {
      results: [],
      summary: "Validation not executed.",
    };

    if (!validateIdeas) {
      await skipPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "plan_validation_tracks",
        "validateIdeas disabled",
      );
      await skipPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "execute_validation_tracks",
        "validateIdeas disabled",
      );
      return {
        status: "ok",
        data: { validationPlan, validationResults },
      };
    }

    // Plan validation tracks
    ctx.log({ event: "research_plan_validation" });
    const validationPlanPrompt = `Create a validation plan for these pointers and references.

Requested validation mode: ${validationMode}
If mode is "auto", choose bug_repro when issue is bug-oriented, otherwise choose poc.

Analysis brief:
${JSON.stringify(analysisBrief, null, 2)}

References:
${JSON.stringify(webReferenceMap, null, 2)}

Return ONLY valid JSON in this schema:
{
  "tracks": [
    {
      "id": "V1",
      "topic": "string",
      "mode": "bug_repro|poc",
      "tool_preference": ["playwright", "cratedex", "qt-mcp", "none"],
      "procedure": ["string"],
      "success_signal": "string",
      "fallback": "string"
    }
  ],
  "notes": "string"
}`;
    const validationPlanRes = await runStructuredStep({
      stepName: "plan_validation_tracks",
      artifactName: "validation-plan",
      role: "issueSelector",
      prompt: validationPlanPrompt,
      timeoutMs: 1000 * 60 * 8,
      ...stepOpts,
    });
    validationPlan = validationPlanRes.payload || validationPlan;

    // Execute validation tracks
    const tracks = Array.isArray(validationPlan?.tracks)
      ? validationPlan.tracks
      : [];
    if (tracks.length > 0) {
      ctx.log({ event: "research_execute_validation", tracks: tracks.length });
      const validationExecPrompt = `Execute minimal validation probes for these tracks now.

Use available MCP servers when relevant:
- playwright for web/UI/browser flows
- cratedex for Rust workspace checks/docs
- qt-mcp for Qt desktop flows

If a probe cannot run in this environment, mark status as inconclusive and explain limitations.

Validation tracks:
${JSON.stringify(validationPlan, null, 2)}

Return ONLY valid JSON in this schema:
{
  "results": [
    {
      "track_id": "V1",
      "mode": "bug_repro|poc|analysis",
      "status": "passed|failed|inconclusive|not_run",
      "tool_used": "playwright|cratedex|qt-mcp|none",
      "method": "string",
      "evidence": ["string"],
      "limitations": ["string"]
    }
  ],
  "summary": "string"
}`;
      const validationExecRes = await runStructuredStep({
        stepName: "execute_validation_tracks",
        artifactName: "validation-results",
        role: "programmer",
        prompt: validationExecPrompt,
        timeoutMs: 1000 * 60 * 12,
        ...stepOpts,
      });
      validationResults = validationExecRes.payload || validationResults;
    } else {
      await skipPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "execute_validation_tracks",
        "no validation tracks generated",
      );
    }

    return {
      status: "ok",
      data: { validationPlan, validationResults },
    };
  },
});
