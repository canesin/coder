import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  chunkPointers,
  initPipeline,
  initRunDirectory,
  runStructuredStep,
} from "./_shared.js";

export default defineMachine({
  name: "research.context_gather",
  description:
    "Pipeline entry point: initialize research run, chunk pointers, analyze each chunk, aggregate into analysis brief. " +
    "Must be called first. Creates the run directory and pipeline state. " +
    "Prefer coder_workflow(workflow='research') for the full automated pipeline.",
  inputSchema: z.object({
    pointers: z.string().min(1),
    repoPath: z.string().default("."),
    clarifications: z.string().default(""),
    maxIssues: z.number().int().min(1).max(20).default(6),
    iterations: z.number().int().min(1).max(5).default(2),
    webResearch: z.boolean().default(true),
    validateIdeas: z.boolean().default(true),
    validationMode: z.enum(["auto", "bug_repro", "poc"]).default("auto"),
  }),

  async execute(input, ctx) {
    const ideaPointers = input.pointers.trim();

    // Validate repo
    const repoRoot = path.resolve(ctx.workspaceDir, input.repoPath || ".");
    try {
      await access(repoRoot);
    } catch {
      throw new Error(`Repo root does not exist: ${repoRoot}`);
    }
    try {
      await execFile("git", ["rev-parse", "--git-dir"], { cwd: repoRoot });
    } catch {
      throw new Error(`Not a git repository: ${repoRoot}`);
    }

    // Initialize run directory
    const {
      runId,
      runDir,
      issuesDir,
      stepsDir,
      pointersDir,
      scratchpadPath,
      pipelinePath,
    } = await initRunDirectory(ctx.scratchpadDir);

    // Write scratchpad header
    await writeFile(
      scratchpadPath,
      [
        `# Idea-to-Issue Research Run: ${runId}`,
        "",
        `- repo_root: ${repoRoot}`,
        `- repo_path: ${input.repoPath}`,
        `- max_issues: ${input.maxIssues}`,
        `- iterations: ${input.iterations}`,
        `- web_research: ${input.webResearch}`,
        `- validate_ideas: ${input.validateIdeas}`,
        `- validation_mode: ${input.validationMode}`,
        "",
        "## Pointers",
        "```text",
        ideaPointers,
        "```",
        "",
        "## Clarifications",
        "```text",
        String(input.clarifications || "(none provided)"),
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    // Chunk pointers
    const pointerChunks = chunkPointers(ideaPointers);
    if (pointerChunks.length === 0) {
      throw new Error("Unable to derive pointer chunks from input.");
    }
    for (let i = 0; i < pointerChunks.length; i++) {
      const chunkPath = path.join(
        pointersDir,
        `chunk-${String(i + 1).padStart(2, "0")}.txt`,
      );
      await writeFile(chunkPath, `${pointerChunks[i]}\n`, "utf8");
    }

    // Initialize pipeline
    const pipeline = await initPipeline(runId, pipelinePath);

    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    // Analyze each chunk
    ctx.log({ event: "research_analyze_chunks", count: pointerChunks.length });
    const chunkSummaries = [];
    for (let i = 0; i < pointerChunks.length; i++) {
      const chunkPrompt = `Summarize pointer chunk ${i + 1}/${pointerChunks.length} for issue decomposition.

Repo root: ${repoRoot}
Chunk:
${pointerChunks[i]}

Return ONLY valid JSON in this schema:
{
  "summary": "string",
  "signals": {
    "bugs": ["string"],
    "ideas": ["string"],
    "constraints": ["string"],
    "domains": ["string"],
    "tools": ["string"]
  },
  "actionable_pointers": ["string"]
}`;
      const chunkRes = await runStructuredStep({
        stepName: `analyze_chunk_${String(i + 1).padStart(2, "0")}`,
        artifactName: `analyze-chunk-${String(i + 1).padStart(2, "0")}`,
        role: "issueSelector",
        prompt: chunkPrompt,
        timeoutMs: 1000 * 60 * 6,
        ...stepOpts,
      });
      chunkSummaries.push(chunkRes.payload);
    }

    // Aggregate analysis
    ctx.log({ event: "research_aggregate_analysis" });
    const analysisPrompt = `Aggregate pointer chunk summaries into a normalized analysis brief.

Repo root: ${repoRoot}
Chunk summaries:
${JSON.stringify(chunkSummaries, null, 2)}

Return ONLY valid JSON in this schema:
{
  "problem_spaces": [
    { "name": "string", "description": "string", "signals": ["string"] }
  ],
  "constraints": ["string"],
  "suspected_work_types": ["bug", "idea", "mixed"],
  "priority_signals": ["string"],
  "unknowns": ["string"]
}`;
    const analysisRes = await runStructuredStep({
      stepName: "aggregate_pointer_analysis",
      artifactName: "analysis-brief",
      role: "issueSelector",
      prompt: analysisPrompt,
      timeoutMs: 1000 * 60 * 8,
      ...stepOpts,
    });
    const analysisBrief = analysisRes.payload || {};

    await appendScratchpad(scratchpadPath, "Context Gather Complete", [
      `- chunks_analyzed: ${pointerChunks.length}`,
      `- problem_spaces: ${Array.isArray(analysisBrief.problem_spaces) ? analysisBrief.problem_spaces.length : 0}`,
    ]);

    return {
      status: "ok",
      data: {
        runId,
        runDir,
        issuesDir,
        stepsDir,
        pointersDir,
        scratchpadPath,
        pipelinePath,
        repoRoot,
        repoPath: input.repoPath,
        pointers: ideaPointers,
        clarifications: input.clarifications,
        maxIssues: input.maxIssues,
        iterations: input.iterations,
        webResearch: input.webResearch,
        validateIdeas: input.validateIdeas,
        validationMode: input.validationMode,
        analysisBrief,
      },
    };
  },
});
