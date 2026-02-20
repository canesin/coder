import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  beginPipelineStep,
  endPipelineStep,
  loadPipeline,
  loadStepArtifact,
  renderIdeaIssueMarkdown,
  resolveArtifact,
  sanitizeFilenameSegment,
} from "./_shared.js";

export default defineMachine({
  name: "research.spec_publish",
  description:
    "Pipeline final step: render issue backlog as markdown files and write manifest. " +
    "Auto-loads analysisBrief, webReferenceMap, validationPlan, validationResults from stepsDir when not passed.",
  inputSchema: z.object({
    runId: z.string().min(1),
    runDir: z.string().min(1),
    issuesDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
    repoPath: z.string().default("."),
    pointers: z.string().default(""),
    clarifications: z.string().default(""),
    iterations: z.number().int().default(2),
    maxIssues: z.number().int().default(6),
    webResearch: z.boolean().default(true),
    validateIdeas: z.boolean().default(true),
    validationMode: z.enum(["auto", "bug_repro", "poc"]).default("auto"),
    repoRoot: z.string().min(1),
    analysisBrief: z.any().default({}),
    webReferenceMap: z.any().default({}),
    validationPlan: z.any().default({}),
    validationResults: z.any().default({}),
    finalDraft: z.any(),
    finalReview: z.any().nullable().default(null),
    priorFeedback: z.array(z.string()).default([]),
    selectedIssues: z.array(z.any()),
    issueSelectorName: z.string().default("gemini"),
    planReviewerName: z.string().default("gemini"),
  }),

  async execute(input, ctx) {
    const {
      runId,
      runDir,
      issuesDir,
      scratchpadPath,
      pipelinePath,
      repoPath,
      pointers,
      selectedIssues,
    } = input;

    const scratchpadRelPath = path.relative(ctx.workspaceDir, scratchpadPath);
    const stepsDir = path.join(runDir, "steps");

    // Auto-load accumulated artifacts from stepsDir when not passed explicitly
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
    const validationPlan = await resolveArtifact(
      input.validationPlan,
      stepsDir,
      "validation-plan",
    );
    const validationResults = await resolveArtifact(
      input.validationResults,
      stepsDir,
      "validation-results",
    );
    const finalReview =
      input.finalReview ||
      (await loadStepArtifact(stepsDir, "review-02")) ||
      (await loadStepArtifact(stepsDir, "review-01"));

    // Track this step in the pipeline
    const pipeline = (await loadPipeline(pipelinePath)) || {
      version: 1,
      current: "spec_publish",
      history: [],
      steps: {},
    };
    await beginPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      "spec_publish",
      { issueCount: selectedIssues.length },
    );

    const generatedIssues = [];
    for (let i = 0; i < selectedIssues.length; i++) {
      const item = selectedIssues[i];
      const fallbackId = `IDEA-${String(i + 1).padStart(2, "0")}`;
      const issueId = String(item?.id || fallbackId).trim() || fallbackId;
      const title = String(item?.title || `Issue ${i + 1}`).trim();
      const slug = sanitizeFilenameSegment(title, {
        fallback: `issue-${i + 1}`,
      });
      const fileName = `${String(i + 1).padStart(2, "0")}-${slug}.md`;
      const issuePath = path.join(issuesDir, fileName);

      const issueMd = renderIdeaIssueMarkdown({
        issue: item,
        issueId,
        title,
        repoPath,
        pointers,
        scratchpadRelPath,
      });
      await writeFile(issuePath, issueMd, "utf8");

      const references = Array.isArray(item?.references) ? item.references : [];
      const validationStatus = String(item?.validation?.status || "not_run");
      generatedIssues.push({
        id: issueId,
        title,
        priority: String(item?.priority || "P2"),
        dependsOn: Array.isArray(item?.depends_on)
          ? item.depends_on
              .map((dep) => String(dep || "").trim())
              .filter(Boolean)
          : [],
        referenceCount: references.length,
        validationStatus,
        filePath: path.relative(ctx.workspaceDir, issuePath),
      });
    }

    // Write manifest
    const manifest = {
      runId,
      repoPath,
      repoRoot: input.repoRoot,
      pointers,
      clarifications: input.clarifications || "",
      iterations: input.iterations,
      maxIssues: input.maxIssues,
      webResearch: input.webResearch,
      validateIdeas: input.validateIdeas,
      validationMode: input.validationMode,
      issueSelector: input.issueSelectorName,
      planReviewer: input.planReviewerName,
      pipelinePath: path.relative(ctx.workspaceDir, pipelinePath),
      priorFeedback: input.priorFeedback,
      finalReview,
      analysisBrief,
      webReferenceMap,
      validationPlan,
      validationResults,
      issues: generatedIssues,
    };
    const manifestPath = path.join(runDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await endPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      "spec_publish",
      "completed",
      {
        issueCount: generatedIssues.length,
      },
    );

    await appendScratchpad(scratchpadPath, "Generated Issues", [
      ...generatedIssues.map((entry) => `- ${entry.id}: ${entry.filePath}`),
      `- manifest: ${path.relative(ctx.workspaceDir, manifestPath)}`,
    ]);

    ctx.log({
      event: "research_published",
      runId,
      issueCount: generatedIssues.length,
    });

    return {
      status: "ok",
      data: {
        runId,
        runDir: path.relative(ctx.workspaceDir, runDir),
        scratchpadPath: path.relative(ctx.workspaceDir, scratchpadPath),
        manifestPath: path.relative(ctx.workspaceDir, manifestPath),
        pipelinePath: path.relative(ctx.workspaceDir, pipelinePath),
        repoPath,
        iterations: input.iterations,
        webResearch: input.webResearch,
        validateIdeas: input.validateIdeas,
        validationMode: input.validationMode,
        issues: generatedIssues,
      },
    };
  },
});
