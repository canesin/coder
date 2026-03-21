import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { defineMachine } from "../src/machines/_base.js";
import { requirePayloadFields } from "../src/machines/research/_shared.js";
import specRenderMachine from "../src/machines/research/spec-render.machine.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import {
  registerSpecBuildMachines,
  runSpecBuildPipeline,
  specBuildMachines,
} from "../src/workflows/spec-build.workflow.js";

const mockIngestBuild = defineMachine({
  name: "research.spec_ingest",
  description: "Mock ingest (build)",
  inputSchema: z.object({ repoPath: z.string().default(".") }),
  async execute() {
    return {
      status: "ok",
      data: {
        runId: "test-run",
        runDir: "/tmp/run",
        stepsDir: "/tmp/run/steps",
        issuesDir: "/tmp/run/issues",
        scratchpadPath: "/tmp/run/SCRATCHPAD.md",
        pipelinePath: "/tmp/run/pipeline.json",
        repoRoot: "/tmp/repo",
        mode: "build",
        researchManifest: {
          issues: [{ id: "R-01", title: "Fix auth" }],
        },
      },
    };
  },
});

const mockIngestIngest = defineMachine({
  name: "research.spec_ingest",
  description: "Mock ingest (ingest)",
  inputSchema: z.object({ repoPath: z.string().default(".") }),
  async execute() {
    return {
      status: "ok",
      data: {
        runId: "test-run",
        runDir: "/tmp/run",
        stepsDir: "/tmp/run/steps",
        issuesDir: "/tmp/run/issues",
        scratchpadPath: "/tmp/run/SCRATCHPAD.md",
        pipelinePath: "/tmp/run/pipeline.json",
        repoRoot: "/tmp/repo",
        mode: "ingest",
        parsedDomains: [{ name: "auth", version: "1" }],
        parsedDecisions: [{ id: "ADR-001", status: "accepted" }],
        parsedGaps: [
          {
            description: "Needs work",
            domain: "AUTH",
            severity: "blocker",
            status: "open",
          },
        ],
      },
    };
  },
});

const mockArchitectBuild = defineMachine({
  name: "research.spec_architect",
  description: "Mock architect (build)",
  inputSchema: z.object({ mode: z.string(), runDir: z.string() }),
  async execute() {
    return {
      status: "ok",
      data: {
        mode: "build",
        domains: [{ name: "core", description: "Core domain" }],
        decisions: [
          {
            id: "ADR-001",
            title: "Use X",
            status: "accepted",
            rationale: "...",
          },
        ],
        phases: [{ id: "phase-1", title: "Foundation", issueSpecs: [] }],
        issueSpecs: [
          {
            title: "Implement auth",
            objective: "Add auth",
            priority: "P1",
          },
        ],
      },
    };
  },
});

const mockArchitectIngest = defineMachine({
  name: "research.spec_architect",
  description: "Mock architect (ingest)",
  inputSchema: z.object({ mode: z.string(), runDir: z.string() }),
  async execute() {
    return {
      status: "ok",
      data: {
        mode: "ingest",
        phases: [{ id: "phase-1", title: "Fix gaps" }],
        issueSpecs: [
          {
            title: "Fix auth gap",
            objective: "Address auth blocker",
            priority: "P1",
            domain: "AUTH",
          },
        ],
        parsedDomains: [{ name: "auth" }],
        parsedDecisions: [{ id: "ADR-001", status: "accepted" }],
      },
    };
  },
});

const mockIngestUpdate = defineMachine({
  name: "research.spec_ingest",
  description: "Mock ingest (update)",
  inputSchema: z.object({ repoPath: z.string().default(".") }),
  async execute() {
    return {
      status: "ok",
      data: {
        runId: "test-run",
        runDir: "/tmp/run",
        stepsDir: "/tmp/run/steps",
        issuesDir: "/tmp/run/issues",
        scratchpadPath: "/tmp/run/SCRATCHPAD.md",
        pipelinePath: "/tmp/run/pipeline.json",
        repoRoot: "/tmp/repo",
        repoPath: ".",
        mode: "update",
        updateDocContent:
          "# Feature X\n\nAdd ownership transfer to the cluster.",
        specFiles: [
          { name: "01-OVERVIEW.md", content: "# Overview\n\nExisting spec." },
          {
            name: "05-HASHING.md",
            content: "# Hashing\n\nConsistent hashing.",
          },
        ],
      },
    };
  },
});

const mockArchitectUpdate = defineMachine({
  name: "research.spec_architect",
  description: "Mock architect (update)",
  inputSchema: z.object({ mode: z.string(), runDir: z.string() }),
  async execute() {
    return {
      status: "ok",
      data: {
        mode: "update",
        phases: [
          {
            id: "phase-1",
            title: "Core implementation",
            issueSpecs: [{ title: "Implement transfer protocol" }],
          },
        ],
        issueSpecs: [
          {
            title: "Implement transfer protocol",
            objective: "Add follow-the-workload ownership transfer",
            priority: "P0",
            domain: "ownership",
            tags: ["code"],
            changes: ["src/transfer.go"],
          },
          {
            title: "Add transfer tests",
            objective: "Integration tests for ownership handoff",
            priority: "P1",
            domain: "ownership",
            tags: ["test"],
            depends_on: ["Implement transfer protocol"],
          },
          {
            title: "Update spec: 05-HASHING.md ownership section",
            objective: "Add ownership transfer to hashing spec",
            priority: "P1",
            domain: "spec",
            tags: ["spec-update"],
            changes: ["05-HASHING.md: add ## Ownership Transfer section"],
          },
        ],
      },
    };
  },
});

const mockRender = defineMachine({
  name: "research.spec_render",
  description: "Mock render",
  inputSchema: z.object({
    mode: z.string(),
    issueSpecs: z.array(z.any()),
  }),
  async execute(input) {
    return {
      status: "ok",
      data: {
        mode: input.mode,
        issueCount: input.issueSpecs.length,
        wroteSpecDocs: input.mode === "build",
      },
    };
  },
});

function makeCtx() {
  return {
    workspaceDir: "/tmp/test",
    repoPath: ".",
    config: {},
    agentPool: null,
    log: () => {},
    cancelToken: { cancelled: false, paused: false },
    secrets: {},
    artifactsDir: "/tmp/test/.coder/artifacts",
    scratchpadDir: "/tmp/test/.coder/scratchpad",
  };
}

test("spec-build pipeline cascades data in build mode", async () => {
  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestBuild, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: mockArchitectBuild,
      inputMapper: (prev) => ({
        mode: prev.data.mode,
        runDir: prev.data.runDir,
      }),
    },
    {
      machine: mockRender,
      inputMapper: (prev, state) => ({
        mode: state.results[0]?.data?.mode,
        issueSpecs: prev.data.issueSpecs || [],
      }),
    },
  ]);

  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].data.mode, "build");
  assert.equal(result.results[1].data.issueSpecs.length, 1);
  assert.equal(result.results[2].data.wroteSpecDocs, true);
  assert.equal(result.results[2].data.issueCount, 1);
});

test("spec-build pipeline cascades data in ingest mode", async () => {
  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestIngest, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: mockArchitectIngest,
      inputMapper: (prev) => ({
        mode: prev.data.mode,
        runDir: prev.data.runDir,
      }),
    },
    {
      machine: mockRender,
      inputMapper: (prev, state) => ({
        mode: state.results[0]?.data?.mode,
        issueSpecs: prev.data.issueSpecs || [],
      }),
    },
  ]);

  assert.equal(result.status, "completed");
  assert.equal(result.results[0].data.mode, "ingest");
  assert.equal(result.results[0].data.parsedGaps.length, 1);
  assert.equal(result.results[2].data.wroteSpecDocs, false);
  assert.equal(result.results[2].data.issueCount, 1);
});

test("spec-build pipeline cascades data in update mode", async () => {
  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestUpdate, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: mockArchitectUpdate,
      inputMapper: (prev) => ({
        mode: prev.data.mode,
        runDir: prev.data.runDir,
      }),
    },
    {
      machine: mockRender,
      inputMapper: (prev, state) => ({
        mode: state.results[0]?.data?.mode,
        issueSpecs: prev.data.issueSpecs || [],
      }),
    },
  ]);

  assert.equal(result.status, "completed");
  assert.equal(result.results[0].data.mode, "update");
  assert.equal(result.results[0].data.specFiles.length, 2);
  assert.ok(result.results[0].data.updateDocContent.length > 0);
  assert.equal(result.results[1].data.issueSpecs.length, 3);
  assert.equal(result.results[2].data.wroteSpecDocs, false);
  assert.equal(result.results[2].data.issueCount, 3);
});

test("spec-build pipeline fails on non-optional step error", async () => {
  const failArchitect = defineMachine({
    name: "research.spec_architect",
    description: "Failing architect",
    inputSchema: z.object({ mode: z.string() }),
    async execute() {
      throw new Error("architect failed");
    },
  });

  const runner = new WorkflowRunner({
    name: "spec-build",
    workflowContext: makeCtx(),
  });
  const result = await runner.run([
    { machine: mockIngestBuild, inputMapper: () => ({ repoPath: "." }) },
    {
      machine: failArchitect,
      inputMapper: (prev) => ({ mode: prev.data.mode }),
    },
    {
      machine: mockRender,
      inputMapper: () => ({ mode: "build", issueSpecs: [] }),
    },
  ]);

  assert.equal(result.status, "failed");
  assert.match(result.error, /architect failed/);
});

// --- requirePayloadFields ---

test("requirePayloadFields throws on missing fields", () => {
  assert.throws(
    () => requirePayloadFields({ a: 1 }, { a: "number", b: "string" }, "test"),
    /test payload contract violation/,
  );
});

test("requirePayloadFields passes when all fields present", () => {
  assert.doesNotThrow(() =>
    requirePayloadFields({ a: 1, b: "hi" }, { a: "number", b: "string" }),
  );
});

// --- spec-build workflow exports ---

test("specBuildMachines is an array of 3 machines", () => {
  assert.equal(Array.isArray(specBuildMachines), true);
  assert.equal(specBuildMachines.length, 3);
});

test("registerSpecBuildMachines is a function", () => {
  assert.equal(typeof registerSpecBuildMachines, "function");
});

test("runSpecBuildPipeline is a function", () => {
  assert.equal(typeof runSpecBuildPipeline, "function");
});

// --- Real spec_render machine tests ---

function makeTempDirs() {
  const base = path.join(
    tmpdir(),
    `spec-render-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const runDir = path.join(base, "run");
  const issuesDir = path.join(runDir, "issues");
  const stepsDir = path.join(runDir, "steps");
  const workspace = path.join(base, "workspace");
  mkdirSync(issuesDir, { recursive: true });
  mkdirSync(stepsDir, { recursive: true });
  mkdirSync(path.join(workspace, ".coder"), { recursive: true });

  // Write minimal pipeline.json and SCRATCHPAD.md
  writeFileSync(path.join(runDir, "pipeline.json"), "null", "utf8");
  writeFileSync(path.join(runDir, "SCRATCHPAD.md"), "# Scratch\n", "utf8");

  return {
    base,
    runDir,
    issuesDir,
    stepsDir,
    workspace,
    scratchpadPath: path.join(runDir, "SCRATCHPAD.md"),
    pipelinePath: path.join(runDir, "pipeline.json"),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test("spec_render build mode: emits spec files, bridge manifest with filePath, and phase issueIds", async () => {
  const dirs = makeTempDirs();
  try {
    const result = await specRenderMachine.run(
      {
        runDir: dirs.runDir,
        stepsDir: dirs.stepsDir,
        issuesDir: dirs.issuesDir,
        scratchpadPath: dirs.scratchpadPath,
        pipelinePath: dirs.pipelinePath,
        repoRoot: dirs.workspace,
        repoPath: ".",
        mode: "build",
        domains: [
          {
            name: "auth",
            description: "Authentication domain",
            gaps: ["No MFA support"],
          },
        ],
        decisions: [
          {
            id: "ADR-001",
            title: "Use JWT",
            status: "accepted",
            rationale: "Stateless auth",
          },
        ],
        phases: [
          {
            id: "phase-1",
            title: "Foundation",
            issueSpecs: [{ title: "Add JWT support" }],
          },
        ],
        issueSpecs: [
          {
            title: "Add JWT support",
            objective: "Implement JWT auth",
            priority: "P1",
          },
          { title: "Add MFA", objective: "Multi-factor", priority: "P2" },
        ],
        parsedDomains: [],
        parsedDecisions: [],
      },
      {
        workspaceDir: dirs.workspace,
        log: () => {},
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.data.issueCount, 2);

    // Spec files exist
    const specDir = path.join(dirs.runDir, "spec");
    assert.ok(existsSync(path.join(specDir, "01-OVERVIEW.md")));
    assert.ok(existsSync(path.join(specDir, "02-ARCHITECTURE.md")));
    assert.ok(existsSync(path.join(specDir, "03-AUTH.md")));
    assert.ok(
      existsSync(path.join(specDir, "decisions", "ADR-001-use-jwt.md")),
    );
    assert.ok(
      existsSync(path.join(specDir, "phases", "PHASE-01-foundation.md")),
    );

    // Overview includes domain and decision content (not boilerplate)
    const overview = readFileSync(path.join(specDir, "01-OVERVIEW.md"), "utf8");
    assert.ok(overview.includes("auth"), "overview should mention domain name");
    assert.ok(overview.includes("Use JWT"), "overview should mention decision");

    // Architecture includes gaps
    const arch = readFileSync(path.join(specDir, "02-ARCHITECTURE.md"), "utf8");
    assert.ok(
      arch.includes("No MFA support"),
      "architecture should include domain gaps",
    );

    // Domain doc includes gaps
    const domainDoc = readFileSync(path.join(specDir, "03-AUTH.md"), "utf8");
    assert.ok(
      domainDoc.includes("No MFA support"),
      "domain doc should include gaps",
    );

    // Spec manifest has issueManifestPath and correct phase issueIds
    const specManifest = JSON.parse(
      readFileSync(path.join(specDir, "manifest.json"), "utf8"),
    );
    assert.ok(
      specManifest.issueManifestPath,
      "spec manifest should have issueManifestPath",
    );
    assert.equal(specManifest.phases[0].issueIds.length, 1);
    assert.equal(specManifest.phases[0].issueIds[0], "SPEC-01");

    // Bridge manifest: uses workspace-relative `filePath` pointing at generated issues/
    const bridgeDir = path.join(dirs.workspace, ".coder", "local-issues");
    const bridgeManifest = JSON.parse(
      readFileSync(path.join(bridgeDir, "manifest.json"), "utf8"),
    );
    assert.equal(bridgeManifest.issues.length, 2);
    for (const issue of bridgeManifest.issues) {
      assert.ok(issue.filePath, "bridge issue should have filePath field");
      assert.ok(!issue.file, "bridge issue should not have file field");
      const mdPath = path.resolve(dirs.workspace, issue.filePath);
      assert.ok(existsSync(mdPath), `issue file should exist at ${mdPath}`);
      assert.ok(
        mdPath.startsWith(dirs.issuesDir),
        "filePath should point into the generated issues/ dir",
      );
    }
    assert.equal(bridgeManifest.issues[0].id, "SPEC-01");
    assert.equal(bridgeManifest.repoPath, ".");
  } finally {
    dirs.cleanup();
  }
});

test("spec_render ingest mode: writes bridge manifest without spec dir", async () => {
  const dirs = makeTempDirs();
  try {
    const result = await specRenderMachine.run(
      {
        runDir: dirs.runDir,
        stepsDir: dirs.stepsDir,
        issuesDir: dirs.issuesDir,
        scratchpadPath: dirs.scratchpadPath,
        pipelinePath: dirs.pipelinePath,
        repoRoot: dirs.workspace,
        repoPath: ".",
        mode: "ingest",
        domains: [],
        decisions: [],
        phases: [],
        issueSpecs: [
          { title: "Fix gap", objective: "Address blocker", priority: "P1" },
        ],
        parsedDomains: [],
        parsedDecisions: [],
      },
      {
        workspaceDir: dirs.workspace,
        log: () => {},
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.data.specDir, null);
    assert.equal(result.data.issueCount, 1);

    // No spec dir created
    assert.ok(!existsSync(path.join(dirs.runDir, "spec")));

    // Bridge manifest exists and uses filePath
    const bridgeDir = path.join(dirs.workspace, ".coder", "local-issues");
    const bridgeManifest = JSON.parse(
      readFileSync(path.join(bridgeDir, "manifest.json"), "utf8"),
    );
    assert.equal(bridgeManifest.issues.length, 1);
    assert.ok(bridgeManifest.issues[0].filePath);
    assert.ok(
      existsSync(
        path.resolve(dirs.workspace, bridgeManifest.issues[0].filePath),
      ),
    );
  } finally {
    dirs.cleanup();
  }
});

test("spec_render build mode: duplicate-title issueSpecs get distinct phase issueIds via all-field match", async () => {
  const dirs = makeTempDirs();
  try {
    // Flat order: [First, Second] — phases reference by distinct objective field
    const result = await specRenderMachine.run(
      {
        runDir: dirs.runDir,
        stepsDir: dirs.stepsDir,
        issuesDir: dirs.issuesDir,
        scratchpadPath: dirs.scratchpadPath,
        pipelinePath: dirs.pipelinePath,
        repoRoot: dirs.workspace,
        repoPath: ".",
        mode: "build",
        domains: [],
        decisions: [],
        phases: [
          {
            id: "phase-1",
            title: "Phase A",
            issueSpecs: [
              { title: "Same title", objective: "Second", priority: "P2" },
            ],
          },
          {
            id: "phase-2",
            title: "Phase B",
            issueSpecs: [
              { title: "Same title", objective: "First", priority: "P1" },
            ],
          },
        ],
        issueSpecs: [
          { title: "Same title", objective: "First", priority: "P1" },
          { title: "Same title", objective: "Second", priority: "P2" },
        ],
        parsedDomains: [],
        parsedDecisions: [],
      },
      {
        workspaceDir: dirs.workspace,
        log: () => {},
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.data.issueCount, 2);

    const specManifest = JSON.parse(
      readFileSync(path.join(dirs.runDir, "spec", "manifest.json"), "utf8"),
    );

    // Phase A references Second (flat[1] = SPEC-02)
    // Phase B references First  (flat[0] = SPEC-01)
    assert.equal(specManifest.phases[0].issueIds.length, 1);
    assert.equal(specManifest.phases[1].issueIds.length, 1);
    assert.equal(specManifest.phases[0].issueIds[0], "SPEC-02");
    assert.equal(specManifest.phases[1].issueIds[0], "SPEC-01");
  } finally {
    dirs.cleanup();
  }
});

test("spec_render build mode: phase entries with _issueId bypass matching", async () => {
  const dirs = makeTempDirs();
  try {
    const result = await specRenderMachine.run(
      {
        runDir: dirs.runDir,
        stepsDir: dirs.stepsDir,
        issuesDir: dirs.issuesDir,
        scratchpadPath: dirs.scratchpadPath,
        pipelinePath: dirs.pipelinePath,
        repoRoot: dirs.workspace,
        repoPath: ".",
        mode: "build",
        domains: [],
        decisions: [],
        phases: [
          {
            id: "phase-1",
            title: "Phase A",
            issueSpecs: [{ title: "Same title", _issueId: "SPEC-02" }],
          },
          {
            id: "phase-2",
            title: "Phase B",
            issueSpecs: [{ title: "Same title", _issueId: "SPEC-01" }],
          },
        ],
        issueSpecs: [
          { title: "Same title", objective: "First", priority: "P1" },
          { title: "Same title", objective: "Second", priority: "P2" },
        ],
        parsedDomains: [],
        parsedDecisions: [],
      },
      {
        workspaceDir: dirs.workspace,
        log: () => {},
      },
    );

    assert.equal(result.status, "ok");

    const specManifest = JSON.parse(
      readFileSync(path.join(dirs.runDir, "spec", "manifest.json"), "utf8"),
    );

    // Pre-assigned _issueId is used directly — no title matching needed
    assert.equal(specManifest.phases[0].issueIds[0], "SPEC-02");
    assert.equal(specManifest.phases[1].issueIds[0], "SPEC-01");
  } finally {
    dirs.cleanup();
  }
});

test("spec_render update mode: writes bridge manifest without spec dir", async () => {
  const dirs = makeTempDirs();
  try {
    const result = await specRenderMachine.run(
      {
        runDir: dirs.runDir,
        stepsDir: dirs.stepsDir,
        issuesDir: dirs.issuesDir,
        scratchpadPath: dirs.scratchpadPath,
        pipelinePath: dirs.pipelinePath,
        repoRoot: dirs.workspace,
        repoPath: ".",
        mode: "update",
        domains: [],
        decisions: [],
        phases: [
          {
            id: "phase-1",
            title: "Core",
            issueSpecs: [{ title: "Implement transfer" }],
          },
        ],
        issueSpecs: [
          {
            title: "Implement transfer",
            objective: "Add ownership transfer",
            priority: "P0",
            tags: ["code"],
          },
          {
            title: "Update spec overview",
            objective: "Add transfer section to overview",
            priority: "P1",
            tags: ["spec-update"],
          },
        ],
        parsedDomains: [],
        parsedDecisions: [],
      },
      {
        workspaceDir: dirs.workspace,
        log: () => {},
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.data.specDir, null);
    assert.equal(result.data.issueCount, 2);

    // No spec dir created
    assert.ok(!existsSync(path.join(dirs.runDir, "spec")));

    // Bridge manifest exists
    const bridgeDir = path.join(dirs.workspace, ".coder", "local-issues");
    const bridgeManifest = JSON.parse(
      readFileSync(path.join(bridgeDir, "manifest.json"), "utf8"),
    );
    assert.equal(bridgeManifest.issues.length, 2);
    assert.ok(bridgeManifest.issues[0].filePath);
    assert.ok(
      existsSync(
        path.resolve(dirs.workspace, bridgeManifest.issues[0].filePath),
      ),
    );
  } finally {
    dirs.cleanup();
  }
});

test("spec_ingest update mode: reads update doc and spec files as raw text", async () => {
  const base = path.join(
    tmpdir(),
    `spec-ingest-update-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const workspace = path.join(base, "workspace");
  const specDir = path.join(workspace, "spec");
  const scratchpadDir = path.join(workspace, ".coder", "scratchpad");
  mkdirSync(specDir, { recursive: true });
  mkdirSync(scratchpadDir, { recursive: true });

  writeFileSync(
    path.join(specDir, "01-OVERVIEW.md"),
    "# Overview\n\nExisting spec.",
    "utf8",
  );
  writeFileSync(
    path.join(specDir, "05-HASHING.md"),
    "# Hashing\n\nConsistent hashing.",
    "utf8",
  );
  writeFileSync(
    path.join(workspace, "SPEC_UPDATE.md"),
    "# Update\n\nAdd ownership transfer.",
    "utf8",
  );

  try {
    const specIngestMachine = (
      await import("../src/machines/research/spec-ingest.machine.js")
    ).default;
    const result = await specIngestMachine.run(
      {
        repoPath: ".",
        existingSpecDir: "spec",
        updateDoc: "SPEC_UPDATE.md",
      },
      {
        workspaceDir: workspace,
        scratchpadDir,
        log: () => {},
      },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.data.mode, "update");
    assert.equal(result.data.specFiles.length, 2);
    assert.equal(result.data.specFiles[0].name, "01-OVERVIEW.md");
    assert.equal(result.data.specFiles[1].name, "05-HASHING.md");
    assert.ok(result.data.updateDocContent.includes("ownership transfer"));
    // Should NOT have ingest-mode parsed fields
    assert.equal(result.data.parsedDomains, undefined);
    assert.equal(result.data.parsedGaps, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
