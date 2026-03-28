import { stripAgentNoise } from "../helpers.js";

/**
 * Two-pass agent noise removal: strip leading noise, then all noise lines.
 * Replaces the repeated pattern across plan-review, helpers.js, etc.
 *
 * @param {string} text - Raw agent output
 * @returns {string} Cleaned and trimmed text
 */
export function deepCleanAgentOutput(text) {
  const pass1 = stripAgentNoise(text, { dropLeadingOnly: true });
  return stripAgentNoise(pass1).trim();
}

/**
 * Clean agent output, strip markdown code fence wrapping, and extract content
 * starting from the first markdown heading.
 *
 * @param {string} text - Raw agent output
 * @returns {string} Cleaned markdown content
 */
export function extractFromFirstHeading(text) {
  const cleaned = deepCleanAgentOutput(text);
  if (!cleaned) return "";
  // Strip outer markdown code fence if the agent wrapped the output (e.g. Gemini).
  const fenceMatch = cleaned.match(
    /^```(?:markdown)?\s*\n([\s\S]*?)\n?```\s*$/i,
  );
  const unwrapped = fenceMatch ? fenceMatch[1].trim() : cleaned;
  const lines = unwrapped.split("\n");
  const firstHeader = lines.findIndex((line) => line.trim().startsWith("#"));
  if (firstHeader > 0) return lines.slice(firstHeader).join("\n").trim();
  return unwrapped;
}
