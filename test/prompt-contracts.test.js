import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(result.findings);
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

test("renderIssueBacklogExample produces valid JSON with all contract fields", () => {
  const json = JSON.parse(renderIssueBacklogExample());
  const entry = CONTRACTS["research/issue-backlog.json"];
  for (const section of entry.sections) {
    assert.ok(section in json, `missing top-level section: ${section}`);
  }
  const issue = json[entry.sections[0]][0];
  for (const field of entry.issueFields) {
    assert.ok(field in issue, `missing issue field: ${field}`);
  }
});

test("renderSpecArchitectExample build mode includes all sections and fields", () => {
  const json = JSON.parse(renderSpecArchitectExample("build"));
  const entry = CONTRACTS["research/spec-architect.json"];
  for (const section of entry.modes.build.sections) {
    assert.ok(section in json, `missing build section: ${section}`);
  }
  const issue = json.issueSpecs[0];
  for (const field of entry.issueFields) {
    assert.ok(field in issue, `missing issue field: ${field}`);
  }
});

test("renderSpecArchitectExample ingest mode includes all sections and fields", () => {
  const json = JSON.parse(renderSpecArchitectExample("ingest"));
  const entry = CONTRACTS["research/spec-architect.json"];
  for (const section of entry.modes.ingest.sections) {
    assert.ok(section in json, `missing ingest section: ${section}`);
  }
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
