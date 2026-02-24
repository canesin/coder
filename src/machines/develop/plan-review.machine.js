import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { runPlanreview, stripAgentNoise } from "../../helpers.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import {
  artifactPaths,
  maybeCheckpointWip,
  requireExitZero,
  resolveRepoRoot,
} from "./_shared.js";

/**
 * Parse the Verdict section from a plan critique markdown string.
 * Takes the last match to avoid false positives from prompt examples in the header.
 * Returns one of: "APPROVED", "REJECT", "REVISE", "PROCEED_WITH_CAUTION", "UNKNOWN".
 */
export function parsePlanVerdict(critiqueMd) {
  if (!critiqueMd) return "UNKNOWN";

  const verdictLines = [];
  // Match heading-based verdict sections: "## [N.] Verdict" then value on next non-empty line
  for (const match of critiqueMd.matchAll(
    /^#{1,6}\s+(?:\d+\.\s+)?Verdict\b[^\n]*\n\s*([^\n]+)/gim,
  )) {
    verdictLines.push(match[1]);
  }

  // Fallback: inline "**Verdict**: VALUE" or "Verdict: VALUE"
  if (verdictLines.length === 0) {
    for (const match of critiqueMd.matchAll(
      /\*{0,2}Verdict\*{0,2}\s*[:-]\s*([^\n]+)/gi,
    )) {
      verdictLines.push(match[1]);
    }
  }

  if (verdictLines.length === 0) return "UNKNOWN";

  const raw = verdictLines[verdictLines.length - 1]
    .trim()
    .toUpperCase()
    .replace(/[*_`[\]()]/g, "");
  if (/\bAPPROVED\b/.test(raw)) return "APPROVED";
  if (/\bREJECT\b/.test(raw)) return "REJECT";
  if (/\bREVISE\b/.test(raw)) return "REVISE";
  if (/\bPROCEED\b/.test(raw) || /\bCAUTION\b/.test(raw))
    return "PROCEED_WITH_CAUTION";
  return "UNKNOWN";
}

export default defineMachine({
  name: "develop.plan_review",
  description:
    "Review PLAN.md and write PLANREVIEW.md with critique and verdict.",
  inputSchema: z.object({ round: z.number().int().nonnegative().default(0) }),

  async execute(input, ctx) {
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};
    const paths = artifactPaths(ctx.artifactsDir);

    if (!state.steps.wrotePlan) {
      throw new Error(
        "Precondition failed: PLAN.md does not exist. Run develop.planning first.",
      );
    }

    if (state.steps.wroteCritique) {
      const planMd = existsSync(paths.plan)
        ? readFileSync(paths.plan, "utf8")
        : "";
      const critiqueMd = existsSync(paths.critique)
        ? readFileSync(paths.critique, "utf8")
        : "";
      return {
        status: "ok",
        data: { planMd, critiqueMd, verdict: parsePlanVerdict(critiqueMd) },
      };
    }

    const repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath);
    ctx.log({ event: "step3b_plan_review" });

    const { agentName: planReviewerName, agent: planReviewerAgent } =
      ctx.agentPool.getAgent("planReviewer", { scope: "repo" });

    if (planReviewerName === "gemini") {
      const rc = runPlanreview(repoRoot, paths.plan, paths.critique);
      if (rc !== 0) {
        ctx.log({ event: "plan_review_nonzero", exitCode: rc });
        if (!existsSync(paths.critique)) {
          throw new Error(
            `Plan review failed (exit code ${rc}) and produced no critique file.`,
          );
        }
      }
    } else {
      const roundNote =
        input.round > 0
          ? `\n\nNote: This is revision round ${input.round + 1}. The prior plan was rejected. Focus on whether the issues from the prior critique have been addressed.`
          : "";

      const reviewPrompt = `Review ${paths.plan} and write a critical plan critique to ${paths.critique}.${roundNote}

Required sections (in order):
1. Critical Issues (Must Fix)
2. Over-Engineering Concerns
3. Concerns (Should Address)
4. Questions (Need Clarification)
5. Verdict (REJECT | REVISE | PROCEED WITH CAUTION | APPROVED)

Constraints:
- Do not modify tracked files.
- Keep critique concrete with file-level references when possible.
- Write markdown content directly to ${paths.critique}.`;

      const reviewRes = await planReviewerAgent.execute(reviewPrompt, {
        timeoutMs: ctx.config.workflow.timeouts.planReview,
      });
      requireExitZero(planReviewerName, "plan review failed", reviewRes);

      if (!existsSync(paths.critique)) {
        const cleaned = stripAgentNoise(reviewRes.stdout || "", {
          dropLeadingOnly: true,
        });
        const filtered = stripAgentNoise(cleaned).trim();
        if (!filtered)
          throw new Error(
            `${planReviewerName} plan review produced no critique output.`,
          );
        writeFileSync(paths.critique, filtered + "\n", "utf8");
      }
    }

    state.steps.wroteCritique = true;
    saveState(ctx.workspaceDir, state);

    const planMd = existsSync(paths.plan)
      ? readFileSync(paths.plan, "utf8")
      : "";
    const critiqueMd = existsSync(paths.critique)
      ? readFileSync(paths.critique, "utf8")
      : "";

    maybeCheckpointWip(
      repoRoot,
      state.branch,
      ctx.config.workflow.wip,
      ctx.log,
    );
    return {
      status: "ok",
      data: { planMd, critiqueMd, verdict: parsePlanVerdict(critiqueMd) },
    };
  },
});
