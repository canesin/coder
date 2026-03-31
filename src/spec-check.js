import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IssueItemSchema, SpecManifestSchema } from "./schemas.js";
import { parseSpecDirectory } from "./spec-parse.js";

/**
 * Validate a spec directory and return all issues found.
 *
 * Uses the same parsing logic as spec-ingest (via parseSpecDirectory),
 * then layers on schema validation and cross-reference checks.
 *
 * @param {string} specDir - Absolute path to spec directory
 * @returns {{ specDir: string, issues: Array<{level: "error"|"warning", file: string, message: string}>, summary: {errors: number, warnings: number, files: number, domains: number, decisions: number, phases: number, gaps: number} }}
 */
export function checkSpec(specDir) {
  const parsed = parseSpecDirectory(specDir);

  // Start with the issues found during parsing
  const issues = [...parsed.issues];

  function add(level, file, message) {
    issues.push({ level, file, message });
  }

  // --- Manifest schema validation (on top of the basic JSON parse in parseSpecDirectory) ---
  const docBase = path.resolve(specDir, "..");

  if (parsed.manifest) {
    const result = SpecManifestSchema.safeParse(parsed.manifest);
    if (!result.success) {
      for (const issue of result.error.issues) {
        add(
          "error",
          "manifest.json",
          `Schema: ${issue.path.join(".")} — ${issue.message}`,
        );
      }
    } else {
      const manifest = result.data;

      // Check domain docPaths exist + cross-validate content
      for (const d of manifest.domains) {
        if (!existsSync(path.resolve(docBase, d.docPath))) {
          add("error", "manifest.json", `Domain docPath missing: ${d.docPath}`);
        } else {
          const fileName = path.basename(d.docPath);
          const pd = parsed.parsedDomains.find((e) => e.file === fileName);
          if (pd?.name && pd.name !== d.name) {
            add(
              "warning",
              "manifest.json",
              `Domain "${d.name}" docPath content has domain: "${pd.name}"`,
            );
          }
        }
      }

      // Check decision docPaths exist + cross-validate content
      for (const d of manifest.decisions) {
        if (!existsSync(path.resolve(docBase, d.docPath))) {
          add(
            "error",
            "manifest.json",
            `Decision docPath missing: ${d.docPath}`,
          );
        } else {
          const fileName = path.basename(d.docPath);
          const pd = parsed.parsedDecisions.find((e) => e.file === fileName);
          if (pd && pd.status !== d.status) {
            add(
              "warning",
              "manifest.json",
              `Decision "${d.id}" manifest status "${d.status}" differs from file: "${pd.status}"`,
            );
          }
        }
      }

      // Check phase docPaths exist + cross-validate content
      for (const p of manifest.phases) {
        if (!existsSync(path.resolve(docBase, p.docPath))) {
          add("error", "manifest.json", `Phase docPath missing: ${p.docPath}`);
        } else {
          const fileName = path.basename(p.docPath);
          const pp = parsed.parsedPhases.find((e) => e.file === fileName);
          if (pp && pp.title !== p.title) {
            add(
              "warning",
              "manifest.json",
              `Phase "${p.id}" manifest title "${p.title}" differs from file: "${pp.title}"`,
            );
          }
        }
      }

      // Check issueManifestPath exists
      if (manifest.issueManifestPath) {
        const resolvedPath = path.resolve(docBase, manifest.issueManifestPath);
        if (!existsSync(resolvedPath)) {
          add(
            "warning",
            "manifest.json",
            `issueManifestPath not found: ${manifest.issueManifestPath}`,
          );
        }
      }

      // Bridge manifest validation
      if (manifest.issueManifestPath) {
        const bridgePath = path.resolve(docBase, manifest.issueManifestPath);
        if (existsSync(bridgePath)) {
          checkBridgeManifest(bridgePath, add);
        }
      }
    }
  }

  // --- Build summary ---
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;

  return {
    specDir,
    issues,
    summary: {
      errors,
      warnings,
      files: parsed.mdFiles.length,
      domains: parsed.parsedDomains.length,
      decisions: parsed.parsedDecisions.length,
      phases: parsed.parsedPhases.length,
      gaps: parsed.parsedGaps.length,
    },
  };
}

/**
 * Validate a bridge manifest (`.coder/local-issues/manifest.json`).
 */
function checkBridgeManifest(bridgePath, add) {
  let bridge;
  try {
    bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
  } catch (e) {
    add("warning", bridgePath, `Bridge manifest invalid JSON: ${e.message}`);
    return;
  }

  if (!Array.isArray(bridge.issues)) {
    add("warning", bridgePath, "Bridge manifest missing issues array");
    return;
  }

  const knownIds = new Set(bridge.issues.map((i) => i.id).filter(Boolean));

  for (const entry of bridge.issues) {
    const result = IssueItemSchema.safeParse({
      source: "local",
      id: entry.id,
      title: entry.title || entry.id,
      difficulty: entry.difficulty ?? 3,
      depends_on: entry.depends_on || [],
    });
    if (!result.success) {
      add(
        "warning",
        bridgePath,
        `Issue "${entry.id || "(no id)"}": ${result.error.issues.map((e) => e.message).join("; ")}`,
      );
    }

    const deps = entry.depends_on || [];
    for (const dep of deps) {
      if (!knownIds.has(dep)) {
        add(
          "warning",
          bridgePath,
          `Issue "${entry.id}" depends_on "${dep}" which is not in the manifest`,
        );
      }
    }
  }
}
