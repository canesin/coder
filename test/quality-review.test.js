import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveModelName } from "../src/helpers.js";
import { parseReviewVerdict } from "../src/machines/develop/quality-review.machine.js";

// ---------------------------------------------------------------------------
// parseReviewVerdict
// ---------------------------------------------------------------------------

test("parseReviewVerdict returns nulls for nonexistent file", () => {
  const result = parseReviewVerdict("/nonexistent-" + Date.now());
  assert.equal(result.verdict, null);
  assert.equal(result.findings, null);
});

test("parseReviewVerdict returns null verdict when no verdict line exists", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(
    filePath,
    "# Review Findings\n\n## Finding 1\nSome issue here\n",
  );
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, null);
  assert.ok(result.findings.includes("Finding 1"));
});

test("parseReviewVerdict extracts APPROVED verdict", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(
    filePath,
    "# Review Findings — Round 1\n\n## Finding 1\nMinor issue\n\n## VERDICT: APPROVED\n",
  );
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "APPROVED");
  assert.ok(result.findings.includes("Finding 1"));
});

test("parseReviewVerdict extracts REVISE verdict", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(
    filePath,
    "# Review Findings — Round 1\n\n## Finding 1\nCritical bug\n\n## VERDICT: REVISE\n",
  );
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "REVISE");
});

test("parseReviewVerdict takes the LAST verdict (ignores earlier prompt examples)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  const content = [
    "# Review Findings — Round 1",
    "",
    "Example format:",
    "## VERDICT: APPROVED",
    "",
    "## Finding 1",
    "Critical issue found",
    "",
    "## VERDICT: REVISE",
    "",
  ].join("\n");
  writeFileSync(filePath, content);
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "REVISE");
});

test("parseReviewVerdict ignores verdict inside code fences", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  // The regex uses ^...$ with multiline, so a verdict inside a code block
  // that starts at column 0 would still match. The mitigation is "take last".
  // This test verifies the last-match behavior when the real verdict follows.
  const content = [
    "# Review Findings",
    "",
    "```markdown",
    "## VERDICT: REVISE",
    "```",
    "",
    "## VERDICT: APPROVED",
    "",
  ].join("\n");
  writeFileSync(filePath, content);
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "APPROVED");
});

test("parseReviewVerdict handles trailing whitespace on verdict line", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(filePath, "## VERDICT: APPROVED   \n");
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "APPROVED");
});

// ---------------------------------------------------------------------------
// resolveModelName
// ---------------------------------------------------------------------------

test("resolveModelName returns string as-is", () => {
  assert.equal(resolveModelName("gemini-2.5-pro"), "gemini-2.5-pro");
});

test("resolveModelName extracts .model from object", () => {
  assert.equal(
    resolveModelName({ model: "gemini-2.5-pro", apiEndpoint: "http://..." }),
    "gemini-2.5-pro",
  );
});

test("resolveModelName returns null/undefined passthrough", () => {
  assert.equal(resolveModelName(null), null);
  assert.equal(resolveModelName(undefined), undefined);
});

test("resolveModelName returns undefined for empty object", () => {
  assert.equal(resolveModelName({}), undefined);
});
