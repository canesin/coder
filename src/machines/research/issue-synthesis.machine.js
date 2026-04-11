import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sanitizeUserData } from "../../helpers.js";
import { checkCancel, defineMachine } from "../_base.js";
import {
  appendScratchpad,
  ensureArtifactOnDisk,
  loadPipeline,
  loadSessionState,
  loadStepArtifact,
  requirePayloadFields,
  resolveArtifact,
  runStructuredStep,
  saveSessionState,
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

    const runDir = path.dirname(stepsDir);
    const sessionState = loadSessionState(runDir);
    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    let priorFeedback = [];
    let finalDraft = null;
    let finalReview = null;
    let prevIssueCount = 0;

    // Ensure artifacts are on disk for agent file-path references (once, before loop)
    const briefPath = ensureArtifactOnDisk(
      stepsDir,
      "analysis-brief",
      analysisBrief,
    );
    const webRefPath = ensureArtifactOnDisk(
      stepsDir,
      "web-references",
      webReferenceMap,
    );
    const validationPath = ensureArtifactOnDisk(
      stepsDir,
      "validation-results",
      validationResults,
    );

    for (let i = 1; i <= iterations; i++) {
      // Skip already-completed iterations (resume support)
      const iterKey = `synthesis_iteration_${i}`;
      if (pipeline.steps[iterKey]?.status === "completed") {
        finalDraft =
          loadStepArtifact(stepsDir, `draft-${String(i).padStart(2, "0")}`) ||
          finalDraft;
        ctx.log({ event: "research_iteration_skipped", iteration: i });
        continue;
      }

      checkCancel(ctx);

      const feedbackSection =
        priorFeedback.length > 0
          ? priorFeedback.map((f) => `- ${f}`).join("\n")
          : "(none)";

      // Draft
      ctx.log({ event: "research_draft_iteration", iteration: i });
      const draftPrompt = `Synthesize a research-ready issue backlog from validated inputs.

Repo root: ${repoRoot}

## Input artifacts (read these)
- Pointer analysis: ${briefPath}
- Web references: ${webRefPath}
- Validation results: ${validationPath}

Clarifications:
<user-data field="clarifications">${sanitizeUserData(clarifications || "(none provided)")}</user-data>

Feedback to incorporate:
<user-data field="feedback">${sanitizeUserData(feedbackSection)}</user-data>

## Phase 1: Codebase exploration (mandatory)
Before drafting, explore the codebase at \`${repoRoot}\` — identify the
test framework and conventions, project structure and key modules,
existing implementations related to the problem spaces in the analysis
brief, and file paths the issues should reference.

## Phase 2: Issue drafting
Ground every issue in actual files and patterns you found.

Rules:
- Return EXACTLY ${maxIssues} issues (fewer only if the analysis warrants).
- Keep issues small, independently verifiable, dependency-light.
- Include references and validation metadata per issue.
- Use .coder/scratchpad for scratch notes, not \`issues/\`.
- Do NOT re-add issues prior feedback asked to drop.
- For new features, prefer brute-force / simple-data-structure for the
  first issue UNLESS the analysis brief, validation results, or user
  clarifications name an explicit performance or scale requirement the
  simple version wouldn't meet. Only split optimization into a
  follow-up when the simple version is already correct for the stated
  constraints; when you do split, the follow-up's objective must name
  a measurement target (baseline + goal).
- Each issue MUST include "testing_strategy" grounded in real test files:
  existing tests to leverage (paths + what they cover), new tests to
  write with expected behavior, and the repo's test framework/conventions.

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
        timeoutMs: ctx.config?.workflow?.timeouts?.researchStep ?? 60_000,
        ...stepOpts,
        sessionState,
        sessionKey: "synthesisDraftSessionId",
      });
      saveSessionState(runDir, sessionState);
      const draftPayload = requirePayloadFields(
        draftRes.payload,
        { issues: "array" },
        `draft_issue_backlog_${i}`,
      );
      if (draftPayload.issues.length === 0) {
        throw new Error(
          `${draftRes.agentName} returned empty issues array for pointers-based drafting.`,
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

      // Skip critique on last iteration — mark completed and break
      if (i >= iterations) {
        pipeline.steps[iterKey] = {
          status: "completed",
          completedAt: new Date().toISOString(),
        };
        writeFileSync(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
        break;
      }

      // Critique
      ctx.log({ event: "research_critique_iteration", iteration: i });
      const reviewPrompt = `Critique this proposed issue backlog for sequencing, overlap, scope creep, weak references, and missing validation.

Read the draft backlog from: ${draftRes.outputPath}

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
        timeoutMs: ctx.config?.workflow?.timeouts?.researchStep ?? 60_000,
        ...stepOpts,
        sessionState,
        sessionKey: "synthesisCritiqueSessionId",
      });
      saveSessionState(runDir, sessionState);
      finalReview = requirePayloadFields(
        reviewRes.payload,
        { must_fix: "array", should_fix: "array" },
        `review_issue_backlog_${i}`,
      );

      const mustFix = finalReview.must_fix;
      const shouldFix = finalReview.should_fix;
      const referenceGaps = Array.isArray(finalReview.reference_gaps)
        ? finalReview.reference_gaps
        : [];
      const validationGaps = Array.isArray(finalReview.validation_gaps)
        ? finalReview.validation_gaps
        : [];
      const testingGaps = Array.isArray(finalReview.testing_gaps)
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

      // Mark iteration complete in pipeline
      pipeline.steps[iterKey] = {
        status: "completed",
        completedAt: new Date().toISOString(),
      };
      writeFileSync(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
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
