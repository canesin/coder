import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseAdrStatus, parseSpecGaps, parseSpecMeta } from "../../helpers.js";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  beginPipelineStep,
  endPipelineStep,
  initPipeline,
  initRunDirectory,
} from "./_shared.js";

export default defineMachine({
  name: "research.spec_ingest",
  description:
    "Spec-build pipeline entry point: determines mode (build vs ingest) and collects input data. " +
    "Provide existingSpecDir for ingest mode or researchRunId for build mode.",
  inputSchema: z.object({
    repoPath: z.string().default("."),
    existingSpecDir: z.string().default(""),
    researchRunId: z.string().default(""),
  }),

  async execute(input, ctx) {
    const repoRoot = path.resolve(ctx.workspaceDir, input.repoPath || ".");
    if (!existsSync(repoRoot)) {
      throw new Error(`Repo root does not exist: ${repoRoot}`);
    }

    const { runId, runDir, issuesDir, stepsDir, scratchpadPath, pipelinePath } =
      initRunDirectory(ctx.scratchpadDir);
    const pipeline = initPipeline(runId, pipelinePath);
    beginPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      "spec_ingest",
      {},
    );

    if (input.existingSpecDir) {
      const specDir = path.resolve(ctx.workspaceDir, input.existingSpecDir);
      if (!existsSync(specDir)) {
        throw new Error(`existingSpecDir does not exist: ${specDir}`);
      }

      const mdFiles = readdirSync(specDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({
          name: f,
          content: readFileSync(path.join(specDir, f), "utf8"),
        }));

      const decisionsDir = path.join(specDir, "decisions");
      const decisionFiles = existsSync(decisionsDir)
        ? readdirSync(decisionsDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => ({
              name: f,
              content: readFileSync(path.join(decisionsDir, f), "utf8"),
            }))
        : [];

      // Filter out synthetic domains emitted by build mode (overview, architecture)
      const SYNTHETIC_DOMAINS = new Set(["overview", "architecture"]);
      const parsedDomains = mdFiles
        .map((f) => {
          const meta = parseSpecMeta(f.content);
          if (!meta.domain || SYNTHETIC_DOMAINS.has(meta.domain)) return null;
          return {
            name: meta.domain,
            version: meta.version || "1",
            file: f.name,
          };
        })
        .filter(Boolean);

      const parsedDecisions = decisionFiles
        .map((f) => {
          const status = parseAdrStatus(f.content);
          return status
            ? { id: f.name.replace(/\.md$/, ""), status, file: f.name }
            : null;
        })
        .filter(Boolean);

      // Skip synthetic docs (overview, architecture) to avoid duplicate gaps —
      // architecture doc repeats every domain gap; only parse per-domain docs.
      const parsedGaps = mdFiles
        .filter((f) => {
          const meta = parseSpecMeta(f.content);
          return !meta.domain || !SYNTHETIC_DOMAINS.has(meta.domain);
        })
        .flatMap((f) => parseSpecGaps(f.content));

      endPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "spec_ingest",
        "completed",
        {
          mode: "ingest",
          domains: parsedDomains.length,
          gaps: parsedGaps.length,
        },
      );
      appendScratchpad(scratchpadPath, "Spec Ingest (ingest mode)", [
        `- specDir: ${specDir}`,
        `- domains: ${parsedDomains.length}`,
        `- decisions: ${parsedDecisions.length}`,
        `- gaps: ${parsedGaps.length}`,
      ]);

      return {
        status: "ok",
        data: {
          runId,
          runDir,
          stepsDir,
          issuesDir,
          scratchpadPath,
          pipelinePath,
          repoRoot,
          mode: "ingest",
          parsedDomains,
          parsedDecisions,
          parsedGaps,
        },
      };
    }

    if (input.researchRunId) {
      const manifestPath = path.join(
        ctx.scratchpadDir,
        input.researchRunId,
        "manifest.json",
      );
      if (!existsSync(manifestPath)) {
        throw new Error(
          `Research manifest not found: ${manifestPath}. Ensure the research run completed successfully.`,
        );
      }
      const researchManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

      // Inherit repoPath from the research manifest when the caller didn't
      // provide one explicitly (avoids monorepo root mismatch).
      const effectiveRepoPath =
        input.repoPath && input.repoPath !== "."
          ? input.repoPath
          : researchManifest.repoPath || input.repoPath || ".";
      const effectiveRepoRoot = path.resolve(
        ctx.workspaceDir,
        effectiveRepoPath,
      );

      endPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "spec_ingest",
        "completed",
        { mode: "build", researchRunId: input.researchRunId },
      );
      appendScratchpad(scratchpadPath, "Spec Ingest (build mode)", [
        `- researchRunId: ${input.researchRunId}`,
        `- issues: ${researchManifest.issues?.length || 0}`,
        `- repoPath: ${effectiveRepoPath}`,
      ]);

      return {
        status: "ok",
        data: {
          runId,
          runDir,
          stepsDir,
          issuesDir,
          scratchpadPath,
          pipelinePath,
          repoRoot: effectiveRepoRoot,
          repoPath: effectiveRepoPath,
          mode: "build",
          researchManifest,
        },
      };
    }

    throw new Error(
      "spec_ingest requires either existingSpecDir or researchRunId",
    );
  },
});
