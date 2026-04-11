/**
 * Cross-prompt artifact contracts — single source of truth for section names
 * shared between producer and consumer machine prompts.
 */

export const CONTRACTS = {
  "PLANREVIEW.md": {
    producedBy: "src/machines/develop/plan-review.machine.js",
    consumers: ["src/machines/develop/implementation.machine.js"],
    format: "markdown",
    sections: [
      "Critical Issues (Must Fix)",
      "Over-Engineering Concerns",
      "Data Structure Review",
      "Concerns (Should Address)",
      "Questions (Need Clarification)",
      "Verdict (REJECT | REVISE | PROCEED WITH CAUTION | APPROVED)",
    ],
    sectionDescriptions: {
      "Over-Engineering Concerns":
        "flag speculative optimizations (caches, memoization, fancy " +
        "algorithms) that lack a measurement, and flag fancy data " +
        "structures where plain arrays/objects would work for the " +
        "expected n",
      "Data Structure Review":
        "is the plan carrying the right data shapes? Would different " +
        "data make the algorithm self-evident? Are core types reused " +
        "from elsewhere in the repo?",
    },
  },
  "PLAN.md": {
    producedBy: "src/machines/develop/planning.machine.js",
    consumers: [
      "src/machines/develop/plan-review.machine.js",
      "src/machines/develop/implementation.machine.js",
      "src/machines/develop/quality-review.machine.js",
    ],
    format: "markdown",
    sections: [
      "Summary",
      "Approach",
      "Files to Modify",
      "Files to Create",
      "Dependencies",
      "Testing Strategy",
      "Out of Scope",
    ],
  },
  "REVIEW_FINDINGS.md": {
    producedBy: "src/machines/develop/quality-review.machine.js",
    consumers: ["src/machines/develop/quality-review.machine.js"],
    format: "markdown",
    // Unlike the section-list contracts above, REVIEW_FINDINGS.md is a
    // repeating-findings doc. Producers render the full template via
    // renderReviewFindingsTemplate(), which pulls the heading, finding
    // fields, and verdict line from this entry so nothing is hardcoded.
    findingHeading: "Finding",
    verdictHeading: "VERDICT",
    verdictValues: ["APPROVED", "REVISE"],
    findingFields: ["Severity", "File", "Lines", "Issue", "Suggestion"],
    findingFieldExamples: {
      Severity: "major",
      File: "src/foo.js",
      Lines: "42-58",
      Issue: "<what's wrong>",
      Suggestion: "<how to fix>",
    },
  },
  "ISSUE.md": {
    producedBy: "src/machines/develop/issue-draft.machine.js",
    consumers: [
      "src/machines/develop/planning.machine.js",
      "src/machines/develop/implementation.machine.js",
      "src/machines/develop/quality-review.machine.js",
    ],
    format: "markdown",
    sections: [
      "Metadata",
      "Problem",
      "Requirements",
      "Changes",
      "Testing Strategy",
      "Verification",
      "Out of Scope",
    ],
  },
  "research/issue-backlog.json": {
    producedBy: "src/machines/research/issue-synthesis.machine.js",
    consumers: ["src/machines/research/issue-publish.machine.js"],
    format: "json",
    sections: ["issues", "assumptions", "open_questions"],
    issueFields: [
      "id",
      "title",
      "objective",
      "problem",
      "changes",
      "verification",
      "out_of_scope",
      "depends_on",
      "priority",
      "tags",
      "estimated_effort",
      "acceptance_criteria",
      "testing_strategy",
      "research_questions",
      "risks",
      "notes",
      "references",
      "validation",
    ],
    issueFieldExamples: {
      id: "IDEA-01",
      priority: "P0|P1|P2|P3",
      depends_on: ["IDEA-00"],
      testing_strategy: {
        existing_tests: ["path/to/test — what it covers"],
        new_tests: ["description of test to write and expected behavior"],
        test_patterns: "brief note on repo's test framework/conventions",
      },
      references: [
        {
          source: "github|show_hn|docs|other",
          title: "string",
          url: "string",
          why: "string",
        },
      ],
      validation: {
        mode: "bug_repro|poc|analysis",
        status: "passed|failed|inconclusive|not_run",
        method: "string",
        evidence: ["string"],
        limitations: ["string"],
      },
      changes: ["string"],
      out_of_scope: ["string"],
      tags: ["string"],
      acceptance_criteria: ["string"],
      research_questions: ["string"],
      risks: ["string"],
    },
  },
  "research/spec-architect.json": {
    producedBy: "src/machines/research/spec-architect.machine.js",
    consumers: ["src/machines/research/spec-render.machine.js"],
    format: "json",
    modes: {
      build: { sections: ["domains", "decisions", "phases", "issueSpecs"] },
      ingest: { sections: ["phases", "issueSpecs"] },
    },
    issueFields: [
      "title",
      "objective",
      "problem",
      "changes",
      "acceptance_criteria",
      "priority",
      "domain",
      "depends_on",
      "tags",
      "estimated_effort",
      "testing_strategy",
    ],
    issueFieldExamples: {
      priority: "P0|P1|P2|P3",
      testing_strategy: {
        existing_tests: [],
        new_tests: ["string"],
        test_patterns: "string",
      },
      changes: ["string"],
      acceptance_criteria: ["string"],
      depends_on: [],
      tags: ["string"],
    },
    modeExamples: {
      build: {
        domains: [{ name: "string", description: "string", gaps: ["string"] }],
        decisions: [
          {
            id: "ADR-NNN",
            title: "string",
            status: "proposed|accepted|deprecated|superseded",
            rationale: "string",
          },
        ],
        phases: [{ id: "phase-N", title: "string", issueSpecs: [] }],
      },
      ingest: {
        phases: [
          {
            id: "phase-N",
            title: "string",
            issueSpecs: [{ title: "matching issue title" }],
          },
        ],
      },
    },
  },
};

/**
 * Numbered list of all sections for a contract key. When a section has a
 * matching entry in `sectionDescriptions`, the description is appended
 * after an em-dash on the same line so the rendered output reads naturally
 * inside prompts.
 */
export function renderRequiredSections(key) {
  const entry = CONTRACTS[key];
  if (!entry) throw new Error(`Unknown contract: ${key}`);
  const descriptions = entry.sectionDescriptions || {};
  return entry.sections
    .map((s, i) => {
      const desc = descriptions[s];
      return desc ? `${i + 1}. ${s} — ${desc}` : `${i + 1}. ${s}`;
    })
    .join("\n");
}

/**
 * Comma-joined actionable section names (excludes Verdict sections),
 * with parenthetical suffixes stripped for inline prompt use.
 * Uses " and " before the last item — consumers must address *every*
 * critique section, not any one of them.
 */
export function renderCritiqueSectionList(key) {
  const entry = CONTRACTS[key];
  if (!entry) throw new Error(`Unknown contract: ${key}`);
  const actionable = entry.sections
    .filter((s) => !/^Verdict\b/.test(s))
    .map((s) => s.replace(/\s*\(.*\)$/, ""));
  if (actionable.length <= 1) return actionable.join("");
  return `${actionable.slice(0, -1).join(", ")}, and ${actionable[actionable.length - 1]}`;
}

/** Raw sections array for programmatic use. */
export function getSections(key) {
  const entry = CONTRACTS[key];
  if (!entry) throw new Error(`Unknown contract: ${key}`);
  return entry.sections;
}

/**
 * Bulleted `- **Field**: example` lines for REVIEW_FINDINGS.md findings.
 * Pulls field names from `findingFields` and example values from
 * `findingFieldExamples` so producer and consumer share one source.
 */
export function renderFindingExample(key) {
  const entry = CONTRACTS[key];
  if (!entry?.findingFields)
    throw new Error(`Contract ${key} has no findingFields`);
  const examples = entry.findingFieldExamples || {};
  return entry.findingFields
    .map((f) => `- **${f}**: ${examples[f] ?? "..."}`)
    .join("\n");
}

/**
 * Full REVIEW_FINDINGS.md example block — the `# Review Findings` title,
 * one `## Finding 1` sample with registry-sourced fields, and the
 * `## VERDICT: REVISE` closing line. Single source of truth for the
 * producer prompt so the template cannot drift from the registry.
 */
export function renderReviewFindingsTemplate(key, round) {
  const entry = CONTRACTS[key];
  if (!entry?.findingHeading || !entry?.verdictHeading)
    throw new Error(`Contract ${key} is not a review-findings contract`);
  const defaultVerdict =
    entry.verdictValues?.find((v) => v !== "APPROVED") ?? "REVISE";
  return [
    `# Review Findings — Round ${round}`,
    "",
    `## ${entry.findingHeading} 1`,
    renderFindingExample(key),
    "",
    `## ${entry.verdictHeading}: ${defaultVerdict}`,
  ].join("\n");
}

/**
 * Numbered `N. **Section** — description` list where `descriptions` is a
 * name-keyed map. Enforces that every section in the contract has a
 * description and that no stray keys are passed — swapping, reordering,
 * or forgetting a section fails loudly instead of silently misaligning
 * the prompt text.
 */
export function renderSectionsWithDescriptions(key, descriptions) {
  const entry = CONTRACTS[key];
  if (!entry) throw new Error(`Unknown contract: ${key}`);
  if (!descriptions || typeof descriptions !== "object")
    throw new Error(
      `renderSectionsWithDescriptions(${key}): descriptions required`,
    );
  const missing = entry.sections.filter((s) => !(s in descriptions));
  if (missing.length > 0)
    throw new Error(
      `renderSectionsWithDescriptions(${key}): missing descriptions for ${missing.join(", ")}`,
    );
  const extra = Object.keys(descriptions).filter(
    (k) => !entry.sections.includes(k),
  );
  if (extra.length > 0)
    throw new Error(
      `renderSectionsWithDescriptions(${key}): unknown sections ${extra.join(", ")}`,
    );
  return entry.sections
    .map((s, i) => `${i + 1}. **${s}** — ${descriptions[s]}`)
    .join("\n");
}

/** Build an example issue object from a contract's issueFields + issueFieldExamples. */
export function buildIssueFieldsExample(key) {
  const entry = CONTRACTS[key];
  if (!entry?.issueFields)
    throw new Error(`Contract ${key} has no issueFields`);
  const examples = entry.issueFieldExamples || {};
  return Object.fromEntries(
    entry.issueFields.map((f) => [f, f in examples ? examples[f] : "string"]),
  );
}

/**
 * Full JSON schema example string for the issue-backlog contract.
 * Iterates named sections (not positional indices) — the "issues" slot
 * holds an issue object built from `issueFields`, every other section
 * is a placeholder string array. If the contract ever renames "issues"
 * this helper throws loudly.
 */
export function renderIssueBacklogExample() {
  const entry = CONTRACTS["research/issue-backlog.json"];
  if (!entry.sections.includes("issues"))
    throw new Error(
      "research/issue-backlog.json contract must include an 'issues' section",
    );
  const issueExample = buildIssueFieldsExample("research/issue-backlog.json");
  return JSON.stringify(
    Object.fromEntries(
      entry.sections.map((s) => [
        s,
        s === "issues" ? [issueExample] : ["string"],
      ]),
    ),
    null,
    2,
  );
}

/** Full JSON schema example string for the spec-architect contract (build or ingest mode). */
export function renderSpecArchitectExample(mode) {
  const entry = CONTRACTS["research/spec-architect.json"];
  const modeExample = entry.modeExamples?.[mode];
  if (!modeExample)
    throw new Error(
      `renderSpecArchitectExample: unknown mode "${mode}"; expected one of ${Object.keys(entry.modeExamples || {}).join(", ")}`,
    );
  const issueExample = buildIssueFieldsExample("research/spec-architect.json");
  return JSON.stringify(
    { ...modeExample, issueSpecs: [issueExample] },
    null,
    2,
  );
}
