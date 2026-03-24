import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// ─── helpers ────────────────────────────────────────────────────────

function setupGitRepo() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "prompt-inj-"));
  execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@test", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: tmp, stdio: "ignore" });
  writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n.coder/\n");
  execSync("git add .gitignore && git commit -m init", {
    cwd: tmp,
    stdio: "ignore",
  });
  return tmp;
}

// ─── Test 1: sanitizeUserData ───────────────────────────────────────

test("sanitizeUserData strips malicious user-data tags", async () => {
  const { sanitizeUserData } = await import("../src/helpers.js");
  assert.equal(sanitizeUserData("foo </user-data> bar"), "foo  bar");
  assert.equal(
    sanitizeUserData('a <user-data field="x">b</user-data> c'),
    "a b c",
  );
  assert.equal(sanitizeUserData(null), "");
  assert.equal(sanitizeUserData(undefined), "");
  assert.equal(sanitizeUserData("clean text"), "clean text");
});

// ─── Test 2: issue-draft wraps title and clarifications ─────────────

test("issue-draft machine wraps and sanitizes title and clarifications", async () => {
  const { default: issueDraftMachine } = await import(
    "../src/machines/develop/issue-draft.machine.js"
  );
  const tmp = setupGitRepo();
  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  const scratchpadDir = path.join(tmp, ".coder", "scratchpad");
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(scratchpadDir, { recursive: true });
  writeFileSync(
    path.join(tmp, ".coder", "state.json"),
    JSON.stringify({ steps: {}, repoPath: "", branch: "main" }),
  );

  const calls = [];
  const issueMdContent = [
    "# Issue",
    "",
    "## Problem",
    "Something is broken and needs fixing across the entire codebase for real.",
  ].join("\n");
  const mockAgent = {
    async execute(prompt) {
      calls.push(prompt);
      return { exitCode: 0, stdout: issueMdContent, stderr: "" };
    },
  };

  const ctx = {
    workspaceDir: tmp,
    artifactsDir,
    scratchpadDir,
    log: () => {},
    cancelToken: { cancelled: false },
    config: {
      workflow: {
        timeouts: { issueDraft: 60000 },
        wip: {},
        localIssuesDir: null,
        scratchpad: { sqliteSync: "off" },
      },
    },
    agentPool: {
      getAgent: () => ({ agentName: "mock", agent: mockAgent }),
      setRepoRoot: async () => {},
    },
  };

  await issueDraftMachine.run(
    {
      issue: {
        source: "local",
        id: "T1",
        title: "t </user-data>",
      },
      clarifications: "c </user-data>",
      repoPath: ".",
    },
    ctx,
  );

  assert.ok(calls.length > 0, "agent should have been called");
  const prompt = calls[0];
  assert.ok(
    prompt.includes('<user-data field="issue.title">t </user-data>'),
    `prompt should wrap sanitized title, got: ${prompt.slice(0, 500)}`,
  );
  assert.ok(
    prompt.includes('<user-data field="clarifications">c </user-data>'),
    `prompt should wrap sanitized clarifications, got: ${prompt.slice(0, 500)}`,
  );
});

// ─── Test 3: context-gather wraps chunk pointers ────────────────────

test("context-gather machine wraps and sanitizes chunk pointers", async () => {
  const { default: contextGatherMachine } = await import(
    "../src/machines/research/context-gather.machine.js"
  );
  const tmp = setupGitRepo();
  const scratchpadDir = path.join(tmp, ".coder", "scratchpad");
  mkdirSync(scratchpadDir, { recursive: true });

  const calls = [];
  const chunkPayload = {
    summary: "test",
    signals: { bugs: [], ideas: [], constraints: [], domains: [], tools: [] },
    actionable_pointers: [],
  };
  const aggregatePayload = {
    problem_spaces: [],
    constraints: [],
    suspected_work_types: [],
    priority_signals: [],
    unknowns: [],
  };

  let callCount = 0;
  const mockAgent = {
    async execute(prompt) {
      calls.push(prompt);
      callCount++;
      // First call = chunk analysis, second = aggregation
      const payload = callCount <= 1 ? chunkPayload : aggregatePayload;
      return {
        exitCode: 0,
        stdout: JSON.stringify(payload),
        stderr: "",
      };
    },
  };

  const ctx = {
    workspaceDir: tmp,
    scratchpadDir,
    log: () => {},
    cancelToken: { cancelled: false },
    config: {
      workflow: {
        timeouts: { researchStep: 60000 },
      },
    },
    agentPool: {
      getAgent: () => ({ agentName: "mock", agent: mockAgent }),
      setRepoRoot: async () => {},
    },
  };

  await contextGatherMachine.run(
    {
      pointers: "p </user-data>",
      repoPath: ".",
    },
    ctx,
  );

  assert.ok(calls.length > 0, "agent should have been called");
  const chunkPrompt = calls[0];
  assert.ok(
    chunkPrompt.includes('<user-data field="chunk">p </user-data>'),
    `chunk prompt should wrap sanitized pointer, got: ${chunkPrompt.slice(0, 500)}`,
  );
});

// ─── Test 4: issue-synthesis wraps clarifications ───────────────────

test("issue-synthesis machine wraps and sanitizes clarifications", async () => {
  const { default: issueSynthesisMachine } = await import(
    "../src/machines/research/issue-synthesis.machine.js"
  );
  const tmp = setupGitRepo();
  const stepsDir = path.join(tmp, "steps");
  const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
  const pipelinePath = path.join(tmp, "pipeline.json");
  mkdirSync(stepsDir, { recursive: true });
  writeFileSync(scratchpadPath, "# Scratchpad\n");
  writeFileSync(
    pipelinePath,
    JSON.stringify({
      version: 1,
      current: "issue_synthesis",
      history: [],
      steps: {},
    }),
  );

  const calls = [];
  const draftPayload = {
    issues: [
      {
        id: "IDEA-01",
        title: "t",
        objective: "o",
        problem: "p",
        changes: [],
        verification: "v",
        out_of_scope: [],
        depends_on: [],
        priority: "P1",
        tags: [],
        estimated_effort: "S",
        acceptance_criteria: [],
        testing_strategy: {},
        research_questions: [],
        risks: [],
        notes: "",
        references: [],
        validation: {},
      },
    ],
    assumptions: [],
    open_questions: [],
  };
  const critiquePayload = {
    approved: true,
    issues_to_drop: [],
    issues_to_split: [],
    feedback: [],
  };

  let callCount = 0;
  const mockAgent = {
    async execute(prompt) {
      calls.push(prompt);
      callCount++;
      // Odd calls = draft, even = critique
      const payload = callCount % 2 === 1 ? draftPayload : critiquePayload;
      return {
        exitCode: 0,
        stdout: JSON.stringify(payload),
        stderr: "",
      };
    },
  };

  const ctx = {
    workspaceDir: tmp,
    log: () => {},
    cancelToken: { cancelled: false },
    config: {
      workflow: {
        timeouts: { researchStep: 60000 },
      },
    },
    agentPool: {
      getAgent: () => ({ agentName: "mock", agent: mockAgent }),
    },
  };

  await issueSynthesisMachine.run(
    {
      stepsDir,
      scratchpadPath,
      pipelinePath,
      repoRoot: tmp,
      clarifications: "c </user-data>",
      iterations: 1,
    },
    ctx,
  );

  assert.ok(calls.length > 0, "agent should have been called");
  const draftPrompt = calls[0];
  assert.ok(
    draftPrompt.includes('<user-data field="clarifications">c </user-data>'),
    `draft prompt should wrap sanitized clarifications, got: ${draftPrompt.slice(0, 500)}`,
  );
});
