import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSpec } from "../src/spec-check.js";

function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), "spec-check-"));
}

function writeFile(dir, name, content) {
  const filePath = path.join(dir, name);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

// --- Directory checks ---

test("errors on nonexistent directory", () => {
  const result = checkSpec("/tmp/nonexistent-spec-dir-xyz-999");
  assert.equal(result.summary.errors, 1);
  assert.match(result.issues[0].message, /does not exist/);
});

test("errors when path is a file, not a directory", () => {
  const dir = tmpDir();
  const file = path.join(dir, "not-a-dir");
  writeFileSync(file, "hello");
  try {
    const result = checkSpec(file);
    assert.equal(result.summary.errors, 1);
    assert.match(result.issues[0].message, /not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns when no .md files in spec directory", () => {
  const dir = tmpDir();
  writeFile(dir, "readme.txt", "not markdown");
  try {
    const result = checkSpec(dir);
    assert.equal(result.summary.warnings, 1);
    assert.match(result.issues[0].message, /No .md files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Manifest validation ---

test("errors on invalid JSON in manifest.json", () => {
  const dir = tmpDir();
  writeFile(dir, "manifest.json", "{ broken json");
  try {
    const result = checkSpec(dir);
    const manifestErrors = result.issues.filter(
      (i) => i.file === "manifest.json" && i.level === "error",
    );
    assert.ok(manifestErrors.length >= 1);
    assert.match(manifestErrors[0].message, /Invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("errors on schema-invalid manifest", () => {
  const dir = tmpDir();
  writeFile(dir, "manifest.json", JSON.stringify({ specId: "", version: 0 }));
  try {
    const result = checkSpec(dir);
    const schemaErrors = result.issues.filter(
      (i) => i.file === "manifest.json" && i.message.startsWith("Schema:"),
    );
    assert.ok(schemaErrors.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("errors on missing docPath files referenced in manifest", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "manifest.json",
    JSON.stringify({
      specId: "test-run",
      version: 1,
      repoPath: ".",
      domains: [{ name: "auth", docPath: "spec/03-AUTH.md" }],
      decisions: [
        {
          id: "ADR-001",
          title: "Use JWT",
          status: "accepted",
          docPath: "spec/decisions/ADR-001-use-jwt.md",
        },
      ],
      phases: [
        {
          id: "phase-1",
          title: "Foundation",
          issueIds: [],
          docPath: "spec/phases/PHASE-01-foundation.md",
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  try {
    const result = checkSpec(dir);
    const docPathErrors = result.issues.filter(
      (i) => i.file === "manifest.json" && i.message.includes("docPath"),
    );
    // domain + decision + phase = 3 missing docPaths
    assert.equal(docPathErrors.length, 3);
    assert.ok(docPathErrors.every((e) => e.level === "error"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns when issueManifestPath does not exist", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "manifest.json",
    JSON.stringify({
      specId: "test-run",
      version: 1,
      repoPath: ".",
      domains: [],
      createdAt: "2026-01-01T00:00:00Z",
      issueManifestPath: "../.coder/local-issues/manifest.json",
    }),
  );
  try {
    const result = checkSpec(dir);
    const issueManifestWarnings = result.issues.filter((i) =>
      i.message.includes("issueManifestPath"),
    );
    assert.equal(issueManifestWarnings.length, 1);
    assert.equal(issueManifestWarnings[0].level, "warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Manifest cross-validation ---

test("warns on domain name mismatch between manifest and file", () => {
  const base = tmpDir();
  const specDir = path.join(base, "spec");
  mkdirSync(specDir, { recursive: true });
  writeFile(
    specDir,
    "03-AUTH.md",
    "<!-- spec-meta\nversion: 1\ndomain: identity\n-->\n# Identity",
  );
  writeFile(
    specDir,
    "manifest.json",
    JSON.stringify({
      specId: "test",
      version: 1,
      repoPath: ".",
      domains: [{ name: "auth", docPath: "spec/03-AUTH.md" }],
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  try {
    const result = checkSpec(specDir);
    const mismatch = result.issues.filter(
      (i) => i.message.includes("domain") && i.message.includes("identity"),
    );
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].level, "warning");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("warns on decision status mismatch between manifest and file", () => {
  const base = tmpDir();
  const specDir = path.join(base, "spec");
  mkdirSync(specDir, { recursive: true });
  writeFile(
    specDir,
    "decisions/ADR-001-use-jwt.md",
    "<!-- adr-meta\nstatus: deprecated\n-->\n# Use JWT",
  );
  writeFile(
    specDir,
    "manifest.json",
    JSON.stringify({
      specId: "test",
      version: 1,
      repoPath: ".",
      domains: [],
      decisions: [
        {
          id: "ADR-001",
          title: "Use JWT",
          status: "accepted",
          docPath: "spec/decisions/ADR-001-use-jwt.md",
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  try {
    const result = checkSpec(specDir);
    const mismatch = result.issues.filter(
      (i) =>
        i.message.includes("status") &&
        i.message.includes("accepted") &&
        i.message.includes("deprecated"),
    );
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].level, "warning");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("warns on phase title mismatch between manifest and file", () => {
  const base = tmpDir();
  const specDir = path.join(base, "spec");
  mkdirSync(specDir, { recursive: true });
  writeFile(specDir, "phases/PHASE-01-foundation.md", "# Setup\n\nDetails.");
  writeFile(
    specDir,
    "manifest.json",
    JSON.stringify({
      specId: "test",
      version: 1,
      repoPath: ".",
      domains: [],
      phases: [
        {
          id: "phase-1",
          title: "Foundation",
          issueIds: [],
          docPath: "spec/phases/PHASE-01-foundation.md",
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  try {
    const result = checkSpec(specDir);
    const mismatch = result.issues.filter(
      (i) =>
        i.message.includes("title") &&
        i.message.includes("Foundation") &&
        i.message.includes("Setup"),
    );
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].level, "warning");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Domain doc validation ---

test("warns on domain .md missing spec-meta block", () => {
  const dir = tmpDir();
  writeFile(dir, "03-AUTH.md", "# Auth Domain\n\nSome content.");
  try {
    const result = checkSpec(dir);
    const metaWarnings = result.issues.filter((i) =>
      i.message.includes("spec-meta"),
    );
    assert.equal(metaWarnings.length, 1);
    assert.equal(metaWarnings[0].file, "03-AUTH.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns on spec-meta missing version field", () => {
  const dir = tmpDir();
  writeFile(dir, "03-AUTH.md", "<!-- spec-meta\ndomain: auth\n-->\n# Auth");
  try {
    const result = checkSpec(dir);
    const versionWarnings = result.issues.filter((i) =>
      i.message.includes("version"),
    );
    assert.equal(versionWarnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns on spec-meta missing domain field", () => {
  const dir = tmpDir();
  writeFile(dir, "03-AUTH.md", "<!-- spec-meta\nversion: 1\n-->\n# Auth");
  try {
    const result = checkSpec(dir);
    const domainWarnings = result.issues.filter((i) =>
      i.message.includes("domain"),
    );
    assert.equal(domainWarnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips synthetic overview/architecture docs", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "01-OVERVIEW.md",
    "<!-- spec-meta\nversion: 1\ndomain: overview\n-->\n# Overview",
  );
  writeFile(
    dir,
    "02-ARCHITECTURE.md",
    "<!-- spec-meta\nversion: 1\ndomain: architecture\n-->\n# Architecture",
  );
  try {
    const result = checkSpec(dir);
    // Synthetic docs are skipped — no warnings about missing fields
    assert.equal(result.issues.length, 0);
    assert.equal(result.summary.domains, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- ADR validation ---

test("errors on ADR missing adr-meta block", () => {
  const dir = tmpDir();
  writeFile(dir, "decisions/ADR-001-use-jwt.md", "# Use JWT\n\nWe chose JWT.");
  try {
    const result = checkSpec(dir);
    const adrErrors = result.issues.filter(
      (i) => i.file.startsWith("decisions/") && i.level === "error",
    );
    assert.equal(adrErrors.length, 1);
    assert.match(adrErrors[0].message, /adr-meta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("errors on ADR with invalid status", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "decisions/ADR-001-use-jwt.md",
    "<!-- adr-meta\nstatus: invalid-status\n-->\n# Use JWT",
  );
  try {
    const result = checkSpec(dir);
    const statusErrors = result.issues.filter((i) =>
      i.message.includes("Invalid ADR status"),
    );
    assert.equal(statusErrors.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts valid ADR status values", () => {
  const dir = tmpDir();
  for (const status of ["proposed", "accepted", "deprecated", "superseded"]) {
    writeFile(
      dir,
      `decisions/ADR-${status}.md`,
      `<!-- adr-meta\nstatus: ${status}\n-->\n# ${status}`,
    );
  }
  try {
    const result = checkSpec(dir);
    const adrErrors = result.issues.filter((i) =>
      i.file.startsWith("decisions/"),
    );
    assert.equal(adrErrors.length, 0);
    assert.equal(result.summary.decisions, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Gap checklist validation ---

test("detects malformed gap lines", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "03-AUTH.md",
    [
      "<!-- spec-meta\nversion: 1\ndomain: auth\n-->",
      "# Auth",
      "## Gaps",
      // Valid gap
      "- [ ] **1. Gap** \u2014 Missing auth. Domain: auth. Severity: high.",
      // Malformed: missing severity period / wrong format
      "- [ ] Missing number bold. Domain: auth. Severity: high",
    ].join("\n"),
  );
  try {
    const result = checkSpec(dir);
    assert.equal(result.summary.gaps, 1); // only the valid one
    const gapWarnings = result.issues.filter((i) =>
      i.message.includes("malformed"),
    );
    assert.equal(gapWarnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean gaps produce no warnings", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "03-AUTH.md",
    [
      "<!-- spec-meta\nversion: 1\ndomain: auth\n-->",
      "# Auth",
      "## Gaps",
      "- [ ] **1. Gap** \u2014 Missing auth. Domain: auth. Severity: high.",
      "- [x] **2. Gap** \u2014 Done item. Domain: auth. Severity: low.",
    ].join("\n"),
  );
  try {
    const result = checkSpec(dir);
    assert.equal(result.summary.gaps, 2);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Phase validation ---

test("warns on phase doc missing heading", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "phases/PHASE-01-foundation.md",
    "No heading here.\nJust text.",
  );
  try {
    const result = checkSpec(dir);
    const phaseWarnings = result.issues.filter(
      (i) => i.file.startsWith("phases/") && i.message.includes("heading"),
    );
    assert.equal(phaseWarnings.length, 1);
    assert.equal(result.summary.phases, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts phase doc with heading", () => {
  const dir = tmpDir();
  writeFile(dir, "phases/PHASE-01-foundation.md", "# Foundation\n\nDetails.");
  try {
    const result = checkSpec(dir);
    const phaseWarnings = result.issues.filter((i) =>
      i.file.startsWith("phases/"),
    );
    assert.equal(phaseWarnings.length, 0);
    assert.equal(result.summary.phases, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Bridge manifest validation ---

test("warns on bridge manifest with invalid issue shape", () => {
  const base = tmpDir();
  const specDir = path.join(base, "spec");
  mkdirSync(specDir, { recursive: true });
  const bridgeDir = path.join(base, ".coder", "local-issues");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    path.join(bridgeDir, "manifest.json"),
    JSON.stringify({
      repoRoot: "/tmp",
      repoPath: ".",
      issues: [{ id: "", title: "" }], // empty id will fail IssueItemSchema
    }),
  );
  writeFile(
    specDir,
    "manifest.json",
    JSON.stringify({
      specId: "test",
      version: 1,
      repoPath: ".",
      domains: [],
      issueManifestPath: ".coder/local-issues/manifest.json",
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  try {
    const result = checkSpec(specDir);
    const bridgeWarnings = result.issues.filter(
      (i) =>
        i.level === "warning" &&
        i.file.includes("manifest.json") &&
        i.message.includes("Issue"),
    );
    assert.ok(bridgeWarnings.length >= 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("warns on dangling depends_on references", () => {
  const base = tmpDir();
  const specDir = path.join(base, "spec");
  mkdirSync(specDir, { recursive: true });
  const bridgeDir = path.join(base, ".coder", "local-issues");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    path.join(bridgeDir, "manifest.json"),
    JSON.stringify({
      repoRoot: "/tmp",
      repoPath: ".",
      issues: [
        {
          id: "SPEC-01",
          title: "First",
          filePath: "issues/01.md",
          depends_on: ["SPEC-99"],
        },
      ],
    }),
  );
  writeFile(
    specDir,
    "manifest.json",
    JSON.stringify({
      specId: "test",
      version: 1,
      repoPath: ".",
      domains: [],
      issueManifestPath: ".coder/local-issues/manifest.json",
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  try {
    const result = checkSpec(specDir);
    const depWarnings = result.issues.filter((i) =>
      i.message.includes("depends_on"),
    );
    assert.equal(depWarnings.length, 1);
    assert.match(depWarnings[0].message, /SPEC-99/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Clean spec (full valid directory) ---

test("valid spec directory returns zero issues", () => {
  const base = tmpDir();
  const specDir = path.join(base, "spec");
  mkdirSync(specDir, { recursive: true });

  // Overview + Architecture (synthetic, skipped)
  writeFile(
    specDir,
    "01-OVERVIEW.md",
    "<!-- spec-meta\nversion: 1\ndomain: overview\n-->\n# Overview",
  );
  writeFile(
    specDir,
    "02-ARCHITECTURE.md",
    "<!-- spec-meta\nversion: 1\ndomain: architecture\n-->\n# Architecture",
  );

  // Domain doc
  writeFile(
    specDir,
    "03-AUTH.md",
    "<!-- spec-meta\nversion: 1\ndomain: auth\n-->\n# Auth\n\n## Gaps\n\n- [ ] **1. Gap** \u2014 Missing tokens. Domain: auth. Severity: high.",
  );

  // ADR
  writeFile(
    specDir,
    "decisions/ADR-001-use-jwt.md",
    "<!-- adr-meta\nstatus: accepted\n-->\n# Use JWT",
  );

  // Phase
  writeFile(
    specDir,
    "phases/PHASE-01-foundation.md",
    "# Foundation\n\n## Issues\n\n- SPEC-01",
  );

  // Manifest (docPaths relative to base, the parent of specDir)
  writeFile(
    specDir,
    "manifest.json",
    JSON.stringify({
      specId: "test-run",
      version: 1,
      repoPath: ".",
      domains: [{ name: "auth", docPath: "spec/03-AUTH.md" }],
      decisions: [
        {
          id: "ADR-001",
          title: "Use JWT",
          status: "accepted",
          docPath: "spec/decisions/ADR-001-use-jwt.md",
        },
      ],
      phases: [
        {
          id: "phase-1",
          title: "Foundation",
          issueIds: ["SPEC-01"],
          docPath: "spec/phases/PHASE-01-foundation.md",
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );

  try {
    const result = checkSpec(specDir);
    assert.equal(
      result.summary.errors,
      0,
      `Unexpected errors: ${JSON.stringify(result.issues)}`,
    );
    assert.equal(
      result.summary.warnings,
      0,
      `Unexpected warnings: ${JSON.stringify(result.issues)}`,
    );
    assert.equal(result.summary.domains, 1);
    assert.equal(result.summary.decisions, 1);
    assert.equal(result.summary.phases, 1);
    assert.equal(result.summary.gaps, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- Result shape ---

test("result has expected shape", () => {
  const dir = tmpDir();
  writeFile(
    dir,
    "03-AUTH.md",
    "<!-- spec-meta\nversion: 1\ndomain: auth\n-->\n# Auth",
  );
  try {
    const result = checkSpec(dir);
    assert.equal(typeof result.specDir, "string");
    assert.ok(Array.isArray(result.issues));
    assert.equal(typeof result.summary.errors, "number");
    assert.equal(typeof result.summary.warnings, "number");
    assert.equal(typeof result.summary.files, "number");
    assert.equal(typeof result.summary.domains, "number");
    assert.equal(typeof result.summary.decisions, "number");
    assert.equal(typeof result.summary.phases, "number");
    assert.equal(typeof result.summary.gaps, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
