import { writeFile } from "node:fs/promises";
import path from "node:path";
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
    const { agentName, agent } = ctx.agentPool.getAgent("planReviewer", {
      scope: "workspace",
    });

    const pipeline = (await loadPipeline(input.pipelinePath)) || {
      version: 1,
      runId: "issue-critique",
      current: "init",
      history: [],
      steps: {},
    };
    const _analysisBrief = await resolveArtifact(
      input.analysisBrief,
      input.stepsDir,
      "analysis-brief",
    );
    const _webReferenceMap = await resolveArtifact(
      input.webReferenceMap,
      input.stepsDir,
      "web-references",
    );
    const validationResults = await resolveArtifact(
      input.validationResults,
      input.stepsDir,
      "validation-results",
    );

    await beginPipelineStep(
      pipeline,
      input.pipelinePath,
      input.scratchpadPath,
      "issue_critique",
      { agent: agentName, issueCount: input.issues.length },
    );

    const issuesSummary = input.issues
      .map(
        (issue, i) =>
          `### Issue ${i + 1}: ${issue.title || issue.id || `issue-${i}`}\n` +
          `- Priority: ${issue.priority || "P2"}\n` +
          `- Objective: ${(issue.objective || "").slice(0, 200)}\n` +
          `- Changes: ${(issue.changes || []).join(", ").slice(0, 200)}\n` +
          `- Dependencies: ${(issue.depends_on || []).join(", ") || "none"}`,
      )
      .join("\n\n");

    const priorFeedbackSection =
      input.priorFeedback.length > 0
        ? `## Prior Feedback (address these)\n${input.priorFeedback.map((f) => `- ${f}`).join("\n")}`
        : "";

    const validationSummary =
      typeof validationResults === "object" && validationResults
        ? JSON.stringify(validationResults).slice(0, 2000)
        : "";

    const prompt = `You are a senior engineering reviewer. Critique this issue backlog for completeness, correctness, and actionability.

## Issue Backlog
${issuesSummary}

${priorFeedbackSection}

## Validation Results
${validationSummary || "No validation data available."}

## Review Criteria
1. **Completeness**: Does each issue have clear scope, acceptance criteria, verification command?
2. **Dependencies**: Are dependency chains correct? Any circular dependencies?
3. **Sizing**: Are issues appropriately sized (not too large, not too small)?
4. **Overlap**: Do any issues duplicate work?
5. **Gaps**: Are there missing issues needed to achieve the overall goal?
6. **Actionability**: Can a developer pick up each issue and start working immediately?
7. **Risk**: Are high-risk items identified and mitigated?
8. **Testing**: Does each issue include a testing strategy with references to existing tests and concrete new tests to write?

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

    const res = await agent.executeWithRetry(prompt, {
      timeoutMs: 1000 * 60 * 8,
    });
    requireExitZero(agentName, "issue_critique", res);

    const payload = parseAgentPayload(agentName, res.stdout);

    // Save critique artifact
    const critiquePath = path.join(input.stepsDir, "issue-critique.json");
    await writeFile(critiquePath, `${JSON.stringify(payload, null, 2)}\n`);

    await appendScratchpad(input.scratchpadPath, "Issue Critique", [
      `- agent: ${agentName}`,
      `- verdict: ${payload?.verdict || "unknown"}`,
      `- score: ${payload?.overallScore || "unknown"}`,
      `- issues_reviewed: ${(payload?.issueReviews || []).length}`,
      `- gaps_found: ${(payload?.backlogIssues?.gaps || []).length}`,
    ]);

    await endPipelineStep(
      pipeline,
      input.pipelinePath,
      input.scratchpadPath,
      "issue_critique",
      "completed",
      { agent: agentName, verdict: payload?.verdict },
    );

    return {
      status: "ok",
      data: {
        verdict: payload?.verdict || "revise",
        overallScore: payload?.overallScore || 0,
        issueReviews: payload?.issueReviews || [],
        backlogIssues: payload?.backlogIssues || {},
        summary: payload?.summary || "",
        feedback: payload?.feedback || [],
      },
    };
  },
});
