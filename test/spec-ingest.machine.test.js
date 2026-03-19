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
import specIngestMachine from "../src/machines/research/spec-ingest.machine.js";

function makeTempEnv() {
  const base = path.join(
    tmpdir(),
    `spec-ingest-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const workspaceDir = path.join(base, "workspace");
  const scratchpadDir = path.join(base, "scratchpad");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(scratchpadDir, { recursive: true });
  return {
    base,
    workspaceDir,
    scratchpadDir,
    ctx: { workspaceDir, scratchpadDir },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test("spec_ingest errors when neither existingSpecDir nor researchRunId provided", async () => {
  const env = makeTempEnv();
  try {
    const result = await specIngestMachine.run({ repoPath: "." }, env.ctx);
    assert.equal(result.status, "error");
    assert.match(
      result.error,
      /requires either existingSpecDir or researchRunId/,
    );
  } finally {
    env.cleanup();
  }
});

test("spec_ingest errors when repoPath does not exist", async () => {
  const env = makeTempEnv();
  try {
    const result = await specIngestMachine.run(
      { repoPath: "nonexistent-repo-dir", researchRunId: "x" },
      env.ctx,
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /does not exist/);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest errors when existingSpecDir does not exist", async () => {
  const env = makeTempEnv();
  try {
    const result = await specIngestMachine.run(
      { existingSpecDir: "nonexistent-spec-dir" },
      env.ctx,
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /does not exist/);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest errors when researchRunId directory does not exist", async () => {
  const env = makeTempEnv();
  try {
    const result = await specIngestMachine.run(
      { researchRunId: "nonexistent-run-id" },
      env.ctx,
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /Research manifest not found/);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest errors when researchRunId manifest is missing", async () => {
  const env = makeTempEnv();
  try {
    const runId = "orphan-run";
    mkdirSync(path.join(env.scratchpadDir, runId), { recursive: true });
    const result = await specIngestMachine.run(
      { researchRunId: runId },
      env.ctx,
    );
    assert.equal(result.status, "error");
    assert.match(result.error, /Research manifest not found/);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest build mode reads research manifest", async () => {
  const env = makeTempEnv();
  try {
    const runId = "test-research-run";
    const runDir = path.join(env.scratchpadDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ issues: [{ id: "R-01", title: "Fix auth" }] }),
    );
    const result = await specIngestMachine.run(
      { researchRunId: runId },
      env.ctx,
    );
    assert.equal(result.status, "ok");
    assert.equal(result.data.mode, "build");
    assert.equal(result.data.researchManifest.issues.length, 1);
    assert.equal(result.data.researchManifest.issues[0].id, "R-01");
    assert.ok(result.data.runId);
    assert.ok(result.data.runDir);
    assert.ok(result.data.stepsDir);
    assert.ok(result.data.issuesDir);
    assert.ok(result.data.scratchpadPath);
    assert.ok(result.data.pipelinePath);
    assert.ok(result.data.repoRoot);

    // Verify pipeline.json tracking (Finding 2)
    assert.ok(existsSync(result.data.pipelinePath), "pipeline.json must exist");
    const pipeline = JSON.parse(readFileSync(result.data.pipelinePath, "utf8"));
    assert.equal(pipeline.steps.spec_ingest.status, "completed");
    assert.equal(pipeline.steps.spec_ingest.mode, "build");
    assert.ok(pipeline.steps.spec_ingest.startedAt);
    assert.ok(pipeline.steps.spec_ingest.endedAt);
    assert.ok(
      pipeline.history.some(
        (h) => h.event === "step_start" && h.step === "spec_ingest",
      ),
      "pipeline history must contain step_start for spec_ingest",
    );
    assert.ok(
      pipeline.history.some(
        (h) =>
          h.event === "step_end" &&
          h.step === "spec_ingest" &&
          h.status === "completed",
      ),
      "pipeline history must contain step_end with completed status",
    );

    // Verify SCRATCHPAD.md tracking
    assert.ok(
      existsSync(result.data.scratchpadPath),
      "SCRATCHPAD.md must exist",
    );
    const scratchpad = readFileSync(result.data.scratchpadPath, "utf8");
    assert.match(scratchpad, /Spec Ingest \(build mode\)/);
    assert.match(scratchpad, /researchRunId: test-research-run/);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest ingest mode parses spec directory with domains, decisions, and gaps", async () => {
  const env = makeTempEnv();
  try {
    const specDir = path.join(env.workspaceDir, "test-spec");
    const decisionsDir = path.join(specDir, "decisions");
    mkdirSync(decisionsDir, { recursive: true });

    writeFileSync(
      path.join(specDir, "03-AUTH.md"),
      [
        "<!-- spec-meta",
        "version: 1",
        "domain: auth",
        "-->",
        "",
        "# Auth Domain",
        "",
        "- [ ] **1. Missing MFA** — Needs work. Domain: AUTH. Severity: blocker.",
      ].join("\n"),
    );

    writeFileSync(
      path.join(decisionsDir, "ADR-001-use-jwt.md"),
      ["<!-- adr-meta", "status: accepted", "-->", "", "# Use JWT"].join("\n"),
    );

    const result = await specIngestMachine.run(
      { existingSpecDir: "test-spec" },
      env.ctx,
    );
    assert.equal(result.status, "ok");
    assert.equal(result.data.mode, "ingest");
    assert.equal(result.data.parsedDomains.length, 1);
    assert.equal(result.data.parsedDomains[0].name, "auth");
    assert.equal(result.data.parsedDecisions.length, 1);
    assert.equal(result.data.parsedDecisions[0].status, "accepted");
    assert.equal(result.data.parsedGaps.length, 1);
    assert.equal(result.data.parsedGaps[0].domain, "AUTH");

    // Verify pipeline.json tracking (Finding 2)
    assert.ok(existsSync(result.data.pipelinePath), "pipeline.json must exist");
    const pipeline = JSON.parse(readFileSync(result.data.pipelinePath, "utf8"));
    assert.equal(pipeline.steps.spec_ingest.status, "completed");
    assert.equal(pipeline.steps.spec_ingest.mode, "ingest");
    assert.equal(pipeline.steps.spec_ingest.domains, 1);
    assert.equal(pipeline.steps.spec_ingest.gaps, 1);
    assert.ok(
      pipeline.history.some(
        (h) => h.event === "step_start" && h.step === "spec_ingest",
      ),
      "pipeline history must contain step_start for spec_ingest",
    );
    assert.ok(
      pipeline.history.some(
        (h) =>
          h.event === "step_end" &&
          h.step === "spec_ingest" &&
          h.status === "completed",
      ),
      "pipeline history must contain step_end with completed status",
    );

    // Verify SCRATCHPAD.md tracking
    assert.ok(
      existsSync(result.data.scratchpadPath),
      "SCRATCHPAD.md must exist",
    );
    const scratchpad = readFileSync(result.data.scratchpadPath, "utf8");
    assert.match(scratchpad, /Spec Ingest \(ingest mode\)/);
    assert.match(scratchpad, /domains: 1/);
    assert.match(scratchpad, /decisions: 1/);
    assert.match(scratchpad, /gaps: 1/);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest ingest mode works without decisions directory", async () => {
  const env = makeTempEnv();
  try {
    const specDir = path.join(env.workspaceDir, "spec-no-decisions");
    mkdirSync(specDir, { recursive: true });

    writeFileSync(
      path.join(specDir, "03-CORE.md"),
      ["<!-- spec-meta", "version: 1", "domain: core", "-->"].join("\n"),
    );

    const result = await specIngestMachine.run(
      { existingSpecDir: "spec-no-decisions" },
      env.ctx,
    );
    assert.equal(result.status, "ok");
    assert.deepStrictEqual(result.data.parsedDecisions, []);
    assert.ok(result.data.parsedDomains.length >= 1);
  } finally {
    env.cleanup();
  }
});

test("spec_ingest ingest mode ignores non-.md files", async () => {
  const env = makeTempEnv();
  try {
    const specDir = path.join(env.workspaceDir, "spec-mixed");
    mkdirSync(specDir, { recursive: true });

    writeFileSync(
      path.join(specDir, "03-API.md"),
      ["<!-- spec-meta", "version: 1", "domain: api", "-->"].join("\n"),
    );
    writeFileSync(path.join(specDir, "README.txt"), "Not a spec file");
    writeFileSync(path.join(specDir, "image.png"), "fake png data");

    const result = await specIngestMachine.run(
      { existingSpecDir: "spec-mixed" },
      env.ctx,
    );
    assert.equal(result.status, "ok");
    assert.equal(result.data.parsedDomains.length, 1);
    assert.equal(result.data.parsedDomains[0].name, "api");
  } finally {
    env.cleanup();
  }
});
