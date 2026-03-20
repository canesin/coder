import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import {
  formatCommandFailure,
  runPlanreview,
  stripAgentNoise,
} from "../../helpers.js";
import { loadState, saveState } from "../../state/workflow-state.js";
import { defineMachine } from "../_base.js";
import { withSessionResume } from "./_session.js";
import {
  artifactPaths,
  buildStepCliOpts,
  maybeCheckpointWip,
  resolveRepoRoot,
} from "./_shared.js";

export function buildPlanReviewExecuteOpts(ctx) {
  return buildStepCliOpts(ctx.config.workflow.timeouts.planReview);
}

const LOG_TRUNC = 500;

function truncateLogMsg(s) {
  return String(s ?? "").slice(0, LOG_TRUNC);
}

function readArtifactDirSample(artifactsDir, limit = 40) {
  try {
    if (!existsSync(artifactsDir)) return [];
    return readdirSync(artifactsDir).slice(0, limit);
  } catch {
    return [];
  }
}

/** Single log for thrown execute failures or nonzero exit (§2b — no double-log with exit check). */
function logPlanReviewExecuteFailed(ctx, opts) {
  const { err, res, round, critiquePath, planPath } = opts;
  const payload = {
    event: "plan_review_execute_failed",
    errorName: err?.name ?? "Error",
    errorMessage: truncateLogMsg(err?.message ?? err),
    round,
    critiquePath,
    planPath,
    isCommandTimeout: err?.name === "CommandTimeoutError",
  };
  if (res && typeof res.exitCode === "number") {
    payload.exitCode = res.exitCode;
    payload.stdoutLen = (res.stdout || "").length;
    payload.stderrLen = (res.stderr || "").length;
  } else if (err) {
    // Sandbox fatal / throwOnNonZero errors attach err.stdout / err.stderr
    if (typeof err.stdout === "string") payload.stdoutLen = err.stdout.length;
    if (typeof err.stderr === "string") payload.stderrLen = err.stderr.length;
  }
  ctx.log(payload);
}

function logCritiqueMissingAfterReview(ctx, opts) {
  ctx.log({
    event: "critique_missing_after_review",
    critiquePath: opts.critiquePath,
    planPath: opts.planPath,
    artifactsDir: opts.artifactsDir,
    repoPath: opts.repoPath ?? null,
    artifactDirEntries: readArtifactDirSample(opts.artifactsDir),
    stdoutLen: (opts.reviewRes?.stdout || "").length,
    stderrLen: (opts.reviewRes?.stderr || "").length,
    exitCode: opts.reviewRes?.exitCode,
    round: opts.round,
  });
}

function critiqueStdoutStrippedEmpty(reviewRes) {
  const cleaned = stripAgentNoise(reviewRes.stdout || "", {
    dropLeadingOnly: true,
  });
  return stripAgentNoise(cleaned).trim().length === 0;
}

function tryWriteCritiqueFromStdout(reviewRes, critiquePath) {
  if (existsSync(critiquePath)) return;
  const cleaned = stripAgentNoise(reviewRes.stdout || "", {
    dropLeadingOnly: true,
  });
  const filtered = stripAgentNoise(cleaned).trim();
  if (!filtered) return;
  writeFileSync(critiquePath, `${filtered}\n`, "utf8");
}

/**
 * Fresh-session retry: same task spec as the primary review prompt so the agent
 * reads PLAN.md and applies round/constraints — not a generic template critique.
 */
function buildCritiqueRetryPrompt(planPath, critiquePath, round) {
  const roundNote =
    round > 0
      ? `\n\nNote: This is revision round ${round + 1}. The prior plan was rejected. Focus on whether the issues from the prior critique have been addressed.`
      : "";

  return (
    `You are resuming plan review in a **fresh session**. The prior attempt exited successfully but did not create ${critiquePath} and produced no capturable critique in output.\n\n` +
    `1. Read the implementation plan at **${planPath}** in full.\n` +
    `2. Write a critical plan critique as markdown to **${critiquePath}**.${roundNote}\n\n` +
    `Required sections (in order):\n` +
    `1. Critical Issues (Must Fix)\n` +
    `2. Over-Engineering Concerns\n` +
    `3. Concerns (Should Address)\n` +
    `4. Questions (Need Clarification)\n` +
    `5. Verdict (REJECT | REVISE | PROCEED WITH CAUTION | APPROVED)\n\n` +
    `Constraints:\n` +
    `- Do not modify tracked files.\n` +
    `- Keep critique concrete with file-level references when possible.\n` +
    `- Write markdown content directly to ${critiquePath}.`
  );
}

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
  // Handle common paraphrases from models that don't follow exact keyword format
  if (
    /\bNEEDS?\s+REWORK\b/.test(raw) ||
    /\bNEEDS?\s+REVISION\b/.test(raw) ||
    /\bREWORK\b/.test(raw)
  )
    return "REVISE";
  if (/\bNEEDS?\s+MAJOR\b/.test(raw) || /\bMAJOR\s+REWORK\b/.test(raw))
    return "REJECT";
  if (/\bMINOR\s+ISSUES?\b/.test(raw) || /\bLOOKS?\s+GOOD\b/.test(raw))
    return "PROCEED_WITH_CAUTION";
  return "UNKNOWN";
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

      const basePromptBody = `Review ${paths.plan} and write a critical plan critique to ${paths.critique}.${roundNote}

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

      const strictRetryNote = `\n\nCRITICAL: You MUST create or overwrite ${paths.critique} with the full critique markdown. Empty output or a summary-only reply is not acceptable.`;

      const reviewCli = buildPlanReviewExecuteOpts(ctx);

      const removeWhitespaceOnlyCritique = () => {
        if (!existsSync(paths.critique)) return;
        try {
          const trimmed = stripAgentNoise(
            readFileSync(paths.critique, "utf8"),
          ).trim();
          if (trimmed.length === 0) {
            rmSync(paths.critique, { force: true });
          }
        } catch {
          /* best-effort — treat as missing and fall through */
        }
      };

      const runReviewRound = async (prompt) => {
        let reviewRes;
        try {
          reviewRes = await withSessionResume({
            agentName: planReviewerName,
            agent: planReviewerAgent,
            state,
            sessionKey: "planReviewSessionId",
            agentNameKey: "planReviewAgentName",
            workspaceDir: ctx.workspaceDir,
            log: ctx.log,
            executeFn: (sessionOpts) =>
              planReviewerAgent.execute(prompt, {
                ...sessionOpts,
                ...reviewCli,
              }),
          });
        } catch (err) {
          logPlanReviewExecuteFailed(ctx, {
            err,
            res: null,
            round: input.round,
            critiquePath: paths.critique,
            planPath: paths.plan,
          });
          throw err;
        }
        if (reviewRes.exitCode !== 0) {
          const failErr = new Error(
            formatCommandFailure(
              `${planReviewerName} plan review failed`,
              reviewRes,
            ),
          );
          logPlanReviewExecuteFailed(ctx, {
            err: failErr,
            res: reviewRes,
            round: input.round,
            critiquePath: paths.critique,
            planPath: paths.plan,
          });
          throw failErr;
        }
        return reviewRes;
      };

      let reviewRes = await runReviewRound(basePromptBody);
      removeWhitespaceOnlyCritique();
      tryWriteCritiqueFromStdout(reviewRes, paths.critique);

      if (
        !existsSync(paths.critique) &&
        critiqueStdoutStrippedEmpty(reviewRes)
      ) {
        ctx.log({
          event: "critique_retry_empty_output",
          round: input.round,
          critiquePath: paths.critique,
        });
        state.planReviewSessionId = null;
        await saveState(ctx.workspaceDir, state);
        ctx.log(
          state.sessionsDisabled
            ? {
                event: "critique_retry_sessionless",
                round: input.round,
                critiquePath: paths.critique,
                reason: "sessions_disabled",
              }
            : {
                event: "critique_retry_fresh_session",
                round: input.round,
              },
        );
        reviewRes = await runReviewRound(
          buildCritiqueRetryPrompt(paths.plan, paths.critique, input.round),
        );
        removeWhitespaceOnlyCritique();
        tryWriteCritiqueFromStdout(reviewRes, paths.critique);
      } else if (
        !existsSync(paths.critique) &&
        !critiqueStdoutStrippedEmpty(reviewRes)
      ) {
        ctx.log({ event: "plan_review_empty_retry", attempt: 1 });
        reviewRes = await runReviewRound(basePromptBody + strictRetryNote);
        removeWhitespaceOnlyCritique();
        tryWriteCritiqueFromStdout(reviewRes, paths.critique);
      }

      if (!existsSync(paths.critique)) {
        const cleaned = stripAgentNoise(reviewRes.stdout || "", {
          dropLeadingOnly: true,
        });
        const filtered = stripAgentNoise(cleaned).trim();
        if (!filtered) {
          logCritiqueMissingAfterReview(ctx, {
            critiquePath: paths.critique,
            planPath: paths.plan,
            artifactsDir: ctx.artifactsDir,
            repoPath: state.repoPath,
            reviewRes,
            round: input.round,
          });
          throw new Error(
            `${planReviewerName} plan review produced no critique output. ` +
              `See log event critique_missing_after_review for paths and stream lengths.`,
          );
        }
        writeFileSync(paths.critique, `${filtered}\n`, "utf8");
      }

      if (
        stripAgentNoise(readFileSync(paths.critique, "utf8")).trim().length ===
        0
      ) {
        const err = new Error(
          `${planReviewerName} plan review produced no critique output.`,
        );
        err.code = "PLAN_REVIEW_EMPTY_OUTPUT";
        throw err;
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
