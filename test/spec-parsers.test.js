import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAdrStatus,
  parseSpecGaps,
  parseSpecMeta,
} from "../src/helpers.js";
import { SpecManifestSchema } from "../src/schemas.js";

// --- parseSpecMeta ---

test("parseSpecMeta extracts version and domain", () => {
  assert.deepStrictEqual(
    parseSpecMeta("<!-- spec-meta\nversion: 1\ndomain: auth\n-->"),
    { version: "1", domain: "auth" },
  );
});

test("parseSpecMeta returns empty object when no spec-meta block", () => {
  assert.deepStrictEqual(parseSpecMeta("# Just a heading"), {});
});

test("parseSpecMeta handles extra whitespace in values", () => {
  const result = parseSpecMeta(
    "<!-- spec-meta\n  version:  2 \n  domain:  payments \n-->",
  );
  assert.equal(result.version, "2");
  assert.equal(result.domain, "payments");
});

test("parseSpecMeta handles CRLF line endings", () => {
  const result = parseSpecMeta(
    "<!-- spec-meta\r\nversion: 1\r\ndomain: api\r\n-->",
  );
  assert.equal(result.version, "1");
  assert.equal(result.domain, "api");
});

// --- parseAdrStatus ---

test("parseAdrStatus extracts 'accepted'", () => {
  assert.strictEqual(
    parseAdrStatus("<!-- adr-meta\nstatus: accepted\n-->"),
    "accepted",
  );
});

test("parseAdrStatus returns null when no adr-meta block", () => {
  assert.strictEqual(parseAdrStatus("# ADR without meta"), null);
});

test("parseAdrStatus extracts 'deprecated'", () => {
  assert.strictEqual(
    parseAdrStatus("<!-- adr-meta\nstatus: deprecated\n-->"),
    "deprecated",
  );
});

test("parseAdrStatus handles CRLF line endings", () => {
  assert.strictEqual(
    parseAdrStatus("<!-- adr-meta\r\nstatus: proposed\r\n-->"),
    "proposed",
  );
});

// --- parseSpecGaps ---

test("parseSpecGaps returns array of checklist items", () => {
  assert.deepStrictEqual(
    parseSpecGaps(
      "- [ ] **1. Gap** — Needs work. Domain: AUTH. Severity: blocker.",
    ),
    [
      {
        description: "Needs work.",
        domain: "AUTH",
        severity: "blocker",
        status: "open",
      },
    ],
  );
});

test("parseSpecGaps handles checked items as done", () => {
  const result = parseSpecGaps(
    "- [x] **1. Fixed** — Was fixed. Domain: DB. Severity: minor.",
  );
  assert.equal(result[0].status, "done");
});

test("parseSpecGaps returns empty array for non-matching text", () => {
  assert.deepStrictEqual(parseSpecGaps("No gaps here"), []);
});

test("parseSpecGaps handles multiple gap lines", () => {
  const text = [
    "- [ ] **1. First** — Desc one. Domain: API. Severity: blocker.",
    "- [x] **2. Second** — Desc two. Domain: AUTH. Severity: minor.",
  ].join("\n");
  const gaps = parseSpecGaps(text);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].status, "open");
  assert.equal(gaps[1].status, "done");
});

test("parseSpecGaps handles CRLF and extra whitespace", () => {
  const text =
    "-  [ ] **1. Gap** — Needs work. Domain: AUTH. Severity: blocker.\r\n-  [x] **2. Done** — Fixed. Domain: DB. Severity: minor.";
  const gaps = parseSpecGaps(text);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].status, "open");
  assert.equal(gaps[1].status, "done");
});

// --- SpecManifestSchema ---

test("SpecManifestSchema rejects missing specId", () => {
  assert.throws(() => SpecManifestSchema.parse({ version: 1 }));
});

test("SpecManifestSchema accepts valid manifest", () => {
  const valid = {
    specId: "spec-001",
    version: 1,
    repoPath: ".",
    domains: [{ name: "auth", docPath: "spec/03-auth.md" }],
    createdAt: new Date().toISOString(),
  };
  const parsed = SpecManifestSchema.parse(valid);
  assert.equal(parsed.specId, "spec-001");
  assert.equal(parsed.domains.length, 1);
  assert.deepStrictEqual(parsed.decisions, []);
  assert.deepStrictEqual(parsed.phases, []);
});

test("SpecManifestSchema accepts full manifest with decisions and phases", () => {
  const valid = {
    specId: "spec-002",
    version: 1,
    repoPath: "subdir",
    domains: [{ name: "core", docPath: "spec/03-core.md" }],
    decisions: [
      {
        id: "ADR-001",
        title: "Use X",
        status: "accepted",
        docPath: "spec/decisions/ADR-001.md",
      },
    ],
    phases: [
      {
        id: "phase-1",
        title: "Foundation",
        issueIds: ["SPEC-01"],
        docPath: "spec/phases/PHASE-01.md",
      },
    ],
    issueManifestPath: ".coder/local-issues/manifest.json",
    createdAt: new Date().toISOString(),
  };
  const parsed = SpecManifestSchema.parse(valid);
  assert.equal(parsed.decisions.length, 1);
  assert.equal(parsed.decisions[0].status, "accepted");
  assert.equal(parsed.phases.length, 1);
});
