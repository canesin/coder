import { registerMachine } from "../_registry.js";
import pocRunnerMachine from "./poc-runner.machine.js";
import webResearchMachine from "./web-research.machine.js";

export { webResearchMachine, pocRunnerMachine };

export const sharedMachines = [webResearchMachine, pocRunnerMachine];

/**
 * Register all shared machines in the global registry.
 */
export function registerSharedMachines() {
  for (const m of sharedMachines) {
    registerMachine(m);
  }
}
