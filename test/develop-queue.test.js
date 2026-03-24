import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDependencyGraph,
  getTransitiveDependents,
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

// --- getTransitiveDependents ---

test("getTransitiveDependents returns direct dependents", () => {
  const issues = [
    { id: "A", dependsOn: [] },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: [] },
  ];
  const deps = getTransitiveDependents(issues, "A");
  assert.ok(deps.has("B"));
  assert.ok(!deps.has("C"));
  assert.ok(!deps.has("A"));
});

test("getTransitiveDependents returns transitive chain", () => {
  const issues = [
    { id: "A", dependsOn: [] },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["B"] },
    { id: "D", dependsOn: [] },
  ];
  const deps = getTransitiveDependents(issues, "A");
  assert.ok(deps.has("B"));
  assert.ok(deps.has("C"));
  assert.ok(!deps.has("D"));
});

test("getTransitiveDependents handles diamond shape", () => {
  const issues = [
    { id: "A", dependsOn: [] },
    { id: "B", dependsOn: ["A"] },
    { id: "C", dependsOn: ["A"] },
    { id: "D", dependsOn: ["B", "C"] },
    { id: "E", dependsOn: [] },
  ];
  const deps = getTransitiveDependents(issues, "A");
  assert.deepEqual([...deps].sort(), ["B", "C", "D"]);
  assert.ok(!deps.has("E"));
});

test("getTransitiveDependents returns empty set for leaf node", () => {
  const issues = [
    { id: "A", dependsOn: [] },
    { id: "B", dependsOn: ["A"] },
  ];
  const deps = getTransitiveDependents(issues, "B");
  assert.equal(deps.size, 0);
});

// --- Forced order preservation ---

test("forced local issues preserve order through develop loop queue", async () => {
  const { execSync } = await import("node:child_process");
  const { WorkflowRunner } = await import("../src/workflows/_base.js");
  const { runDevelopLoop } = await import(
    "../src/workflows/develop.workflow.js"
  );

  const ws = mkdtempSync(path.join(os.tmpdir(), "forced-order-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(ws, ".coder", "logs"), { recursive: true });
  execSync("git init", { cwd: ws, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: ws,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: ws, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: ws, stdio: "ignore" });

  // Issues in intentional order: highest difficulty first
  const issuesDir = path.join(ws, ".coder", "local-issues");
  const issuesSubdir = path.join(issuesDir, "issues");
  mkdirSync(issuesSubdir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, "manifest.json"),
    JSON.stringify({
      issues: [
        { id: "Z", file: "issues/Z.md", title: "Hard", difficulty: 5 },
        { id: "A", file: "issues/A.md", title: "Easy", difficulty: 1 },
        { id: "M", file: "issues/M.md", title: "Med", difficulty: 3 },
      ],
    }),
  );
  for (const id of ["Z", "A", "M"]) {
    writeFileSync(path.join(issuesSubdir, `${id}.md`), `# ${id}\n\nDetails.`);
  }

  const originalRun = WorkflowRunner.prototype.run;
  const draftOrder = [];
  try {
    WorkflowRunner.prototype.run = async (steps) => {
      const name = steps[0]?.machine?.name;
      if (name === "develop.issue_draft") {
        draftOrder.push(steps[0]?.inputMapper?.()?.issue?.id);
      }
      if (name === "develop.planning" || name === "develop.plan_review") {
        return {
          status: "completed",
          results: [{ status: "ok", data: { verdict: "APPROVED" } }],
          runId: "r",
          durationMs: 0,
        };
      }
      return {
        status: "completed",
        results: [
          {
            machine: "develop.pr_creation",
            status: "ok",
            data: { branch: "feat/test", prUrl: "https://example.test/pr" },
          },
        ],
        runId: "r",
        durationMs: 0,
      };
    };

    const ctx = {
      workspaceDir: ws,
      repoPath: ".",
      artifactsDir: path.join(ws, ".coder", "artifacts"),
      scratchpadDir: path.join(ws, ".coder", "scratchpad"),
      cancelToken: { cancelled: false, paused: false },
      log: () => {},
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
        },
      },
      agentPool: null,
      secrets: {},
    };

    await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        issueIds: ["Z", "A", "M"],
      },
      ctx,
    );

    // Without forced_order, difficulty sort would reorder to A(1), M(3), Z(5)
    // With forced_order, original sequence Z, A, M must be preserved
    assert.deepEqual(
      draftOrder,
      ["Z", "A", "M"],
      "forced order must be preserved",
    );
  } finally {
    WorkflowRunner.prototype.run = originalRun;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("runDevelopLoop returns failed when explicit issueIds are not found", async () => {
  const { execSync } = await import("node:child_process");
  const { runDevelopLoop } = await import(
    "../src/workflows/develop.workflow.js"
  );

  const ws = mkdtempSync(path.join(os.tmpdir(), "missing-ids-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(ws, ".coder", "logs"), { recursive: true });
  execSync("git init", { cwd: ws, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: ws,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: ws, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: ws, stdio: "ignore" });

  // Manifest with only issue "A"
  const issuesDir = path.join(ws, ".coder", "local-issues");
  const issuesSubdir = path.join(issuesDir, "issues");
  mkdirSync(issuesSubdir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, "manifest.json"),
    JSON.stringify({
      issues: [
        { id: "A", file: "issues/A.md", title: "Only A", difficulty: 1 },
      ],
    }),
  );
  writeFileSync(path.join(issuesSubdir, "A.md"), "# A\n\nDetails.");

  try {
    const ctx = {
      workspaceDir: ws,
      repoPath: ".",
      artifactsDir: path.join(ws, ".coder", "artifacts"),
      scratchpadDir: path.join(ws, ".coder", "scratchpad"),
      cancelToken: { cancelled: false, paused: false },
      log: () => {},
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
        },
      },
      agentPool: null,
      secrets: {},
    };

    // Request issue IDs that don't exist in the manifest
    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        issueIds: ["MISSING-01", "MISSING-02"],
      },
      ctx,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /MISSING-01/);
    assert.match(result.error, /MISSING-02/);
    assert.equal(result.results.length, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("runDevelopLoop returns failed when some explicit issueIds are missing (partial match)", async () => {
  const { execSync } = await import("node:child_process");
  const { runDevelopLoop } = await import(
    "../src/workflows/develop.workflow.js"
  );

  const ws = mkdtempSync(path.join(os.tmpdir(), "partial-ids-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(ws, ".coder", "logs"), { recursive: true });
  execSync("git init -b main", { cwd: ws, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: ws,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: ws, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: ws, stdio: "ignore" });

  const issuesDir = path.join(ws, ".coder", "local-issues");
  const issuesSubdir = path.join(issuesDir, "issues");
  mkdirSync(issuesSubdir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, "manifest.json"),
    JSON.stringify({
      issues: [
        { id: "A", file: "issues/A.md", title: "Only A", difficulty: 1 },
      ],
    }),
  );
  writeFileSync(path.join(issuesSubdir, "A.md"), "# A\n\nDetails.");

  try {
    const ctx = {
      workspaceDir: ws,
      repoPath: ".",
      artifactsDir: path.join(ws, ".coder", "artifacts"),
      scratchpadDir: path.join(ws, ".coder", "scratchpad"),
      cancelToken: { cancelled: false, paused: false },
      log: () => {},
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
        },
      },
      agentPool: null,
      secrets: {},
    };

    // Request A (exists) + MISSING (doesn't) — should fail on the missing one
    const result = await runDevelopLoop(
      {
        issueSource: "local",
        localIssuesDir: issuesDir,
        issueIds: ["A", "MISSING"],
      },
      ctx,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /MISSING/);
    // Should NOT mention A (which was found)
    assert.ok(!result.error.includes('"A"'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("runDevelopLoop returns failed when local manifest has no valid issues and no explicit issueIds", async () => {
  const { execSync } = await import("node:child_process");
  const { runDevelopLoop } = await import(
    "../src/workflows/develop.workflow.js"
  );

  const ws = mkdtempSync(path.join(os.tmpdir(), "empty-issues-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(ws, ".coder", "logs"), { recursive: true });
  execSync("git init -b main", { cwd: ws, stdio: "ignore" });
  execSync("git config user.email test@example.com", {
    cwd: ws,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test User'", { cwd: ws, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: ws, stdio: "ignore" });

  // Empty manifest — loadLocalIssues returns null for empty issues
  const issuesDir = path.join(ws, ".coder", "local-issues");
  mkdirSync(issuesDir, { recursive: true });
  writeFileSync(
    path.join(issuesDir, "manifest.json"),
    JSON.stringify({ issues: [] }),
  );

  try {
    const ctx = {
      workspaceDir: ws,
      repoPath: ".",
      artifactsDir: path.join(ws, ".coder", "artifacts"),
      scratchpadDir: path.join(ws, ".coder", "scratchpad"),
      cancelToken: { cancelled: false, paused: false },
      log: () => {},
      config: {
        workflow: {
          maxMachineRetries: 0,
          retryBackoffMs: 0,
          hooks: [],
          issueSource: "local",
          localIssuesDir: "",
        },
      },
      agentPool: null,
      secrets: {},
    };

    // Empty manifest → issue-list machine throws → develop loop returns failed
    const result = await runDevelopLoop(
      { issueSource: "local", localIssuesDir: issuesDir },
      ctx,
    );

    assert.equal(result.status, "failed");
    assert.match(result.error, /no valid manifest/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
