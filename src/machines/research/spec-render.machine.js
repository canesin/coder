import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SpecManifestSchema } from "../../schemas.js";
import { defineMachine } from "../_base.js";
import {
  appendScratchpad,
  beginPipelineStep,
  endPipelineStep,
  loadPipeline,
  renderIdeaIssueMarkdown,
  sanitizeFilenameSegment,
} from "./_shared.js";

/**
 * Check if every own-key of `subset` matches the same key in `superset`.
 * Keys starting with `_` are skipped (internal annotations).
 */
function isSubsetMatch(subset, superset) {
  for (const key of Object.keys(subset)) {
    if (key.startsWith("_")) continue;
    const a = subset[key];
    const b = superset[key];
    if (a === b) continue;
    // Deep-compare non-scalar values (arrays, objects from AI output)
    if (typeof a === "object" && typeof b === "object") {
      try {
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
      } catch {
        /* fall through to false */
      }
    }
    return false;
  }
  return true;
}

/**
 * Build a phase→issueId[] mapping.
 *
 * Each flat issueSpec is tagged with `_issueId` (stable, index-based).
 * Phase entries that already carry `_issueId` use it directly.
 * Abbreviated phase entries are matched against the tagged flat specs
 * using ALL shared fields (not just title) to find the correct ID.
 */
function buildPhaseIssueIds(phases, issueSpecs, generatedIssues) {
  // Build an index-based lookup without mutating the input issueSpecs
  const specIdByIndex = new Map();
  for (let i = 0; i < issueSpecs.length; i++) {
    if (i < generatedIssues.length) {
      specIdByIndex.set(i, generatedIssues[i].id);
    }
  }

  const used = new Set();
  return phases.map((ph) => {
    const specs = Array.isArray(ph.issueSpecs) ? ph.issueSpecs : [];
    const ids = [];
    for (const s of specs) {
      // If the phase entry carries a pre-assigned _issueId, use it directly
      if (s._issueId) {
        if (!used.has(s._issueId)) {
          used.add(s._issueId);
          ids.push(s._issueId);
        }
        continue;
      }
      // Match against flat specs using all shared fields
      const idx = issueSpecs.findIndex((flat, fi) => {
        const assignedId = specIdByIndex.get(fi);
        if (!assignedId || used.has(assignedId)) return false;
        return isSubsetMatch(s, flat);
      });
      if (idx >= 0) {
        const matchedId = specIdByIndex.get(idx);
        used.add(matchedId);
        ids.push(matchedId);
      }
    }
    return ids;
  });
}

/**
 * Render the 01-OVERVIEW.md content from domains, decisions, and phases.
 */
function renderOverview(domains, decisions, phases) {
  const lines = [
    "<!-- spec-meta\nversion: 1\ndomain: overview\n-->",
    "",
    "# Overview",
    "",
  ];

  if (domains.length > 0) {
    lines.push("## Domains", "");
    for (const d of domains) {
      lines.push(`- **${d.name}**: ${d.description || "(no description)"}`);
    }
    lines.push("");
  }

  if (decisions.length > 0) {
    lines.push("## Key Decisions", "");
    for (const dec of decisions) {
      lines.push(
        `- **${dec.title || dec.id}** (${dec.status || "proposed"}): ${dec.rationale || ""}`,
      );
    }
    lines.push("");
  }

  if (phases.length > 0) {
    lines.push("## Implementation Phases", "");
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i];
      lines.push(`${i + 1}. **${ph.title || ph.id}**: ${ph.description || ""}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Format a gap as a checklist item that `parseSpecGaps()` can round-trip.
 * Format: `- [ ] **N. Gap** — description Domain: DOMAIN. Severity: medium.`
 */
function formatGapChecklist(gap, index, domainName) {
  const desc = typeof gap === "string" ? gap : gap.description || String(gap);
  const domain =
    (typeof gap === "object" && gap.domain) || domainName || "unknown";
  const severity = (typeof gap === "object" && gap.severity) || "medium";
  const done = typeof gap === "object" && gap.status === "done";
  const check = done ? "x" : " ";
  return `- [${check}] **${index + 1}. Gap** — ${desc} Domain: ${domain}. Severity: ${severity}.`;
}

/**
 * Render the 02-ARCHITECTURE.md content from domains (with gaps).
 */
function renderArchitecture(domains) {
  const lines = [
    "<!-- spec-meta\nversion: 1\ndomain: architecture\n-->",
    "",
    "# Architecture",
    "",
    "Domain decomposition and identified gaps.",
    "",
  ];

  for (const d of domains) {
    lines.push(`## ${d.name}`, "");
    if (d.description) lines.push(d.description, "");
    const gaps = Array.isArray(d.gaps) ? d.gaps : [];
    if (gaps.length > 0) {
      lines.push("### Gaps", "");
      for (let gi = 0; gi < gaps.length; gi++) {
        lines.push(formatGapChecklist(gaps[gi], gi, d.name));
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export default defineMachine({
  name: "research.spec_render",
  description:
    "Renders spec documents (build mode) or skips to issue generation (ingest mode). " +
    "Both modes write issue markdown files and a bridge manifest for the develop workflow.",
  inputSchema: z.object({
    runDir: z.string().min(1),
    stepsDir: z.string().min(1),
    issuesDir: z.string().min(1),
    scratchpadPath: z.string().min(1),
    pipelinePath: z.string().min(1),
    repoRoot: z.string().min(1),
    repoPath: z.string().default("."),
    mode: z.enum(["build", "ingest"]),
    domains: z.array(z.any()).default([]),
    decisions: z.array(z.any()).default([]),
    phases: z.array(z.any()).default([]),
    issueSpecs: z.array(z.any()),
    parsedDomains: z.array(z.any()).default([]),
    parsedDecisions: z.array(z.any()).default([]),
  }),

  async execute(input, ctx) {
    const {
      runDir,
      issuesDir,
      scratchpadPath,
      pipelinePath,
      repoRoot,
      repoPath,
      mode,
      issueSpecs,
    } = input;
    const scratchpadRelPath = path.relative(ctx.workspaceDir, scratchpadPath);
    const pipeline = loadPipeline(pipelinePath) || {
      version: 1,
      current: "spec_render",
      history: [],
      steps: {},
    };
    beginPipelineStep(pipeline, pipelinePath, scratchpadPath, "spec_render", {
      mode,
    });

    // --- Generate issue markdown files (shared by both modes) ---
    mkdirSync(issuesDir, { recursive: true });
    const generatedIssues = [];
    for (let i = 0; i < issueSpecs.length; i++) {
      const item = issueSpecs[i];
      const issueId = `SPEC-${String(i + 1).padStart(2, "0")}`;
      const title = String(item?.title || `Issue ${i + 1}`).trim();
      const slug = sanitizeFilenameSegment(title, {
        fallback: `issue-${i + 1}`,
      });
      const fileName = `${String(i + 1).padStart(2, "0")}-${slug}.md`;
      const issuePath = path.join(issuesDir, fileName);

      const issueMd = renderIdeaIssueMarkdown({
        issue: item,
        issueId,
        title,
        repoPath,
        pointers: "",
        scratchpadRelPath,
      });
      writeFileSync(issuePath, issueMd, "utf8");

      generatedIssues.push({
        id: issueId,
        title,
        fileName,
        sourcePath: issuePath,
        priority: String(item?.priority || "P2"),
        depends_on: Array.isArray(item?.depends_on)
          ? item.depends_on.map((d) => String(d || "").trim()).filter(Boolean)
          : [],
        difficulty: 3,
      });
    }

    // --- Compute bridgeDir once for both modes ---
    const bridgeDir = path.join(ctx.workspaceDir, ".coder", "local-issues");

    // --- Build mode: render spec documents ---
    let specDir = null;

    if (mode === "build") {
      specDir = path.join(runDir, "spec");
      mkdirSync(path.join(specDir, "decisions"), { recursive: true });
      mkdirSync(path.join(specDir, "phases"), { recursive: true });

      const domains = input.domains || [];
      const decisions = input.decisions || [];
      const phases = input.phases || [];

      // Overview — summarizes domains, decisions, phases
      writeFileSync(
        path.join(specDir, "01-OVERVIEW.md"),
        renderOverview(domains, decisions, phases),
        "utf8",
      );

      // Architecture — domain decomposition with gaps
      writeFileSync(
        path.join(specDir, "02-ARCHITECTURE.md"),
        renderArchitecture(domains),
        "utf8",
      );

      // Domain docs
      for (let i = 0; i < domains.length; i++) {
        const d = domains[i];
        const num = String(i + 3).padStart(2, "0");
        const slug = sanitizeFilenameSegment(d.name, {
          fallback: `domain-${i + 1}`,
        }).toUpperCase();
        const gaps = Array.isArray(d.gaps) ? d.gaps : [];
        const gapsSection =
          gaps.length > 0
            ? `\n## Gaps\n\n${gaps.map((g, gi) => formatGapChecklist(g, gi, d.name)).join("\n")}\n`
            : "";
        writeFileSync(
          path.join(specDir, `${num}-${slug}.md`),
          `<!-- spec-meta\nversion: 1\ndomain: ${d.name}\n-->\n\n# ${d.name}\n\n${d.description || ""}${gapsSection}\n`,
          "utf8",
        );
      }

      // Decisions — preserve authored ADR IDs when present
      for (let i = 0; i < decisions.length; i++) {
        const dec = decisions[i];
        // Use the original ID prefix if it looks like an ADR identifier
        const adrMatch = String(dec.id || "").match(/^ADR-(\d+)/i);
        const prefix = adrMatch
          ? `ADR-${adrMatch[1]}`
          : `ADR-${String(i + 1).padStart(3, "0")}`;
        const slug = sanitizeFilenameSegment(dec.title || dec.id, {
          fallback: `adr-${i + 1}`,
        });
        writeFileSync(
          path.join(specDir, "decisions", `${prefix}-${slug}.md`),
          `<!-- adr-meta\nstatus: ${dec.status || "proposed"}\n-->\n\n# ${dec.title || dec.id}\n\n${dec.rationale || ""}\n`,
          "utf8",
        );
      }

      // Phases — derive issueIds via stable _issueId tags on flat issueSpecs
      const phaseIssueIds = buildPhaseIssueIds(
        phases,
        issueSpecs,
        generatedIssues,
      );

      for (let i = 0; i < phases.length; i++) {
        const ph = phases[i];
        const num = String(i + 1).padStart(2, "0");
        const slug = sanitizeFilenameSegment(ph.title || ph.id, {
          fallback: `phase-${i + 1}`,
        });
        const ids = phaseIssueIds[i] || [];
        const issuesList =
          ids.length > 0
            ? `\n## Issues\n\n${ids.map((id) => `- ${id}`).join("\n")}\n`
            : "";
        writeFileSync(
          path.join(specDir, "phases", `PHASE-${num}-${slug}.md`),
          `# ${ph.title || ph.id}\n\n${ph.description || ""}${issuesList}\n`,
          "utf8",
        );
      }

      // Bridge manifest path (relative to runDir)
      const bridgeManifestRelPath = path.relative(
        runDir,
        path.join(bridgeDir, "manifest.json"),
      );

      // Spec manifest
      const specManifest = SpecManifestSchema.parse({
        specId: path.basename(runDir),
        version: 1,
        repoRoot,
        domains: domains.map((d, i) => ({
          name: d.name,
          docPath: `spec/${String(i + 3).padStart(2, "0")}-${sanitizeFilenameSegment(d.name, { fallback: `domain-${i + 1}` }).toUpperCase()}.md`,
        })),
        decisions: decisions.map((dec, i) => {
          const adrMatch = String(dec.id || "").match(/^ADR-(\d+)/i);
          const prefix = adrMatch
            ? `ADR-${adrMatch[1]}`
            : `ADR-${String(i + 1).padStart(3, "0")}`;
          return {
            id: dec.id || prefix,
            title: dec.title || dec.id,
            status: dec.status || "proposed",
            docPath: `spec/decisions/${prefix}-${sanitizeFilenameSegment(dec.title || dec.id, { fallback: `adr-${i + 1}` })}.md`,
          };
        }),
        phases: phases.map((ph, i) => ({
          id: ph.id || `phase-${i + 1}`,
          title: ph.title || ph.id,
          issueIds: phaseIssueIds[i] || [],
          docPath: `spec/phases/PHASE-${String(i + 1).padStart(2, "0")}-${sanitizeFilenameSegment(ph.title || ph.id, { fallback: `phase-${i + 1}` })}.md`,
        })),
        issueManifestPath: bridgeManifestRelPath,
        createdAt: new Date().toISOString(),
      });
      writeFileSync(
        path.join(specDir, "manifest.json"),
        `${JSON.stringify(specManifest, null, 2)}\n`,
        "utf8",
      );
    }

    // --- Bridge manifest: point at the generated issues/ directory via filePath ---
    mkdirSync(bridgeDir, { recursive: true });

    const bridgeIssues = generatedIssues.map((gi) => ({
      id: gi.id,
      title: gi.title,
      filePath: path.relative(ctx.workspaceDir, gi.sourcePath),
      difficulty: gi.difficulty,
      priority: gi.priority,
      depends_on: gi.depends_on,
      ...(repoPath && repoPath !== "." ? { repo_path: repoPath } : {}),
    }));

    const bridgeManifestPath = path.join(bridgeDir, "manifest.json");
    const bridgeManifest = {
      repoRoot,
      repoPath,
      issues: bridgeIssues,
    };
    writeFileSync(
      bridgeManifestPath,
      `${JSON.stringify(bridgeManifest, null, 2)}\n`,
      "utf8",
    );

    endPipelineStep(
      pipeline,
      pipelinePath,
      scratchpadPath,
      "spec_render",
      "completed",
      { mode, issueCount: generatedIssues.length },
    );

    appendScratchpad(scratchpadPath, "Spec Render", [
      `- mode: ${mode}`,
      `- issueCount: ${generatedIssues.length}`,
      ...(specDir
        ? [`- specDir: ${path.relative(ctx.workspaceDir, specDir)}`]
        : []),
      `- bridgeManifest: ${path.relative(ctx.workspaceDir, bridgeManifestPath)}`,
    ]);

    ctx.log({
      event: "spec_render_complete",
      mode,
      issueCount: generatedIssues.length,
    });

    return {
      status: "ok",
      data: {
        specDir: specDir ? path.relative(ctx.workspaceDir, specDir) : null,
        bridgeManifestPath: path.relative(ctx.workspaceDir, bridgeManifestPath),
        issueCount: generatedIssues.length,
        issues: bridgeIssues,
      },
    };
  },
});
