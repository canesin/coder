/**
 * Generic HTML-comment metadata block parser.
 * Extracts key-value pairs from blocks like `<!-- blockName\nkey: value\n-->`.
 *
 * @param {string} text - Document content
 * @param {string} blockName - e.g. "spec-meta", "adr-meta"
 * @returns {Record<string, string>} Parsed metadata (empty object if no block found)
 */
export function parseMetadataBlock(text, blockName) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const re = new RegExp(`<!--\\s*${blockName}\\n([\\s\\S]*?)-->`);
  const match = normalized.match(re);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

/**
 * Parse `<!-- spec-meta ... -->` HTML comment blocks into key-value pairs.
 * @param {string} text - Markdown document content
 * @returns {Record<string, string>} Parsed metadata (empty object if no block found)
 */
export function parseSpecMeta(text) {
  return parseMetadataBlock(text, "spec-meta");
}

/**
 * Extract the `status` field from an `<!-- adr-meta ... -->` HTML comment block.
 * @param {string} text - ADR markdown document content
 * @returns {string | null} The status value, or null if no block/status found
 */
export function parseAdrStatus(text) {
  return parseMetadataBlock(text, "adr-meta").status || null;
}
