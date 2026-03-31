import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { checkCancel, defineMachine } from "../_base.js";
import {
  appendScratchpad,
  ensureArtifactOnDisk,
  loadPipeline,
  normalizeVerdict,
  requirePayloadFields,
  resolveArtifact,
  runStructuredStep,
  sanitizeFilenameSegment,
} from "./_shared.js";

export default defineMachine({
  name: "research.issue_critique",
  description:
    "Standalone tool: review and score an issue backlog with structured critique. " +
    "Not part of the automated pipeline (issue_synthesis has its own built-in critique loop). " +
    "Auto-loads analysisBrief, webReferenceMap, validationResults from stepsDir.",

  inputSchema: z.object({
    issues: z.array(z.any()).min(1).describe("Issue drafts to critique"),
    repoRoot: z.string().min(1),
    analysisBrief: z.any().default({}),
    webReferenceMap: z.any().default({}),
    validationResults: z.any().default({}),
    priorFeedback: z
      .array(z.string())
      .default([])
      .describe("Feedback from previous iterations"),
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
  }),

  async execute(input, ctx) {
    const pipeline = loadPipeline(input.pipelinePath) || {
      version: 1,
      runId: "issue-critique",
      current: "init",
      history: [],
      steps: {},
    };
    const analysisBrief = resolveArtifact(
      input.analysisBrief,
      input.stepsDir,
      "analysis-brief",
    );
    const webReferenceMap = resolveArtifact(
      input.webReferenceMap,
      input.stepsDir,
      "web-references",
    );
    const validationResults = resolveArtifact(
      input.validationResults,
      input.stepsDir,
      "validation-results",
    );

    checkCancel(ctx);

    // Write issues to file for agent to read (instead of inlining/truncating)
    const issuesPath = path.join(
      input.stepsDir,
      `${sanitizeFilenameSegment("critique-input-issues")}.json`,
    );
    writeFileSync(issuesPath, `${JSON.stringify(input.issues, null, 2)}\n`);

    // Ensure research artifacts are on disk
    const hasContent = (v) =>
      v != null && typeof v === "object" && Object.keys(v).length > 0;
    const briefPath = ensureArtifactOnDisk(
      input.stepsDir,
      "analysis-brief",
      analysisBrief,
    );
    const webRefPath = ensureArtifactOnDisk(
      input.stepsDir,
      "web-references",
      webReferenceMap,
    );
    const validationPath = ensureArtifactOnDisk(
      input.stepsDir,
      "validation-results",
      validationResults,
    );

    const priorFeedbackSection =
      input.priorFeedback.length > 0
        ? `## Prior Feedback (address these)\n${input.priorFeedback.map((f) => `- ${f}`).join("\n")}`
        : "";

    const prompt = `You are a senior engineering reviewer. Critique this issue backlog for completeness, correctness, and actionability.

## Input Artifacts (read these files)
- Issue backlog: ${issuesPath}
${hasContent(analysisBrief) ? `- Analysis brief: ${briefPath}` : "- Analysis brief: (not available)"}
${hasContent(webReferenceMap) ? `- Web references: ${webRefPath}` : "- Web references: (not available)"}
${hasContent(validationResults) ? `- Validation results: ${validationPath}` : "- Validation results: (not available)"}

${priorFeedbackSection}

## Phase 1: Codebase Exploration (MANDATORY)
Before critiquing, explore the codebase at \`${input.repoRoot}\` to verify the issues:
- Check that files and modules referenced in issues actually exist
- Verify that architecture patterns described in issues match the real codebase
- Confirm test file paths and test framework conventions are accurate

## Review Criteria
1. **Completeness**: Does each issue have clear scope, acceptance criteria, verification command?
2. **Dependencies**: Are dependency chains correct? Any circular dependencies?
3. **Sizing**: Are issues appropriately sized (not too large, not too small)?
4. **Overlap**: Do any issues duplicate work?
5. **Gaps**: Are there missing issues needed to achieve the overall goal?
6. **Actionability**: Can a developer pick up each issue and start working immediately?
7. **Risk**: Are high-risk items identified and mitigated?
8. **Testing**: Does each issue include a testing strategy with references to existing tests and concrete new tests to write?
9. **Codebase Grounding**: Do issues reference real files and patterns from the actual codebase?

Return JSON:
{
  "verdict": "approve" | "revise",
  "overallScore": 1-10,
  "issueReviews": [
    {
      "issueIndex": 0,
      "title": "issue title",
      "verdict": "approve" | "revise" | "drop" | "split",
      "score": 1-10,
      "strengths": ["strength1"],
      "weaknesses": ["weakness1"],
      "suggestions": ["suggestion1"],
      "missingFields": ["field1"]
    }
  ],
  "backlogIssues": {
    "circularDeps": ["description of any circular dependencies"],
    "gaps": ["missing issue descriptions"],
    "overlaps": ["overlapping issue pairs"],
    "orderSuggestions": ["reordering suggestions"]
  },
  "summary": "overall assessment",
  "feedback": ["actionable feedback items for next iteration"]
}`;

    const { payload, agentName } = await runStructuredStep({
      stepName: "issue_critique",
      role: "planReviewer",
      prompt,
      timeoutMs: ctx.config?.workflow?.timeouts?.researchStep ?? 60_000,
      stepsDir: input.stepsDir,
      scratchpadPath: input.scratchpadPath,
      pipeline,
      pipelinePath: input.pipelinePath,
      ctx,
    });

    // Enforce output contract — deterministic verdict + required fields
    requirePayloadFields(
      payload,
      { verdict: "string", issueReviews: "array" },
      "issue_critique",
    );
    const verdict = normalizeVerdict(
      payload.verdict,
      ["approve", "revise"],
      "revise",
    );

    appendScratchpad(input.scratchpadPath, "Issue Critique", [
      `- agent: ${agentName}`,
      `- verdict: ${verdict}`,
      `- score: ${payload.overallScore || "unknown"}`,
      `- issues_reviewed: ${payload.issueReviews.length}`,
      `- gaps_found: ${(payload.backlogIssues?.gaps || []).length}`,
    ]);

    return {
      status: "ok",
      data: {
        verdict,
        overallScore: payload.overallScore || 0,
        issueReviews: payload.issueReviews,
        backlogIssues: payload.backlogIssues || {},
        summary: payload.summary || "",
        feedback: payload.feedback || [],
      },
    };
  },
});
