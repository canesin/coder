import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseSpecDirectory } from "../../spec-parse.js";
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

      // Parse the spec directory using shared logic (same code as spec-check)
      const parsed = parseSpecDirectory(specDir);

      // Log any parsing issues as warnings (ingest is best-effort)
      for (const issue of parsed.issues) {
        ctx.log({
          event: "spec_ingest_parse_issue",
          level: issue.level === "error" ? "warn" : "info",
          file: issue.file,
          message: issue.message,
        });
      }

      // Filter domains that have no name (missing spec-meta entirely)
      const parsedDomains = parsed.parsedDomains.filter((d) => d.name);
      const { parsedDecisions, parsedGaps, parsedPhases } = parsed;
      const specManifest = parsed.manifest;

      // Recover repoPath from the spec's own manifest (monorepo support).
      const effectiveRepoPath =
        specManifest?.repoPath && specManifest.repoPath !== "."
          ? specManifest.repoPath
          : input.repoPath || ".";
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
        {
          mode: "ingest",
          domains: parsedDomains.length,
          gaps: parsedGaps.length,
          phases: parsedPhases.length,
        },
      );
      appendScratchpad(scratchpadPath, "Spec Ingest (ingest mode)", [
        `- specDir: ${specDir}`,
        `- domains: ${parsedDomains.length}`,
        `- decisions: ${parsedDecisions.length}`,
        `- gaps: ${parsedGaps.length}`,
        `- phases: ${parsedPhases.length}`,
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
          mode: "ingest",
          parsedDomains,
          parsedDecisions,
          parsedGaps,
          parsedPhases,
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
