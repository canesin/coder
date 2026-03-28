/**
 * Sanitize a string for use as a filename segment.
 * @param {string} value
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function sanitizeFilenameSegment(value, { fallback = "item" } = {}) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
