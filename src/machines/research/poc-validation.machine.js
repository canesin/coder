import path from "node:path";
import { z } from "zod";
import { checkCancel, defineMachine } from "../_base.js";
import {
  loadPipeline,
  loadSessionState,
  resolveArtifact,
  runStructuredStep,
  saveSessionState,
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
    const pipeline = loadPipeline(pipelinePath) || {
      version: 1,
      current: "poc_validation",
      history: [],
      steps: {},
    };
    const analysisBrief = resolveArtifact(
      input.analysisBrief,
      stepsDir,
      "analysis-brief",
    );
    const webReferenceMap = resolveArtifact(
      input.webReferenceMap,
      stepsDir,
      "web-references",
    );

    const runDir = path.dirname(stepsDir);
    const sessionState = loadSessionState(runDir);
    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    let validationPlan = { tracks: [] };
    let validationResults = {
      results: [],
      summary: "Validation not executed.",
    };

    if (!validateIdeas) {
      skipPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "plan_validation_tracks",
        "validateIdeas disabled",
      );
      skipPipelineStep(
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
    checkCancel(ctx);
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
      timeoutMs: ctx.config?.workflow?.timeouts?.researchStep ?? 60_000,
      ...stepOpts,
      sessionState,
      sessionKey: "pocPlanSessionId",
    });
    validationPlan = validationPlanRes.payload || validationPlan;
    saveSessionState(runDir, sessionState);

    // Execute validation tracks
    checkCancel(ctx);
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
        timeoutMs: ctx.config?.workflow?.timeouts?.pocValidation ?? 60_000,
        ...stepOpts,
        sessionState,
        sessionKey: "pocExecSessionId",
      });
      validationResults = validationExecRes.payload || validationResults;
      saveSessionState(runDir, sessionState);
    } else {
      skipPipelineStep(
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
