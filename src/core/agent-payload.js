import {
  extractGeminiPayloadJson,
  extractJson,
  formatCommandFailure,
} from "../helpers.js";

/**
 * Parse structured JSON from agent output.
 * @param {string} agentName
 * @param {string} stdout
 */
export function parseAgentPayload(agentName, stdout) {
  return agentName === "gemini"
    ? extractGeminiPayloadJson(stdout)
    : extractJson(stdout);
}

/**
 * Ensure an agent result has exit code 0, throw otherwise.
 * @param {string} agentName
 * @param {string} label
 * @param {{ exitCode: number, stdout?: string, stderr?: string }} res
 */
export function requireExitZero(agentName, label, res) {
  if (res.exitCode !== 0) {
    throw new Error(formatCommandFailure(`${agentName} ${label}`, res));
  }
}
