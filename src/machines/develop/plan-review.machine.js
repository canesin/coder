import { access, readFile, writeFile } from "node:fs/promises";
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

export default defineMachine({
  name: "develop.plan_review",
  description:
    "Review PLAN.md and write PLANREVIEW.md with critique and verdict.",
  inputSchema: z.object({}),

  async execute(_input, ctx) {
    const state = loadState(ctx.workspaceDir);
    state.steps ||= {};
    const paths = artifactPaths(ctx.artifactsDir);

    if (!state.steps.wrotePlan) {
      throw new Error(
        "Precondition failed: PLAN.md does not exist. Run develop.planning first.",
      );
    }

    if (state.steps.wroteCritique) {
      const critiqueMd = (await access(paths.critique).then(() => true).catch(() => false))
        ? await readFile(paths.critique, "utf8")
        : "";
      return { status: "ok", data: { critiqueMd } };
    }

    const repoRoot = resolveRepoRoot(ctx.workspaceDir, state.repoPath);
    ctx.log({ event: "step3b_plan_review" });

    const { agentName: planReviewerName, agent: planReviewerAgent } =
      ctx.agentPool.getAgent("planReviewer", { scope: "repo" });

    if (planReviewerName === "gemini") {
      const rc = runPlanreview(repoRoot, paths.plan, paths.critique);
      if (rc !== 0) {
        ctx.log({ event: "plan_review_nonzero", exitCode: rc });
        if (!(await access(paths.critique).then(() => true).catch(() => false))) {
          throw new Error(
            `Plan review failed (exit code ${rc}) and produced no critique file.`,
          );
        }
      }
    } else {
      const reviewPrompt = `Review ${paths.plan} and write a critical plan critique to ${paths.critique}.

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
        timeoutMs: 1000 * 60 * 40,
      });
      requireExitZero(planReviewerName, "plan review failed", reviewRes);

      if (!(await access(paths.critique).then(() => true).catch(() => false))) {
        const cleaned = stripAgentNoise(reviewRes.stdout || "", {
          dropLeadingOnly: true,
        });
        const filtered = stripAgentNoise(cleaned).trim();
        if (!filtered)
          throw new Error(
            `${planReviewerName} plan review produced no critique output.`,
          );
        await writeFile(paths.critique, filtered + "\n", "utf8");
      }
    }

    state.steps.wroteCritique = true;
    saveState(ctx.workspaceDir, state);

    const planMd = (await access(paths.plan).then(() => true).catch(() => false))
      ? await readFile(paths.plan, "utf8")
      : "";
    const critiqueMd = (await access(paths.critique).then(() => true).catch(() => false))
      ? await readFile(paths.critique, "utf8")
      : "";

    maybeCheckpointWip(
      repoRoot,
      state.branch,
      ctx.config.workflow.wip,
      ctx.log,
    );
    return { status: "ok", data: { planMd, critiqueMd } };
  },
});
