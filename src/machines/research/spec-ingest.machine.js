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
    "Spec-build pipeline entry point: determines mode (build, ingest, or update) and collects input data. " +
    "Provide existingSpecDir for ingest mode, researchRunId for build mode, or updateDoc + existingSpecDir for update mode.",
  inputSchema: z.object({
    repoPath: z.string().default("."),
    existingSpecDir: z.string().default(""),
    researchRunId: z.string().default(""),
    updateDoc: z.string().default(""),
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

    // UPDATE mode: updateDoc + existingSpecDir together
    if (input.updateDoc && input.existingSpecDir) {
      const specDir = path.resolve(ctx.workspaceDir, input.existingSpecDir);
      if (!existsSync(specDir)) {
        throw new Error(`existingSpecDir does not exist: ${specDir}`);
      }
      const updateDocPath = path.resolve(ctx.workspaceDir, input.updateDoc);
      if (!existsSync(updateDocPath)) {
        throw new Error(`updateDoc does not exist: ${updateDocPath}`);
      }

      const updateDocContent = readFileSync(updateDocPath, "utf8");

      // Read all spec markdown files as raw text (no rigid parsing)
      const specFiles = readdirSync(specDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({
          name: f,
          content: readFileSync(path.join(specDir, f), "utf8"),
        }));

      // Also read markdown from subdirectories (decisions/, phases/) if present
      for (const subdir of ["decisions", "phases"]) {
        const subdirPath = path.join(specDir, subdir);
        if (existsSync(subdirPath)) {
          for (const f of readdirSync(subdirPath)
            .filter((f) => f.endsWith(".md"))
            .sort()) {
            specFiles.push({
              name: `${subdir}/${f}`,
              content: readFileSync(path.join(subdirPath, f), "utf8"),
            });
          }
        }
      }

      endPipelineStep(
        pipeline,
        pipelinePath,
        scratchpadPath,
        "spec_ingest",
        "completed",
        {
          mode: "update",
          specFiles: specFiles.length,
          updateDocChars: updateDocContent.length,
        },
      );
      appendScratchpad(scratchpadPath, "Spec Ingest (update mode)", [
        `- specDir: ${specDir}`,
        `- updateDoc: ${updateDocPath}`,
        `- specFiles: ${specFiles.length}`,
        `- updateDocChars: ${updateDocContent.length}`,
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
          repoPath: input.repoPath || ".",
          mode: "update",
          updateDocContent,
          specFiles,
        },
      };
    }

    if (input.existingSpecDir) {
      const specDir = path.resolve(ctx.workspaceDir, input.existingSpecDir);
      if (!existsSync(specDir)) {
        throw new Error(`existingSpecDir does not exist: ${specDir}`);
      }

      // Try to recover repoPath from the spec's own manifest (monorepo support).
      // The manifest stores a relative path so specs remain portable across checkouts.
      const specManifestPath = path.join(specDir, "manifest.json");
      let specManifest = null;
      if (existsSync(specManifestPath)) {
        try {
          specManifest = JSON.parse(readFileSync(specManifestPath, "utf8"));
        } catch {
          /* best effort */
        }
      }
      const effectiveRepoPath =
        specManifest?.repoPath && specManifest.repoPath !== "."
          ? specManifest.repoPath
          : input.repoPath || ".";
      const effectiveRepoRoot = path.resolve(
        ctx.workspaceDir,
        effectiveRepoPath,
      );

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
          if (!status) return null;
          // Extract clean ADR ID prefix (e.g. "ADR-001") from filenames
          // like "ADR-001-use-jwt.md" rather than using the full slug.
          const adrMatch = f.name.match(/^(ADR-\d+)/i);
          const id = adrMatch ? adrMatch[1] : f.name.replace(/\.md$/, "");
          return { id, status, file: f.name };
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

      // Parse existing phase docs so spec_architect can preserve rollout ordering.
      // Recover original phase IDs from the spec manifest when available, since
      // build mode persists ph.id verbatim. Fall back to index-based IDs only
      // when no manifest entry matches.
      const manifestPhases = specManifest?.phases || [];
      const phasesDir = path.join(specDir, "phases");
      const parsedPhases = existsSync(phasesDir)
        ? readdirSync(phasesDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f, i) => {
              const content = readFileSync(path.join(phasesDir, f), "utf8");
              const titleMatch = content.match(/^#\s+(.+)/m);
              const title = titleMatch
                ? titleMatch[1].trim()
                : f.replace(/\.md$/, "");
              // Match against manifest by docPath suffix or title to recover
              // the original phase id (e.g. "phase-1") instead of renumbering.
              const manifestEntry = manifestPhases.find(
                (mp) => mp.docPath?.endsWith(f) || mp.title === title,
              );
              return {
                id: manifestEntry?.id || `phase-${i + 1}`,
                title,
                file: f,
              };
            })
        : [];

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
      "spec_ingest requires either existingSpecDir (with optional updateDoc) or researchRunId",
    );
  },
});
