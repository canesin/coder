import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePlanVerdict } from "../src/machines/develop/plan-review.machine.js";
import { parseReviewVerdict } from "../src/machines/develop/quality-review.machine.js";
import {
  CONTRACTS,
  getSections,
  renderCritiqueSectionList,
  renderIssueBacklogExample,
  renderRequiredSections,
  renderReviewFindingsTemplate,
  renderSectionsWithDescriptions,
  renderSpecArchitectExample,
} from "../src/machines/prompt-contracts.js";
import { renderIdeaIssueMarkdown } from "../src/machines/research/_shared.js";

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

test("every producer and consumer file in CONTRACTS exists", () => {
  for (const [key, entry] of Object.entries(CONTRACTS)) {
    assert.ok(
      existsSync(entry.producedBy),
      `producer for ${key} not found: ${entry.producedBy}`,
    );
    for (const consumer of entry.consumers) {
      assert.ok(
        existsSync(consumer),
        `consumer of ${key} not found: ${consumer}`,
      );
    }
  }
});

// Dedicated helpers bind 1:1 to a specific contract key. When a
// producer calls one, we don't also need the literal key string to
// appear in the source — the helper itself carries the reference.
const DEDICATED_HELPERS = {
  "research/issue-backlog.json": "renderIssueBacklogExample",
  "research/spec-architect.json": "renderSpecArchitectExample",
};

test("every producer file imports the registry AND references its contract key", () => {
  // Two-step check. The import ensures the producer is at least
  // plugged into the registry. The literal contract-key (or dedicated
  // helper) check makes sure the producer is pulling from the
  // ARTIFACT'S OWN entry, not just importing some unrelated helper
  // while re-hardcoding its section names elsewhere.
  const importRe = /from\s+["']\.\.?\/prompt-contracts(?:\.js)?["']/;
  for (const [key, entry] of Object.entries(CONTRACTS)) {
    const src = readFileSync(entry.producedBy, "utf8");
    assert.ok(
      importRe.test(src),
      `${entry.producedBy} (producer for ${key}) does not import from prompt-contracts.js`,
    );
    const referencesKey = src.includes(`"${key}"`) || src.includes(`'${key}'`);
    const dedicatedHelper = DEDICATED_HELPERS[key];
    const referencesDedicated =
      dedicatedHelper && src.includes(dedicatedHelper);
    assert.ok(
      referencesKey || referencesDedicated,
      `${entry.producedBy} (producer for ${key}) never passes "${key}" to a registry helper and does not call its dedicated helper`,
    );
  }
});

// The vast majority of consumer-contract pairs are PASSIVE: the consumer
// reads the artifact file's content as opaque text or destructures JS
// fields from parsed data, and never embeds the contract's section names
// back into a prompt. Passive consumers have no section-name drift risk,
// so they are exempt from the literal-key requirement below.
//
// ACTIVE consumer-contract pairs embed the contract's section names in
// their own prompts. For those, we require the literal contract key (or
// a dedicated helper) to appear in the consumer source — mirroring the
// producer test from round 4 — so drift fails loudly.
const ACTIVE_CONSUMER_PAIRS = [
  // implementation.machine.js instructs the programmer to address every
  // PLANREVIEW.md critique section, and pulls that list from the
  // registry via renderCritiqueSectionList("PLANREVIEW.md").
  {
    consumer: "src/machines/develop/implementation.machine.js",
    key: "PLANREVIEW.md",
  },
];

test("every active consumer pair references its contract key", () => {
  const importRe = /from\s+["']\.\.?\/prompt-contracts(?:\.js)?["']/;
  for (const { consumer, key } of ACTIVE_CONSUMER_PAIRS) {
    assert.ok(
      CONTRACTS[key]?.consumers.includes(consumer),
      `${consumer} is not listed as a consumer of ${key} in CONTRACTS`,
    );
    const src = readFileSync(consumer, "utf8");
    assert.ok(
      importRe.test(src),
      `${consumer} (active consumer of ${key}) does not import from prompt-contracts.js`,
    );
    assert.ok(
      src.includes(`"${key}"`) || src.includes(`'${key}'`),
      `${consumer} (active consumer of ${key}) never passes "${key}" to a registry helper`,
    );
  }
});

// ---------------------------------------------------------------------------
// Parser roundtrips
// ---------------------------------------------------------------------------

test("parsePlanVerdict extracts verdict from synthetic registry artifact", () => {
  const sections = CONTRACTS["PLANREVIEW.md"].sections;
  const md = sections
    .map((s) => {
      if (/^Verdict\b/.test(s)) return `## ${s}\nAPPROVED`;
      return `## ${s}\nNo issues found.`;
    })
    .join("\n\n");
  assert.equal(parsePlanVerdict(md), "APPROVED");
});

test("parseReviewVerdict extracts verdict from synthetic registry artifact", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "contract-test-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  try {
    const fields = CONTRACTS["REVIEW_FINDINGS.md"].findingFields;
    const finding = fields.map((f) => `- **${f}**: test`).join("\n");
    const md = `# Review Findings — Round 1\n\n## Finding 1\n${finding}\n\n## VERDICT: APPROVED\n`;
    writeFileSync(filePath, md);
    const result = parseReviewVerdict(filePath);
    assert.equal(result.verdict, "APPROVED");
    // `findings` is the full markdown content — prove the parser preserved
    // every declared field heading, not just that the string was truthy.
    for (const field of fields) {
      assert.ok(
        result.findings.includes(`**${field}**`),
        `parsed content missing field ${field}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

test("renderRequiredSections includes all contract headings", () => {
  const rendered = renderRequiredSections("PLANREVIEW.md");
  for (const section of CONTRACTS["PLANREVIEW.md"].sections) {
    assert.ok(
      rendered.includes(section),
      `renderRequiredSections missing: ${section}`,
    );
  }
});

test("renderCritiqueSectionList excludes Verdict and strips parentheticals", () => {
  const rendered = renderCritiqueSectionList("PLANREVIEW.md");
  assert.ok(rendered.includes("Critical Issues"), "missing Critical Issues");
  assert.ok(
    rendered.includes("Over-Engineering Concerns"),
    "missing Over-Engineering Concerns",
  );
  assert.ok(!rendered.includes("Verdict"), "Verdict should be excluded");
  assert.ok(
    !rendered.includes("(Must Fix)"),
    "parentheticals should be stripped",
  );
  // Must read as a universal "address every section" list, not alternatives.
  assert.ok(
    /, and \w/.test(rendered),
    "must use ' and ' as the final conjunction, not ' or '",
  );
  assert.ok(!rendered.includes(", or "), "must not use ' or ' conjunction");
});

test("getSections returns correct section array for ISSUE.md", () => {
  assert.deepEqual(getSections("ISSUE.md"), [
    "Metadata",
    "Problem",
    "Requirements",
    "Changes",
    "Testing Strategy",
    "Verification",
    "Out of Scope",
  ]);
});

// ---------------------------------------------------------------------------
// JSON schema render helpers
// ---------------------------------------------------------------------------

test("every issueField has an explicit entry in issueFieldExamples", () => {
  // Guards against buildIssueFieldsExample silently falling back to the
  // generic "string" placeholder when a new array/object-typed field is
  // added without a corresponding example.
  for (const key of [
    "research/issue-backlog.json",
    "research/spec-architect.json",
  ]) {
    const entry = CONTRACTS[key];
    for (const field of entry.issueFields) {
      assert.ok(
        entry.issueFieldExamples && field in entry.issueFieldExamples,
        `${key}: issueField "${field}" is missing from issueFieldExamples`,
      );
    }
  }
});

test("renderIssueBacklogExample produces valid JSON with all contract fields", () => {
  const json = JSON.parse(renderIssueBacklogExample());
  const entry = CONTRACTS["research/issue-backlog.json"];
  for (const section of entry.sections) {
    assert.ok(section in json, `missing top-level section: ${section}`);
  }
  // Issue objects must live under the literal "issues" slot — not
  // whatever section happens to be first in the array. This catches
  // silent misplacement when the sections array is reordered.
  assert.ok(Array.isArray(json.issues), "'issues' must be an array");
  const issue = json.issues[0];
  assert.equal(typeof issue, "object", "'issues[0]' must be an object");
  for (const field of entry.issueFields) {
    assert.ok(field in issue, `missing issue field: ${field}`);
  }
});

test("renderSpecArchitectExample build mode includes exactly the contract sections", () => {
  const json = JSON.parse(renderSpecArchitectExample("build"));
  const entry = CONTRACTS["research/spec-architect.json"];
  // Exact key equality — catches stale keys from modeExamples after a
  // section is removed from modes.build.sections.
  assert.deepEqual(
    Object.keys(json).sort(),
    [...entry.modes.build.sections].sort(),
  );
  const issue = json.issueSpecs[0];
  for (const field of entry.issueFields) {
    assert.ok(field in issue, `missing issue field: ${field}`);
  }
});

test("renderSpecArchitectExample ingest mode includes exactly the contract sections", () => {
  const json = JSON.parse(renderSpecArchitectExample("ingest"));
  const entry = CONTRACTS["research/spec-architect.json"];
  assert.deepEqual(
    Object.keys(json).sort(),
    [...entry.modes.ingest.sections].sort(),
  );
  const issue = json.issueSpecs[0];
  for (const field of entry.issueFields) {
    assert.ok(field in issue, `missing issue field: ${field}`);
  }
});

test("renderSpecArchitectExample throws on unknown mode", () => {
  assert.throws(
    () => renderSpecArchitectExample("nope"),
    /unknown mode "nope"/,
  );
});

// ---------------------------------------------------------------------------
// renderReviewFindingsTemplate
// ---------------------------------------------------------------------------

test("renderReviewFindingsTemplate produces a parser-compatible block", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "contract-test-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  try {
    const block = renderReviewFindingsTemplate("REVIEW_FINDINGS.md", 2);
    // Replace example verdict with APPROVED so parseReviewVerdict agrees.
    const md = block.replace(/VERDICT:\s*REVISE/, "VERDICT: APPROVED");
    writeFileSync(filePath, `${md}\n`);
    const parsed = parseReviewVerdict(filePath);
    assert.equal(parsed.verdict, "APPROVED");
    // Heading/verdict text is sourced from the registry — check it matches.
    const entry = CONTRACTS["REVIEW_FINDINGS.md"];
    assert.ok(block.includes(`## ${entry.findingHeading} 1`));
    assert.ok(block.includes(`## ${entry.verdictHeading}:`));
    for (const field of entry.findingFields) {
      assert.ok(block.includes(`**${field}**`), `missing field ${field}`);
    }
    // Prove the parser preserved every field in its output, not just
    // that `findings` was truthy.
    for (const field of entry.findingFields) {
      assert.ok(
        parsed.findings.includes(`**${field}**`),
        `parsed content missing field ${field}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// renderSectionsWithDescriptions — name-keyed, drift-proof
// ---------------------------------------------------------------------------

test("renderSectionsWithDescriptions numbers every contract section", () => {
  const descriptions = {
    Summary: "S",
    Approach: "A",
    "Files to Modify": "FM",
    "Files to Create": "FC",
    Dependencies: "D",
    "Testing Strategy": "T",
    "Out of Scope": "O",
  };
  const rendered = renderSectionsWithDescriptions("PLAN.md", descriptions);
  const sections = getSections("PLAN.md");
  sections.forEach((s, i) => {
    assert.ok(
      rendered.includes(`${i + 1}. **${s}** — ${descriptions[s]}`),
      `missing row for ${s}`,
    );
  });
});

test("renderSectionsWithDescriptions throws on missing keys", () => {
  assert.throws(
    () =>
      renderSectionsWithDescriptions("PLAN.md", {
        Summary: "S",
        Approach: "A",
      }),
    /missing descriptions for/,
  );
});

test("renderSectionsWithDescriptions throws on unknown keys", () => {
  const entry = CONTRACTS["PLAN.md"];
  const descriptions = Object.fromEntries(entry.sections.map((s) => [s, "x"]));
  descriptions.Stowaway = "extra";
  assert.throws(
    () => renderSectionsWithDescriptions("PLAN.md", descriptions),
    /unknown sections Stowaway/,
  );
});

// ---------------------------------------------------------------------------
// Issue-backlog contract ↔ renderIdeaIssueMarkdown alignment (Finding 3)
// ---------------------------------------------------------------------------

test("renderIdeaIssueMarkdown renders all issue-backlog contract fields", () => {
  const entry = CONTRACTS["research/issue-backlog.json"];
  // Build a sample issue with recognizable values for every contract field
  const sampleIssue = {
    id: "TEST-42",
    title: "Contract alignment test issue",
    objective: "OBJECTIVE_MARKER_abc",
    problem: "PROBLEM_MARKER_xyz",
    changes: ["CHANGE_MARKER_one", "CHANGE_MARKER_two"],
    verification: "VERIFY_MARKER_cmd",
    out_of_scope: ["OUTSCOPE_MARKER"],
    depends_on: ["IDEA-99"],
    priority: "P1",
    tags: ["TAG_MARKER_alpha"],
    estimated_effort: "EFFORT_MARKER_2d",
    acceptance_criteria: ["AC_MARKER_first"],
    testing_strategy: {
      existing_tests: ["EXISTTEST_MARKER_path"],
      new_tests: ["NEWTEST_MARKER_desc"],
      test_patterns: "TESTPAT_MARKER_note",
    },
    research_questions: ["RQ_MARKER_question"],
    risks: ["RISK_MARKER_item"],
    notes: "NOTES_MARKER_text",
    references: [
      {
        source: "github",
        title: "REF_MARKER_title",
        url: "https://REF_MARKER_URL",
        why: "REF_MARKER_why",
      },
    ],
    validation: {
      mode: "poc",
      status: "passed",
      method: "VALMETHOD_MARKER",
      evidence: ["VALEVIDENCE_MARKER"],
      limitations: ["VALLIMIT_MARKER"],
    },
  };

  const rendered = renderIdeaIssueMarkdown({
    issue: sampleIssue,
    issueId: sampleIssue.id,
    title: sampleIssue.title,
    repoPath: ".",
    pointers: "test pointers",
    scratchpadRelPath: ".coder/scratchpad.md",
  });

  // Verify every contract field's value appears in the rendered output
  const markers = {
    id: "TEST-42",
    title: "Contract alignment test issue",
    objective: "OBJECTIVE_MARKER_abc",
    problem: "PROBLEM_MARKER_xyz",
    changes: "CHANGE_MARKER_one",
    verification: "VERIFY_MARKER_cmd",
    out_of_scope: "OUTSCOPE_MARKER",
    depends_on: "IDEA-99",
    priority: "P1",
    tags: "TAG_MARKER_alpha",
    estimated_effort: "EFFORT_MARKER_2d",
    acceptance_criteria: "AC_MARKER_first",
    testing_strategy: "EXISTTEST_MARKER_path",
    research_questions: "RQ_MARKER_question",
    risks: "RISK_MARKER_item",
    notes: "NOTES_MARKER_text",
    references: "REF_MARKER_title",
    validation: "VALMETHOD_MARKER",
  };

  for (const field of entry.issueFields) {
    const marker = markers[field];
    assert.ok(
      marker && rendered.includes(marker),
      `renderIdeaIssueMarkdown does not render contract field "${field}" (expected marker: ${marker})`,
    );
  }
});
