import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { runPlanreview, stripAgentNoise } from "../../helpers.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import { withSessionResume } from "./_session.js";
import {
  artifactPaths,
  maybeCheckpointWip,
  requireExitZero,
  resolveRepoRoot,
} from "./_shared.js";

/**
 * Parse the Verdict section from a plan critique markdown string.
 * Scans the full text between the last Verdict heading and the next heading (or EOF)
 * to handle cases where the reviewer writes narrative before the verdict keyword.
 * Returns one of: "APPROVED", "REJECT", "REVISE", "PROCEED_WITH_CAUTION", "UNKNOWN".
 */
export function parsePlanVerdict(critiqueMd) {
  if (!critiqueMd) return "UNKNOWN";

  // Extract full Verdict sections (heading to next heading or EOF)
  const verdictSections = [];
  for (const match of critiqueMd.matchAll(
    /^#{1,6}\s+(?:\d+\.\s+)?Verdict\b[^\n]*/gim,
  )) {
    const sectionStart = match.index + match[0].length;
    // Find the next heading or EOF
    const rest = critiqueMd.slice(sectionStart);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const sectionText = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    verdictSections.push(sectionText);
  }

  // Fallback: inline "**Verdict**: VALUE" or "Verdict: VALUE"
  if (verdictSections.length === 0) {
    for (const match of critiqueMd.matchAll(
      /\*{0,2}Verdict\*{0,2}\s*[:-]\s*([^\n]+)/gi,
    )) {
      verdictSections.push(match[1]);
    }
  }

  if (verdictSections.length === 0) return "UNKNOWN";

  // Two-pass keyword extraction from the last verdict section:
  // Pass 1: scan lines bottom-up for lines that START with a verdict keyword
  //         (handles "REVISE\n\nNot approved until..." without false positives)
  // Pass 2: fall back to last-position-wins across the whole section
  //         (handles "The plan is APPROVED." on a single line)
  const raw = verdictSections[verdictSections.length - 1]
    .toUpperCase()
    .replace(/[*_`"'[\]()]/g, "");

  // Pass 1: line-start matching (most reliable)
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^[-•*]\s*/, "");
    if (/^APPROVED\b/.test(line)) return "APPROVED";
    if (/^REJECT\b/.test(line)) return "REJECT";
    if (/^REVISE\b/.test(line)) return "REVISE";
    if (/^PROCEED\b/.test(line)) return "PROCEED_WITH_CAUTION";
  }

  // Pass 2: last-position-wins across the section
  const kwPatterns = [
    { pattern: /\bAPPROVED\b/g, verdict: "APPROVED" },
    { pattern: /\bREJECT\b/g, verdict: "REJECT" },
    { pattern: /\bREVISE\b/g, verdict: "REVISE" },
    { pattern: /\bPROCEED\b/g, verdict: "PROCEED_WITH_CAUTION" },
    { pattern: /\bCAUTION\b/g, verdict: "PROCEED_WITH_CAUTION" },
  ];
  let bestVerdict = "UNKNOWN";
  let bestPos = -1;
  for (const { pattern, verdict } of kwPatterns) {
    let last = null;
    for (const m of raw.matchAll(pattern)) last = m;
    if (last && last.index > bestPos) {
      bestPos = last.index;
      bestVerdict = verdict;
    }
  }
  return bestVerdict;
}

export default defineMachine({
  name: "develop.plan_review",
  description:
    "Review PLAN.md and write PLANREVIEW.md with critique and verdict.",
  inputSchema: z.object({ round: z.number().int().nonnegative().default(0) }),

  async execute(input, ctx) {
    const state = await loadState(ctx.workspaceDir);
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

    // Use workspace scope so agent can access .coder/artifacts/ when repo_path is a subdir
    const { agentName: planReviewerName, agent: planReviewerAgent } =
      ctx.agentPool.getAgent("planReviewer", { scope: "workspace" });

    if (planReviewerName === "gemini") {
      // Use workspaceDir as cwd so Gemini can access .coder/artifacts/ when repo_path is subdir
      const runReview = ctx._runPlanreviewForTest ?? runPlanreview;
      const rc = runReview(ctx.workspaceDir, paths.plan, paths.critique);
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

      const reviewRes = await withSessionResume({
        agentName: planReviewerName,
        agent: planReviewerAgent,
        state,
        sessionKey: "planReviewSessionId",
        agentNameKey: "planReviewAgentName",
        workspaceDir: ctx.workspaceDir,
        log: ctx.log,
        executeFn: (sessionOpts) =>
          planReviewerAgent.execute(reviewPrompt, {
            ...sessionOpts,
            timeoutMs: ctx.config.workflow.timeouts.planReview,
          }),
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
    await saveState(ctx.workspaceDir, state);

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
