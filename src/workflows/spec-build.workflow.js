import { registerMachine } from "../machines/_registry.js";
import specArchitectMachine from "../machines/research/spec-architect.machine.js";
import specIngestMachine from "../machines/research/spec-ingest.machine.js";
import specRenderMachine from "../machines/research/spec-render.machine.js";
import { WorkflowRunner } from "./_base.js";

export { specArchitectMachine, specIngestMachine, specRenderMachine };

export const specBuildMachines = [
  specIngestMachine,
  specArchitectMachine,
  specRenderMachine,
];

export function registerSpecBuildMachines() {
  for (const m of specBuildMachines) registerMachine(m);
}

export async function runSpecBuildPipeline(opts, ctx) {
  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: ctx,
    onStageChange: (stage) => ctx.log({ event: "spec_build_stage", stage }),
  });

  return runner.run([
    {
      machine: specIngestMachine,
      inputMapper: () => ({
        repoPath: opts.repoPath || ".",
        existingSpecDir: opts.existingSpecDir || "",
        researchRunId: opts.researchRunId || "",
      }),
    },
    {
      machine: specArchitectMachine,
      inputMapper: (prev) => ({
        runDir: prev.data.runDir,
        stepsDir: prev.data.stepsDir,
        scratchpadPath: prev.data.scratchpadPath,
        pipelinePath: prev.data.pipelinePath,
        repoRoot: prev.data.repoRoot,
        mode: prev.data.mode,
        researchManifest: prev.data.researchManifest || {},
        parsedDomains: prev.data.parsedDomains || [],
        parsedDecisions: prev.data.parsedDecisions || [],
        parsedGaps: prev.data.parsedGaps || [],
        parsedPhases: prev.data.parsedPhases || [],
      }),
    },
    {
      machine: specRenderMachine,
      inputMapper: (prev, state) => {
        const ingestData = state.results[0]?.data || {};
        return {
          runDir: ingestData.runDir,
          stepsDir: ingestData.stepsDir,
          issuesDir: ingestData.issuesDir,
          scratchpadPath: ingestData.scratchpadPath,
          pipelinePath: ingestData.pipelinePath,
          repoRoot: ingestData.repoRoot,
          repoPath: ingestData.repoPath || opts.repoPath || ".",
          mode: ingestData.mode,
          domains: prev.data.domains || [],
          decisions: prev.data.decisions || [],
          phases: prev.data.phases || [],
          issueSpecs: prev.data.issueSpecs || [],
          parsedDomains:
            prev.data.parsedDomains || ingestData.parsedDomains || [],
          parsedDecisions:
            prev.data.parsedDecisions || ingestData.parsedDecisions || [],
        };
      },
    },
  ]);
}
