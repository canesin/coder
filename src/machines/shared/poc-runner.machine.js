import { mkdirSync } from "node:fs";
import path from "node:path";
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
  name: "shared.poc_runner",
  description:
    "Reusable PoC execution and validation: run a proof-of-concept script, capture output, and evaluate results.",

  inputSchema: z.object({
    title: z.string().min(1).describe("PoC title"),
    description: z.string().default("").describe("What this PoC validates"),
    setupInstructions: z
      .string()
      .default("")
      .describe("Setup steps before running the PoC"),
    runCommand: z.string().min(1).describe("Command to execute the PoC"),
    successCriteria: z
      .string()
      .default("")
      .describe("How to determine if the PoC succeeded"),
    timeoutMs: z.number().int().default(120_000).describe("Execution timeout"),
    workDir: z
      .string()
      .default("")
      .describe("Working directory for PoC (auto-created if empty)"),
    scratchpadPath: z.string().default(""),
    pipelinePath: z.string().default(""),
  }),

  async execute(input, ctx) {
    const { agentName, agent } = ctx.agentPool.getAgent("programmer", {
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
        runId: "poc-runner",
        current: "init",
        history: [],
        steps: {},
      };
    }

    const workDir =
      input.workDir || path.join(ctx.scratchpadDir, `poc-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    beginPipelineStep(pipeline, pipelinePath, scratchpadPath, "poc_execution", {
      agent: agentName,
      title: input.title,
    });

    const prompt = `You are a PoC validation agent. Execute and evaluate the following proof of concept.

## PoC: ${input.title}

### Description
${input.description || "No description provided."}

### Setup
${input.setupInstructions || "No setup required."}

### Run Command
\`\`\`bash
cd ${workDir}
${input.runCommand}
\`\`\`

### Success Criteria
${input.successCriteria || "Exit code 0 and no errors in output."}

Execute the PoC in ${workDir}. Run any setup steps first, then execute the command.
Capture all output.

Return JSON:
{
  "success": true/false,
  "exitCode": 0,
  "output": "captured stdout (first 2000 chars)",
  "errors": "captured stderr (first 1000 chars)",
  "analysis": "brief analysis of results",
  "evidence": ["list of evidence points supporting success/failure"],
  "limitations": ["known limitations of this PoC"]
}`;

    const res = await agent.executeWithRetry(prompt, {
      timeoutMs: input.timeoutMs,
    });

    if (res.exitCode !== 0) {
      endPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "poc_execution",
        "failed",
        { agent: agentName },
      );
      return {
        status: "error",
        error: `PoC execution failed: ${(res.stderr || res.stdout || "").slice(0, 500)}`,
      };
    }

    const payload = parseAgentPayload(agentName, res.stdout);

    appendScratchpad(scratchpadPath, `PoC: ${input.title}`, [
      `- success: ${payload?.success ?? "unknown"}`,
      `- exit_code: ${payload?.exitCode ?? "unknown"}`,
      `- analysis: ${(payload?.analysis || "").slice(0, 200)}`,
    ]);

    endPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      "poc_execution",
      payload?.success ? "completed" : "failed",
      { agent: agentName },
    );

    return {
      status: "ok",
      data: {
        title: input.title,
        success: payload?.success ?? false,
        exitCode: payload?.exitCode ?? -1,
        output: payload?.output || "",
        errors: payload?.errors || "",
        analysis: payload?.analysis || "",
        evidence: payload?.evidence || [],
        limitations: payload?.limitations || [],
        workDir,
      },
    };
  },
});
