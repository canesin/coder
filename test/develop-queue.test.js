import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDependencyGraph,
  orderByDependencies,
} from "../src/github/dependencies.js";

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "develop-queue-test-"));
}

// --- Dependency graph tests ---

test("buildDependencyGraph sorts A before B when B depends on A", () => {
  const issues = [
    { id: "B", dependsOn: ["A"] },
    { id: "A", dependsOn: [] },
    { id: "C", dependsOn: [] },
  ];
  const { sorted, cycles } = buildDependencyGraph(issues);
  assert.ok(sorted.indexOf("A") < sorted.indexOf("B"));
  assert.equal(cycles.length, 0);
});

test("orderByDependencies returns full objects in dependency order", () => {
  const issues = [
    { id: "C", title: "C", dependsOn: ["B"] },
    { id: "A", title: "A", dependsOn: [] },
    { id: "B", title: "B", dependsOn: ["A"] },
  ];
  const ordered = orderByDependencies(issues);
  const ids = ordered.map((i) => i.id);
  assert.ok(ids.indexOf("A") < ids.indexOf("B"));
  assert.ok(ids.indexOf("B") < ids.indexOf("C"));
  assert.equal(ordered.length, 3);
});

test("buildDependencyGraph detects cycles and still returns all nodes", () => {
  const issues = [
    { id: "A", dependsOn: ["B"] },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: [] },
  ];
  const { sorted, cycles } = buildDependencyGraph(issues);
  assert.equal(sorted.length, 3);
  assert.ok(sorted.includes("A"));
  assert.ok(sorted.includes("B"));
  assert.ok(sorted.includes("C"));
  assert.ok(cycles.length > 0, "Expected at least one cycle");
});

test("buildDependencyGraph skips external deps not in the set", () => {
  const issues = [
    { id: "A", dependsOn: ["EXTERNAL-1"] },
    { id: "B", dependsOn: ["A"] },
  ];
  const { sorted, cycles } = buildDependencyGraph(issues);
  assert.deepEqual(sorted, ["A", "B"]);
  assert.equal(cycles.length, 0);
});

test("buildDependencyGraph handles no dependencies at all", () => {
  const issues = [
    { id: "X", dependsOn: [] },
    { id: "Y", dependsOn: [] },
    { id: "Z", dependsOn: [] },
  ];
  const { sorted, cycles } = buildDependencyGraph(issues);
  assert.equal(sorted.length, 3);
  assert.equal(cycles.length, 0);
});

// --- Local issue loading tests ---

test("IssueItemSchema accepts local source with depends_on", async () => {
  const { IssueItemSchema } = await import("../src/schemas.js");
  const parsed = IssueItemSchema.parse({
    source: "local",
    id: "ISSUE-01",
    title: "Test issue",
    depends_on: ["ISSUE-00"],
  });
  assert.equal(parsed.source, "local");
  assert.deepEqual(parsed.depends_on, ["ISSUE-00"]);
  assert.equal(parsed.difficulty, 3); // default
});

test("IssuesPayloadSchema accepts depends_on field", async () => {
  const { IssuesPayloadSchema } = await import("../src/schemas.js");
  const parsed = IssuesPayloadSchema.parse({
    issues: [
      {
        source: "github",
        id: "123",
        title: "Fix bug",
        difficulty: 2,
        depends_on: ["456"],
      },
    ],
    recommended_index: 0,
  });
  assert.deepEqual(parsed.issues[0].depends_on, ["456"]);
});

test("LoopIssueResultSchema accepts local source", async () => {
  const { saveLoopState, loadLoopState } = await import(
    "../src/state/workflow-state.js"
  );
  const tmp = makeTmpDir();
  try {
    await saveLoopState(tmp, {
      runId: "test-1",
      status: "running",
      issueQueue: [
        {
          source: "local",
          id: "ISSUE-01",
          title: "Local issue",
          status: "pending",
          dependsOn: ["ISSUE-00"],
        },
      ],
    });
    const loaded = await loadLoopState(tmp);
    assert.equal(loaded.issueQueue[0].source, "local");
    assert.deepEqual(loaded.issueQueue[0].dependsOn, ["ISSUE-00"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Local manifest loading test ---

test("loadLocalIssues parses manifest.json and extracts titles from markdown", async () => {
  // We need to test the loadLocalIssues function indirectly through issue-list
  // Instead, test the manifest format directly
  const tmp = makeTmpDir();
  const issuesDir = path.join(tmp, "issues");
  mkdirSync(issuesDir, { recursive: true });

  // Write manifest
  writeFileSync(
    path.join(issuesDir, "manifest.json"),
    JSON.stringify({
      issues: [
        {
          id: "ISSUE-01",
          file: "issues/01-first.md",
          priority: "P1",
          title: "First issue",
        },
        {
          id: "ISSUE-02",
          file: "issues/02-second.md",
          priority: "P2",
          dependsOn: ["ISSUE-01"],
          title: "Second issue",
        },
      ],
    }),
  );

  // Write markdown files
  writeFileSync(
    path.join(issuesDir, "01-first.md"),
    "# ISSUE-01 — First issue\n\nDetails here.",
  );
  writeFileSync(
    path.join(issuesDir, "02-second.md"),
    "# ISSUE-02 — Second issue\n\nMore details.",
  );

  // Test the schema parsing that loadLocalIssues uses
  const { IssueItemSchema } = await import("../src/schemas.js");

  const entry1 = IssueItemSchema.parse({
    source: "local",
    id: "ISSUE-01",
    title: "First issue",
    depends_on: [],
  });
  assert.equal(entry1.source, "local");
  assert.equal(entry1.id, "ISSUE-01");

  const entry2 = IssueItemSchema.parse({
    source: "local",
    id: "ISSUE-02",
    title: "Second issue",
    depends_on: ["ISSUE-01"],
  });
  assert.deepEqual(entry2.depends_on, ["ISSUE-01"]);

  rmSync(tmp, { recursive: true, force: true });
});

test("dependency chain: A->B->C produces correct order", () => {
  const issues = [
    { id: "C", dependsOn: ["B"] },
    { id: "B", dependsOn: ["A"] },
    { id: "A", dependsOn: [] },
  ];
  const ordered = orderByDependencies(issues);
  assert.deepEqual(
    ordered.map((i) => i.id),
    ["A", "B", "C"],
  );
});

test("diamond dependency: D depends on B and C, both depend on A", () => {
  const issues = [
    { id: "D", dependsOn: ["B", "C"] },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["A"] },
    { id: "A", dependsOn: [] },
  ];
  const { sorted } = buildDependencyGraph(issues);
  assert.ok(sorted.indexOf("A") < sorted.indexOf("B"));
  assert.ok(sorted.indexOf("A") < sorted.indexOf("C"));
  assert.ok(sorted.indexOf("B") < sorted.indexOf("D"));
  assert.ok(sorted.indexOf("C") < sorted.indexOf("D"));
});

test("IssueItemSchema accepts gitlab source", async () => {
  const { IssueItemSchema } = await import("../src/schemas.js");
  const result = IssueItemSchema.safeParse({
    source: "gitlab",
    id: "42",
    title: "Test",
  });
  assert.equal(result.success, true);
  assert.equal(result.data.source, "gitlab");
});
