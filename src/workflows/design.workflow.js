import { registerMachine } from "../machines/_registry.js";
import { validateStitchConfig } from "../machines/design/_shared.js";
import intentCaptureMachine from "../machines/design/intent-capture.machine.js";
import specExportMachine from "../machines/design/spec-export.machine.js";
import uiGenerationMachine from "../machines/design/ui-generation.machine.js";
import uiRefinementMachine from "../machines/design/ui-refinement.machine.js";
import { WorkflowRunner } from "./_base.js";

export {
  intentCaptureMachine,
  uiGenerationMachine,
  uiRefinementMachine,
  specExportMachine,
};

export const designMachines = [
  intentCaptureMachine,
  uiGenerationMachine,
  uiRefinementMachine,
  specExportMachine,
];

/**
 * Register all design machines in the global registry.
 */
export function registerDesignMachines() {
  for (const m of designMachines) {
    registerMachine(m);
  }
}

/**
 * Run the full design pipeline.
 *
 * @param {{
 *   intent: string,
 *   screenshotPaths?: string[],
 *   projectName?: string,
 *   style?: string,
 * }} opts
 * @param {import("../machines/_base.js").WorkflowContext} ctx
 */
export async function runDesignPipeline(opts, ctx) {
  validateStitchConfig(ctx);

  const runner = new WorkflowRunner({
    name: "design",
    workflowContext: ctx,
    onStageChange: (stage) => {
      ctx.log({ event: "design_stage", stage });
    },
  });

  return runner.run(
    [
      {
        machine: intentCaptureMachine,
        inputMapper: () => ({
          intent: opts.intent,
          screenshotPaths: opts.screenshotPaths || [],
          projectName: opts.projectName || "",
          style: opts.style || "",
        }),
      },
      {
        machine: uiGenerationMachine,
        inputMapper: (prev) => ({
          specDir: prev.data.specDir,
          intentPath: prev.data.intentPath,
          intentSpec: prev.data.intentSpec,
        }),
      },
      {
        machine: uiRefinementMachine,
        inputMapper: (prev) => ({
          specDir: prev.data.specDir,
          projectId: prev.data.projectId,
          generatedScreens: prev.data.generatedScreens,
          designContext: prev.data.designContext,
        }),
      },
      {
        machine: specExportMachine,
        inputMapper: (prev, state) => {
          const captureData = state.results[0]?.data || {};
          const genData = state.results[1]?.data || {};
          return {
            specDir: genData.specDir || captureData.specDir,
            intentSpec: captureData.intentSpec,
            refinedScreens: prev.data.refinedScreens,
            accessibilityResults: prev.data.accessibilityResults,
            designTokens: prev.data.designTokens,
            projectId: genData.projectId || "",
          };
        },
      },
    ],
    {},
  );
}
