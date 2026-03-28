import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Read and parse a JSON file with a default fallback.
 * Returns the default when the file is missing or unparseable.
 *
 * @param {string} filePath
 * @param {any} [defaultValue=null]
 * @returns {any}
 */
export function readJsonSafe(filePath, defaultValue = null) {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return defaultValue;
  }
}

/**
 * Write JSON with 2-space indent and trailing newline.
 *
 * @param {string} filePath
 * @param {any} data
 */
export function writeJsonPretty(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
