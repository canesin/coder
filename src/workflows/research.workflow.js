import { registerMachine } from "../machines/_registry.js";
import contextGatherMachine from "../machines/research/context-gather.machine.js";
import deepResearchMachine from "../machines/research/deep-research.machine.js";
import issueCritiqueMachine from "../machines/research/issue-critique.machine.js";
import issueSynthesisMachine from "../machines/research/issue-synthesis.machine.js";
import pocValidationMachine from "../machines/research/poc-validation.machine.js";
import specPublishMachine from "../machines/research/spec-publish.machine.js";
import techSelectionMachine from "../machines/research/tech-selection.machine.js";
import { WorkflowRunner } from "./_base.js";

export {
  contextGatherMachine,
  deepResearchMachine,
  techSelectionMachine,
  pocValidationMachine,
  issueSynthesisMachine,
  issueCritiqueMachine,
  specPublishMachine,
};

export const researchMachines = [
  contextGatherMachine,
  deepResearchMachine,
  techSelectionMachine,
  pocValidationMachine,
  issueSynthesisMachine,
  issueCritiqueMachine,
  specPublishMachine,
];

/**
 * Register all research machines in the global registry.
 */
export function registerResearchMachines() {
  for (const m of researchMachines) {
    registerMachine(m);
  }
}

/**
 * Run the full research pipeline.
 *
 * @param {{
 *   pointers: string,
 *   repoPath?: string,
 *   clarifications?: string,
 *   maxIssues?: number,
 *   iterations?: number,
 *   webResearch?: boolean,
 *   validateIdeas?: boolean,
 *   validationMode?: string,
 * }} opts
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 */
export async function runResearchPipeline(opts, ctx) {
  const runner = new WorkflowRunner({
    name: "research",
    workflowContext: ctx,
    onStageChange: (stage) => {
      ctx.log({ event: "research_stage", stage });
    },
  });

  return runner.run(
    [
      {
        machine: contextGatherMachine,
        inputMapper: () => ({
          pointers: opts.pointers,
          repoPath: opts.repoPath || ".",
          clarifications: opts.clarifications || "",
          maxIssues: opts.maxIssues ?? 6,
          iterations: opts.iterations ?? 2,
          webResearch: opts.webResearch ?? true,
          validateIdeas: opts.validateIdeas ?? true,
          validationMode: opts.validationMode || "auto",
        }),
      },
      {
        machine: deepResearchMachine,
        inputMapper: (prev) => ({
          stepsDir: prev.data.stepsDir,
          scratchpadPath: prev.data.scratchpadPath,
          pipelinePath: prev.data.pipelinePath,
          analysisBrief: prev.data.analysisBrief,
          webResearch: prev.data.webResearch,
        }),
      },
      {
        machine: pocValidationMachine,
        inputMapper: (prev, state) => {
          const gatherData = state.results[0]?.data || {};
          return {
            stepsDir: gatherData.stepsDir,
            scratchpadPath: gatherData.scratchpadPath,
            pipelinePath: gatherData.pipelinePath,
            analysisBrief: gatherData.analysisBrief,
            webReferenceMap: prev.data.webReferenceMap,
            validateIdeas: gatherData.validateIdeas,
            validationMode: gatherData.validationMode,
          };
        },
      },
      {
        machine: issueSynthesisMachine,
        inputMapper: (prev, state) => {
          const gatherData = state.results[0]?.data || {};
          const researchData = state.results[1]?.data || {};
          return {
            stepsDir: gatherData.stepsDir,
            scratchpadPath: gatherData.scratchpadPath,
            pipelinePath: gatherData.pipelinePath,
            repoRoot: gatherData.repoRoot,
            clarifications: gatherData.clarifications,
            iterations: gatherData.iterations,
            maxIssues: gatherData.maxIssues,
            analysisBrief: gatherData.analysisBrief,
            webReferenceMap: researchData.webReferenceMap,
            validationResults: prev.data.validationResults,
          };
        },
      },
      {
        machine: specPublishMachine,
        inputMapper: (prev, state) => {
          const gatherData = state.results[0]?.data || {};
          const researchData = state.results[1]?.data || {};
          const validationData = state.results[2]?.data || {};
          return {
            runId: gatherData.runId,
            runDir: gatherData.runDir,
            issuesDir: gatherData.issuesDir,
            scratchpadPath: gatherData.scratchpadPath,
            pipelinePath: gatherData.pipelinePath,
            repoPath: gatherData.repoPath,
            pointers: gatherData.pointers,
            clarifications: gatherData.clarifications,
            iterations: gatherData.iterations,
            maxIssues: gatherData.maxIssues,
            webResearch: gatherData.webResearch,
            validateIdeas: gatherData.validateIdeas,
            validationMode: gatherData.validationMode,
            repoRoot: gatherData.repoRoot,
            analysisBrief: gatherData.analysisBrief,
            webReferenceMap: researchData.webReferenceMap,
            validationPlan: validationData.validationPlan,
            validationResults: validationData.validationResults,
            finalDraft: prev.data.finalDraft,
            finalReview: prev.data.finalReview,
            priorFeedback: prev.data.priorFeedback,
            selectedIssues: prev.data.selectedIssues,
          };
        },
      },
    ],
    {},
  );
}
