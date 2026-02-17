import { z } from "zod";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  loadPipeline,
  resolveArtifact,
  runStructuredStep,
} from "./_shared.js";

export default defineMachine({
  name: "research.issue_synthesis",
  description:
    "Iterative draft/critique loop producing a validated issue backlog from research inputs. " +
    "Requires stepsDir/pipelinePath from context_gather. Auto-loads analysisBrief, webReferenceMap, validationResults from stepsDir.",
  inputSchema: z.object({
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
    repoRoot: z.string().min(1),
    clarifications: z.string().default(""),
    iterations: z.number().int().min(1).max(5).default(2),
    maxIssues: z.number().int().min(1).max(20).default(6),
    analysisBrief: z.any().default({}),
    webReferenceMap: z.any().default({}),
    validationResults: z.any().default({}),
  }),

  async execute(input, ctx) {
    const {
      stepsDir,
      scratchpadPath,
      pipelinePath,
      repoRoot,
      clarifications,
      iterations,
      maxIssues,
    } = input;
    const pipeline = loadPipeline(pipelinePath) || {
      version: 1,
      current: "issue_synthesis",
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
    const validationResults = resolveArtifact(
      input.validationResults,
      stepsDir,
      "validation-results",
    );

    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    let priorFeedback = [];
    let finalDraft = null;
    let finalReview = null;
    let prevIssueCount = 0;

    for (let i = 1; i <= iterations; i++) {
      const feedbackSection =
        priorFeedback.length > 0
          ? priorFeedback.map((f) => `- ${f}`).join("\n")
          : "(none)";

      // Draft
      ctx.log({ event: "research_draft_iteration", iteration: i });
      const draftPrompt = `Synthesize a research-ready issue backlog from validated inputs.

Repo root: ${repoRoot}
Pointer analysis:
${JSON.stringify(analysisBrief, null, 2)}

Web references:
${JSON.stringify(webReferenceMap, null, 2)}

Validation results:
${JSON.stringify(validationResults, null, 2)}

Clarifications:
${clarifications || "(none provided)"}

Feedback to incorporate:
${feedbackSection}

Rules:
- Return EXACTLY ${maxIssues} issues (or fewer only if the analysis genuinely warrants fewer).
- Keep issues small, independently verifiable, and dependency-light.
- Include references and validation metadata per issue.
- Do not use issues/ as scratch storage; this workflow uses .coder/scratchpad.
- Do NOT re-add issues that prior feedback explicitly asked to drop.
- Each issue MUST include a "testing_strategy" field. Search the codebase for existing test files covering related functionality before writing this. Include: existing tests to leverage, new tests to write with expected behavior, and the repo's test framework/conventions.

Return ONLY valid JSON in this schema:
{
  "issues": [
    {
      "id": "IDEA-01",
      "title": "string",
      "objective": "string",
      "problem": "string",
      "changes": ["string"],
      "verification": "string",
      "out_of_scope": ["string"],
      "depends_on": ["IDEA-00"],
      "priority": "P0|P1|P2|P3",
      "tags": ["string"],
      "estimated_effort": "string",
      "acceptance_criteria": ["string"],
      "testing_strategy": {
        "existing_tests": ["path/to/test — what it covers"],
        "new_tests": ["description of test to write and expected behavior"],
        "test_patterns": "brief note on repo's test framework/conventions"
      },
      "research_questions": ["string"],
      "risks": ["string"],
      "notes": "string",
      "references": [
        {
          "source": "github|show_hn|docs|other",
          "title": "string",
          "url": "string",
          "why": "string"
        }
      ],
      "validation": {
        "mode": "bug_repro|poc|analysis",
        "status": "passed|failed|inconclusive|not_run",
        "method": "string",
        "evidence": ["string"],
        "limitations": ["string"]
      }
    }
  ],
  "assumptions": ["string"],
  "open_questions": ["string"]
}`;
      const draftRes = await runStructuredStep({
        stepName: `draft_issue_backlog_${String(i).padStart(2, "0")}`,
        artifactName: `draft-${String(i).padStart(2, "0")}`,
        role: "issueSelector",
        prompt: draftPrompt,
        timeoutMs: 1000 * 60 * 10,
        ...stepOpts,
      });
      const draftPayload = draftRes.payload;
      if (
        !draftPayload ||
        !Array.isArray(draftPayload.issues) ||
        draftPayload.issues.length === 0
      ) {
        throw new Error(
          `${draftRes.agentName} returned no issues for pointers-based drafting.`,
        );
      }
      finalDraft = draftPayload;

      // Track count stability across iterations
      const currentCount = draftPayload.issues.length;
      if (i > 1 && prevIssueCount > 0 && currentCount !== prevIssueCount) {
        priorFeedback.push(
          `Issue count changed from ${prevIssueCount} to ${currentCount}. ` +
            `Stabilize at ${maxIssues} unless review explicitly asked to add/remove issues.`,
        );
      }
      prevIssueCount = currentCount;

      appendScratchpad(scratchpadPath, `Iteration ${i} Draft`, [
        `- agent: ${draftRes.agentName}`,
        `- candidate_issues: ${draftPayload.issues.length}`,
        `- draft_json: ${draftRes.relOutputPath}`,
      ]);

      // Skip critique on last iteration
      if (i >= iterations) break;

      // Critique
      ctx.log({ event: "research_critique_iteration", iteration: i });
      const reviewPrompt = `Critique this proposed issue backlog for sequencing, overlap, scope creep, weak references, and missing validation.

Backlog JSON:
${JSON.stringify(draftPayload, null, 2)}

Return ONLY valid JSON in this schema:
{
  "must_fix": ["string"],
  "should_fix": ["string"],
  "keep": ["string"],
  "reference_gaps": ["string"],
  "validation_gaps": ["string"],
  "testing_gaps": ["string"],
  "notes": "string"
}`;
      const reviewRes = await runStructuredStep({
        stepName: `review_issue_backlog_${String(i).padStart(2, "0")}`,
        artifactName: `review-${String(i).padStart(2, "0")}`,
        role: "planReviewer",
        prompt: reviewPrompt,
        timeoutMs: 1000 * 60 * 8,
        ...stepOpts,
      });
      finalReview = reviewRes.payload;

      const mustFix = Array.isArray(finalReview?.must_fix)
        ? finalReview.must_fix
        : [];
      const shouldFix = Array.isArray(finalReview?.should_fix)
        ? finalReview.should_fix
        : [];
      const referenceGaps = Array.isArray(finalReview?.reference_gaps)
        ? finalReview.reference_gaps
        : [];
      const validationGaps = Array.isArray(finalReview?.validation_gaps)
        ? finalReview.validation_gaps
        : [];
      const testingGaps = Array.isArray(finalReview?.testing_gaps)
        ? finalReview.testing_gaps
        : [];
      priorFeedback = [
        ...mustFix,
        ...shouldFix,
        ...referenceGaps,
        ...validationGaps,
        ...testingGaps,
      ]
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 30);

      appendScratchpad(scratchpadPath, `Iteration ${i} Critique`, [
        `- agent: ${reviewRes.agentName}`,
        `- must_fix: ${mustFix.length}`,
        `- should_fix: ${shouldFix.length}`,
        `- reference_gaps: ${referenceGaps.length}`,
        `- validation_gaps: ${validationGaps.length}`,
        `- testing_gaps: ${testingGaps.length}`,
        `- review_json: ${reviewRes.relOutputPath}`,
      ]);
    }

    return {
      status: "ok",
      data: {
        finalDraft,
        finalReview,
        priorFeedback,
        selectedIssues: finalDraft.issues.slice(0, maxIssues),
      },
    };
  },
});
