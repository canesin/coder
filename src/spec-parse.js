import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseAdrStatus, parseSpecGaps, parseSpecMeta } from "./helpers.js";

const SYNTHETIC_DOMAINS = new Set(["overview", "architecture"]);
const VALID_ADR_STATUSES = new Set([
  "proposed",
  "accepted",
  "deprecated",
  "superseded",
]);

// Loose pattern: lines that look like they're trying to be gap items
const LOOSE_GAP_RE = /^-\s+\[[ x]\].*(?:Domain:|Severity:)/gm;

/**
 * Parse a spec directory, returning all extracted data plus any issues found.
 *
 * This is the single source of truth for spec directory parsing — used by both
 * the spec-ingest machine (which consumes the data) and the spec-check CLI
 * (which reports the issues).
 *
 * @param {string} specDir - Absolute path to spec directory
 * @returns {{
 *   manifest: object | null,
 *   mdFiles: Array<{name: string, content: string}>,
 *   parsedDomains: Array<{name: string, version: string, file: string}>,
 *   parsedDecisions: Array<{id: string, status: string, file: string}>,
 *   parsedGaps: Array<{description: string, domain: string, severity: string, status: string}>,
 *   parsedPhases: Array<{id: string, title: string, file: string}>,
 *   issues: Array<{level: "error"|"warning", file: string, message: string}>
 * }}
 */
export function parseSpecDirectory(specDir) {
  const issues = [];

  function add(level, file, message) {
    issues.push({ level, file, message });
  }

  // --- Directory validation ---
  if (!existsSync(specDir)) {
    add("error", specDir, "Directory does not exist");
    return emptyResult(issues);
  }
  if (!statSync(specDir).isDirectory()) {
    add("error", specDir, "Path is not a directory");
    return emptyResult(issues);
  }

  // --- Read root .md files ---
  const rootFiles = readdirSync(specDir);
  const mdFiles = rootFiles
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      content: readFileSync(path.join(specDir, f), "utf8"),
    }));

  if (mdFiles.length === 0) {
    add("warning", specDir, "No .md files found in spec directory");
  }

  // --- Manifest ---
  const specManifestPath = path.join(specDir, "manifest.json");
  let manifest = null;
  if (existsSync(specManifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(specManifestPath, "utf8"));
    } catch (e) {
      add("error", "manifest.json", `Invalid JSON: ${e.message}`);
    }
  }

  // --- Domain docs ---
  const parsedDomains = [];
  for (const f of mdFiles) {
    const meta = parseSpecMeta(f.content);

    // Skip synthetic docs (overview, architecture)
    if (meta.domain && SYNTHETIC_DOMAINS.has(meta.domain)) continue;

    if (Object.keys(meta).length === 0) {
      add("warning", f.name, "Missing <!-- spec-meta --> block");
      // Still count as a domain doc (best effort)
      parsedDomains.push({ name: "", version: "1", file: f.name });
      continue;
    }

    if (!meta.version) {
      add("warning", f.name, "spec-meta missing 'version' field");
    }
    if (!meta.domain) {
      add("warning", f.name, "spec-meta missing 'domain' field");
    }

    parsedDomains.push({
      name: meta.domain || "",
      version: meta.version || "1",
      file: f.name,
    });
  }

  // --- Decisions (ADRs) ---
  const decisionsDir = path.join(specDir, "decisions");
  const parsedDecisions = [];
  if (existsSync(decisionsDir) && statSync(decisionsDir).isDirectory()) {
    const decisionFiles = readdirSync(decisionsDir).filter((f) =>
      f.endsWith(".md"),
    );

    for (const fileName of decisionFiles) {
      const content = readFileSync(path.join(decisionsDir, fileName), "utf8");
      const status = parseAdrStatus(content);

      if (status === null) {
        add(
          "error",
          `decisions/${fileName}`,
          "Missing <!-- adr-meta --> block",
        );
        continue;
      }

      if (!VALID_ADR_STATUSES.has(status)) {
        add(
          "error",
          `decisions/${fileName}`,
          `Invalid ADR status "${status}" — expected: ${[...VALID_ADR_STATUSES].join(", ")}`,
        );
        // Still include it — ingest would silently drop, but the data is present
      }

      const adrMatch = fileName.match(/^(ADR-\d+)/i);
      const id = adrMatch ? adrMatch[1] : fileName.replace(/\.md$/, "");
      parsedDecisions.push({ id, status, file: fileName });
    }
  }

  // --- Gaps ---
  // Skip synthetic docs to avoid duplicate gaps (architecture repeats every domain gap)
  const parsedGaps = [];
  for (const f of mdFiles) {
    const meta = parseSpecMeta(f.content);
    if (meta.domain && SYNTHETIC_DOMAINS.has(meta.domain)) continue;

    const strictGaps = parseSpecGaps(f.content);
    parsedGaps.push(...strictGaps);

    // Detect malformed gap lines
    const looseMatches = f.content.match(LOOSE_GAP_RE) || [];
    if (looseMatches.length > strictGaps.length) {
      const delta = looseMatches.length - strictGaps.length;
      add(
        "warning",
        f.name,
        `${delta} gap line(s) look malformed — expected format: - [ ] **N. Gap** — Desc. Domain: X. Severity: Y.`,
      );
    }
  }

  // --- Phases ---
  const manifestPhases = manifest?.phases || [];
  const phasesDir = path.join(specDir, "phases");
  const parsedPhases = [];
  if (existsSync(phasesDir) && statSync(phasesDir).isDirectory()) {
    const phaseFiles = readdirSync(phasesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (let i = 0; i < phaseFiles.length; i++) {
      const fileName = phaseFiles[i];
      const content = readFileSync(path.join(phasesDir, fileName), "utf8");
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch
        ? titleMatch[1].trim()
        : fileName.replace(/\.md$/, "");

      if (!titleMatch) {
        add("warning", `phases/${fileName}`, "Missing markdown heading");
      }

      // Recover original phase id from manifest when available
      const manifestEntry = manifestPhases.find(
        (mp) => mp.docPath?.endsWith(fileName) || mp.title === title,
      );

      parsedPhases.push({
        id: manifestEntry?.id || `phase-${i + 1}`,
        title,
        file: fileName,
      });
    }
  }

  return {
    manifest,
    mdFiles,
    parsedDomains,
    parsedDecisions,
    parsedGaps,
    parsedPhases,
    issues,
  };
}

function emptyResult(issues) {
  return {
    manifest: null,
    mdFiles: [],
    parsedDomains: [],
    parsedDecisions: [],
    parsedGaps: [],
    parsedPhases: [],
    issues,
  };
}
