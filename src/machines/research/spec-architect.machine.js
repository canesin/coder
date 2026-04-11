import { z } from "zod";
import { defineMachine } from "../_base.js";
import { renderSpecArchitectExample } from "../prompt-contracts.js";
import {
  appendScratchpad,
  loadPipeline,
  requirePayloadFields,
  runStructuredStep,
} from "./_shared.js";

export default defineMachine({
  name: "research.spec_architect",
  description:
    "Architectural decomposition (build mode) or gap categorization (ingest mode). " +
    "Produces domains, decisions, phases, and issue specs for the spec_render step.",
  inputSchema: z.object({
    runDir: z.string().min(1),
    stepsDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
    repoRoot: z.string().min(1),
    mode: z.enum(["build", "ingest"]),
    researchManifest: z.any().default({}),
    parsedDomains: z.array(z.any()).default([]),
    parsedDecisions: z.array(z.any()).default([]),
    parsedGaps: z.array(z.any()).default([]),
    parsedPhases: z.array(z.any()).default([]),
  }),

  async execute(input, ctx) {
    const { stepsDir, scratchpadPath, pipelinePath, repoRoot, mode } = input;
    const pipeline = loadPipeline(pipelinePath) || {
      version: 1,
      current: "spec_architect",
      history: [],
      steps: {},
    };
    const stepOpts = { stepsDir, scratchpadPath, pipeline, pipelinePath, ctx };

    if (mode === "build") {
      const manifest = input.researchManifest;
      const prompt = `You are an architectural decomposition agent. Analyze the research output and codebase to produce a structured spec.

Repo root: ${repoRoot}

Research manifest:
${JSON.stringify(manifest, null, 2)}

Tasks:
1. Explore the codebase structure at ${repoRoot}
2. Decompose the project into architectural domains
3. For each domain, record at least one ADR-style decision covering the
   **core data structures** — their shape, ownership, and lifetime. Get the
   data right and the algorithms follow; get it wrong and no algorithm
   will save you.
4. Create ADR-style decision records for other key architectural choices
5. Define implementation phases with issue groupings
6. Sequence issues within the same domain by populating the "depends_on" field with the titles of prerequisite issues

Return ONLY valid JSON:
${renderSpecArchitectExample("build")}`;

      const res = await runStructuredStep({
        stepName: "spec_architect",
        artifactName: "spec-architect",
        role: "issueSelector",
        prompt,
        ...stepOpts,
      });

      requirePayloadFields(
        res.payload,
        {
          domains: "array",
          decisions: "array",
          phases: "array",
          issueSpecs: "array",
        },
        "spec_architect (build)",
      );
      const { domains, decisions, phases, issueSpecs } = res.payload;

      appendScratchpad(scratchpadPath, "Spec Architect (build)", [
        `- domains: ${domains.length}`,
        `- decisions: ${decisions.length}`,
        `- phases: ${phases.length}`,
        `- issueSpecs: ${issueSpecs.length}`,
      ]);

      return {
        status: "ok",
        data: { mode: "build", domains, decisions, phases, issueSpecs },
      };
    }

    // ingest mode
    const hasExistingPhases = input.parsedPhases.length > 0;
    const phaseInstruction = hasExistingPhases
      ? `Existing phases (preserve this ordering and naming):
${JSON.stringify(input.parsedPhases, null, 2)}

`
      : "";

    const prompt = `You are a gap categorization agent. Take the parsed gaps from existing spec documents and produce structured issues.

Repo root: ${repoRoot}

Parsed domains:
${JSON.stringify(input.parsedDomains, null, 2)}

Parsed decisions:
${JSON.stringify(input.parsedDecisions, null, 2)}

Parsed gaps:
${JSON.stringify(input.parsedGaps, null, 2)}

${phaseInstruction}Tasks:
1. Take the parsed gaps as-is (do NOT regenerate or alter the architectural structure)
2. Categorize each gap into a domain
3. Assign priority and severity
4. ${hasExistingPhases ? "Assign each gap to the existing phases above, preserving their IDs and titles. Only create new phases if a gap does not fit any existing phase." : "Group gaps into implementation phases with dependency ordering"}
5. For each gap, produce an issue-shaped object and reference it in the phase's issueSpecs by title
6. Sequence issues within the same domain by populating the "depends_on" field with the titles of prerequisite issues

Return ONLY valid JSON:
${renderSpecArchitectExample("ingest")}`;

    const res = await runStructuredStep({
      stepName: "spec_architect",
      artifactName: "spec-architect",
      role: "issueSelector",
      prompt,
      ...stepOpts,
    });

    requirePayloadFields(
      res.payload,
      { phases: "array", issueSpecs: "array" },
      "spec_architect (ingest)",
    );
    const { phases, issueSpecs } = res.payload;

    appendScratchpad(scratchpadPath, "Spec Architect (ingest)", [
      `- phases: ${phases.length}`,
      `- issueSpecs: ${issueSpecs.length}`,
    ]);

    return {
      status: "ok",
      data: {
        mode: "ingest",
        phases,
        issueSpecs,
        parsedDomains: input.parsedDomains,
        parsedDecisions: input.parsedDecisions,
      },
    };
  },
});
