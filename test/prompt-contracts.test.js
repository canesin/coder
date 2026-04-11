import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePlanVerdict } from "../src/machines/develop/plan-review.machine.js";
import { parseReviewVerdict } from "../src/machines/develop/quality-review.machine.js";
import {
  CONTRACTS,
  renderCritiqueSectionList,
  renderRequiredSections,
} from "../src/machines/prompt-contracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test("CONTRACTS object has expected artifact keys", () => {
  const expectedKeys = [
    "PLANREVIEW.md",
    "PLAN.md",
    "ISSUE.md",
    "REVIEW_FINDINGS.md",
    "SPEC_DELTA",
    "synthesis-draft",
    "synthesis-review",
    "spec-architect-build",
    "spec-architect-ingest",
  ];
  for (const key of expectedKeys) {
    assert.ok(CONTRACTS[key], `missing CONTRACTS entry: ${key}`);
  }
});

test("registry producer/consumer paths point to existing files", () => {
  for (const [key, entry] of Object.entries(CONTRACTS)) {
    assert.ok(
      existsSync(path.resolve(repoRoot, entry.producedBy)),
      `producer file missing for ${key}: ${entry.producedBy}`,
    );
    for (const consumer of entry.consumers) {
      assert.ok(
        existsSync(path.resolve(repoRoot, consumer.file)),
        `consumer file missing for ${key}: ${consumer.file}`,
      );
    }
  }
});

test("renderRequiredSections outputs all section headings for PLANREVIEW.md", () => {
  const rendered = renderRequiredSections("PLANREVIEW.md");
  assert.match(rendered, /Critical Issues/);
  assert.match(rendered, /Over-Engineering Concerns/);
  assert.match(rendered, /Concerns/);
  assert.match(rendered, /Questions/);
  assert.match(rendered, /Verdict/);
});

test("renderRequiredSections outputs numbered list for PLAN.md", () => {
  const rendered = renderRequiredSections("PLAN.md");
  assert.match(rendered, /1\..*Summary/);
  assert.match(rendered, /7\..*Out of Scope/);
  // Verify all 7 sections present
  const lines = rendered.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 7);
});

test("renderCritiqueSectionList throws on unknown section name", () => {
  assert.throws(
    () => renderCritiqueSectionList("PLANREVIEW.md", ["Nonexistent Section"]),
    /not found/,
  );
});

test("renderCritiqueSectionList returns joined names for valid sections", () => {
  const result = renderCritiqueSectionList("PLANREVIEW.md", [
    "Critical Issues (Must Fix)",
    "Over-Engineering Concerns",
  ]);
  assert.ok(result.includes("Critical Issues (Must Fix)"));
  assert.ok(result.includes("Over-Engineering Concerns"));
});

test("parsePlanVerdict roundtrips on synthetic PLANREVIEW.md", () => {
  const sections = CONTRACTS["PLANREVIEW.md"].sections;
  const parts = [];
  for (const s of sections) {
    if (s.name.startsWith("Verdict")) {
      parts.push(`## ${s.name}\nAPPROVED`);
    } else {
      parts.push(`## ${s.name}\n- No issues found.`);
    }
  }
  const syntheticMd = parts.join("\n\n");
  assert.strictEqual(parsePlanVerdict(syntheticMd), "APPROVED");
});

test("parseReviewVerdict roundtrips on synthetic REVIEW_FINDINGS.md using verdictPrefix/verdictValues", () => {
  const entry = CONTRACTS["REVIEW_FINDINGS.md"];
  const syntheticContent =
    "# Review Findings — Round 1\n\n" +
    "## Finding 1\n- **Severity**: minor\n- **File**: foo.js\n- **Issue**: Nit\n- **Suggestion**: Fix it\n\n" +
    entry.verdictPrefix +
    entry.verdictValues[0];

  const tmp = mkdtempSync(path.join(os.tmpdir(), "review-verdict-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(filePath, syntheticContent);

  const result = parseReviewVerdict(filePath);
  assert.strictEqual(result.verdict, "APPROVED");
});

test("markdown entries have sections array, json entries have fields object", () => {
  for (const [key, entry] of Object.entries(CONTRACTS)) {
    if (entry.sections) {
      assert.ok(Array.isArray(entry.sections), `${key}.sections is not array`);
      for (const s of entry.sections) {
        assert.ok(s.name, `${key} section missing name`);
        assert.ok(s.description, `${key} section missing description`);
      }
    }
    if (entry.fields) {
      assert.equal(typeof entry.fields, "object", `${key}.fields not object`);
    }
  }
});
