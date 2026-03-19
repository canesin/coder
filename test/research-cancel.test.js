import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CancelledError, checkCancel } from "../src/machines/_base.js";

describe("checkCancel", () => {
  it("does nothing when not cancelled", () => {
    const ctx = { cancelToken: { cancelled: false, paused: false } };
    assert.doesNotThrow(() => checkCancel(ctx));
  });

  it("throws CancelledError when cancelled", () => {
    const ctx = { cancelToken: { cancelled: true, paused: false } };
    assert.throws(
      () => checkCancel(ctx),
      (err) => err instanceof CancelledError,
    );
  });
});

describe("research cancel in issue-synthesis", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "research-cancel-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("issue-synthesis respects cancel between iterations", async () => {
    // We import the machine dynamically to test it
    const { default: issueSynthesisMachine } = await import(
      "../src/machines/research/issue-synthesis.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");

    const pipeline = {
      version: 1,
      runId: "test-cancel",
      current: "issue_synthesis",
      history: [],
      steps: {},
    };
    writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2) + "\n");

    // Write a mock analysis-brief artifact
    writeFileSync(
      path.join(stepsDir, "analysis-brief.json"),
      JSON.stringify({ problem_spaces: [], constraints: [] }),
    );

    const logEvents = [];
    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: true, paused: false }, // Already cancelled
      log: (e) => logEvents.push(e),
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: { execute: async () => ({ exitCode: 0, stdout: "{}" }) },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await issueSynthesisMachine.run(
      {
        stepsDir,
        scratchpadPath,
        pipelinePath,
        repoRoot: tmp,
        iterations: 3,
        maxIssues: 6,
      },
      ctx,
    );

    // Should return cancelled status (from CancelledError caught by defineMachine)
    assert.equal(result.status, "cancelled");
  });

  it("issue-synthesis skips completed iterations on resume", async () => {
    const { default: issueSynthesisMachine } = await import(
      "../src/machines/research/issue-synthesis.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");

    // Pre-mark iteration 1 as completed
    const pipeline = {
      version: 1,
      runId: "test-resume",
      current: "issue_synthesis",
      history: [],
      steps: {
        synthesis_iteration_1: {
          status: "completed",
          completedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2) + "\n");

    // Write artifacts for iteration 1
    const draftPayload = {
      issues: [{ id: "IDEA-01", title: "Test Issue" }],
      assumptions: [],
      open_questions: [],
    };
    writeFileSync(
      path.join(stepsDir, "draft-01.json"),
      JSON.stringify(draftPayload),
    );
    writeFileSync(
      path.join(stepsDir, "analysis-brief.json"),
      JSON.stringify({ problem_spaces: [], constraints: [] }),
    );

    const logEvents = [];
    let agentCallCount = 0;

    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: false, paused: false },
      log: (e) => logEvents.push(e),
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: {
            execute: async () => {
              agentCallCount++;
              // Return issues for iteration 2 (final)
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  issues: [
                    { id: "IDEA-01", title: "Test Issue Updated" },
                    { id: "IDEA-02", title: "Second Issue" },
                  ],
                  assumptions: [],
                  open_questions: [],
                }),
              };
            },
          },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await issueSynthesisMachine.run(
      {
        stepsDir,
        scratchpadPath,
        pipelinePath,
        repoRoot: tmp,
        iterations: 2,
        maxIssues: 6,
      },
      ctx,
    );

    assert.equal(result.status, "ok");
    // Iteration 1 was skipped (no critique since iterations=2 means iteration 2 is last)
    // Only iteration 2 draft should call the agent (1 call)
    assert.equal(agentCallCount, 1);
    assert.ok(
      logEvents.some((e) => e.event === "research_iteration_skipped"),
      "should log that iteration 1 was skipped",
    );
  });
});

describe("context-gather cancel", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ctx-gather-cancel-"));
    mkdirSync(path.join(tmp, ".coder", "scratchpad"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("context-gather respects cancel in chunk loop", async () => {
    const { default: contextGatherMachine } = await import(
      "../src/machines/research/context-gather.machine.js"
    );

    // Create a git repo so the machine passes validation
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp, stdio: "pipe" });

    // Large pointer text to create multiple chunks
    const pointers = "x".repeat(15000) + "\n" + "y".repeat(15000);

    const logEvents = [];
    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: true, paused: false }, // Already cancelled
      log: (e) => logEvents.push(e),
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: {
            execute: async () => ({
              exitCode: 0,
              stdout: JSON.stringify({ summary: "test", signals: {} }),
            }),
          },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await contextGatherMachine.run(
      { pointers, repoPath: "." },
      ctx,
    );

    assert.equal(result.status, "cancelled");
  });
});

describe("deep-research cancel", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "deep-research-cancel-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("deep-research respects cancel before web search", async () => {
    const { default: deepResearchMachine } = await import(
      "../src/machines/research/deep-research.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        version: 1,
        current: "init",
        history: [],
        steps: {},
      }) + "\n",
    );
    writeFileSync(
      path.join(stepsDir, "analysis-brief.json"),
      JSON.stringify({ problem_spaces: [] }),
    );

    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: true, paused: false },
      log: () => {},
      config: { workflow: { timeouts: { webSearch: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: { execute: async () => ({ exitCode: 0, stdout: "{}" }) },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await deepResearchMachine.run(
      { stepsDir, scratchpadPath, pipelinePath, webResearch: true },
      ctx,
    );

    assert.equal(result.status, "cancelled");
  });
});

describe("poc-validation cancel", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "poc-cancel-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("poc-validation respects cancel between plan and execute", async () => {
    const { default: pocValidationMachine } = await import(
      "../src/machines/research/poc-validation.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        version: 1,
        current: "init",
        history: [],
        steps: {},
      }) + "\n",
    );
    writeFileSync(
      path.join(stepsDir, "analysis-brief.json"),
      JSON.stringify({ problem_spaces: [] }),
    );

    let callCount = 0;
    const cancelToken = { cancelled: false, paused: false };

    const ctx = {
      workspaceDir: tmp,
      cancelToken,
      log: () => {},
      config: {
        workflow: {
          timeouts: { researchStep: 60000, pocValidation: 60000 },
        },
      },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: {
            execute: async () => {
              callCount++;
              // After plan step completes, cancel before execute
              cancelToken.cancelled = true;
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  tracks: [{ id: "V1", topic: "test" }],
                  notes: "",
                }),
              };
            },
          },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await pocValidationMachine.run(
      { stepsDir, scratchpadPath, pipelinePath, validateIdeas: true },
      ctx,
    );

    assert.equal(result.status, "cancelled");
    // Only 1 call: plan succeeded, then cancel fired before execute
    assert.equal(callCount, 1);
  });
});

describe("issue-critique cancel", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "critique-cancel-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("issue-critique respects cancel", async () => {
    const { default: issueCritiqueMachine } = await import(
      "../src/machines/research/issue-critique.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        version: 1,
        current: "init",
        history: [],
        steps: {},
      }) + "\n",
    );

    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: true, paused: false },
      log: () => {},
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: { execute: async () => ({ exitCode: 0, stdout: "{}" }) },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await issueCritiqueMachine.run(
      {
        issues: [{ id: "IDEA-01", title: "Test" }],
        repoRoot: tmp,
        stepsDir,
        scratchpadPath,
        pipelinePath,
      },
      ctx,
    );

    assert.equal(result.status, "cancelled");
  });
});

describe("tech-selection cancel", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tech-cancel-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("tech-selection respects cancel", async () => {
    const { default: techSelectionMachine } = await import(
      "../src/machines/research/tech-selection.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        version: 1,
        current: "init",
        history: [],
        steps: {},
      }) + "\n",
    );

    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: true, paused: false },
      log: () => {},
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: { execute: async () => ({ exitCode: 0, stdout: "{}" }) },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await techSelectionMachine.run(
      {
        requirements: "Test requirements",
        stepsDir,
        scratchpadPath,
        pipelinePath,
      },
      ctx,
    );

    assert.equal(result.status, "cancelled");
  });

  it("tech-selection flattens web references from deep-research schema", async () => {
    const { default: techSelectionMachine } = await import(
      "../src/machines/research/tech-selection.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        version: 1,
        current: "init",
        history: [],
        steps: {},
      }) + "\n",
    );

    // Write web-references in deep-research's output schema
    const webRefs = {
      topics: [
        {
          topic: "state machines",
          references: [
            {
              source: "github",
              title: "XState",
              url: "https://github.com/statelyai/xstate",
              why: "mature JS state machine lib",
              library: "xstate",
            },
            {
              source: "docs",
              title: "Robot",
              url: "https://thisrobot.life",
              why: "lightweight alternative",
              library: "robot",
            },
          ],
        },
      ],
      missing_research: ["performance benchmarks"],
    };
    writeFileSync(
      path.join(stepsDir, "web-references.json"),
      JSON.stringify(webRefs),
    );

    let capturedPrompt = "";
    const ctx = {
      workspaceDir: tmp,
      cancelToken: { cancelled: false, paused: false },
      log: () => {},
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: {
            execute: async (prompt) => {
              capturedPrompt = prompt;
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  categories: [],
                  stack: { summary: "test", technologies: [] },
                }),
              };
            },
          },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };

    const result = await techSelectionMachine.run(
      {
        requirements: "Need a state machine library",
        stepsDir,
        scratchpadPath,
        pipelinePath,
      },
      ctx,
    );

    assert.equal(result.status, "ok");
    // Verify the prompt contains flattened reference titles, not "undefined"
    assert.ok(
      capturedPrompt.includes("XState"),
      "prompt should contain reference title 'XState'",
    );
    assert.ok(
      capturedPrompt.includes("Robot"),
      "prompt should contain reference title 'Robot'",
    );
    assert.ok(
      !capturedPrompt.includes("- undefined"),
      "prompt should not contain 'undefined' from broken Object.values()",
    );
  });
});

describe("prompt content — codebase grounding", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "prompt-content-"));
    mkdirSync(path.join(tmp, ".coder", "scratchpad"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeCtx(capturedPrompts) {
    return {
      workspaceDir: tmp,
      cancelToken: { cancelled: false, paused: false },
      log: () => {},
      config: { workflow: { timeouts: { researchStep: 60000 } } },
      agentPool: {
        getAgent: () => ({
          agentName: "test",
          agent: {
            execute: async (prompt) => {
              capturedPrompts.push(prompt);
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  summary: "test",
                  signals: {
                    bugs: [],
                    ideas: [],
                    constraints: [],
                    domains: [],
                    tools: [],
                  },
                  actionable_pointers: [],
                  problem_spaces: [],
                  constraints: [],
                  suspected_work_types: ["idea"],
                  priority_signals: [],
                  unknowns: [],
                }),
              };
            },
          },
        }),
      },
      secrets: {},
      artifactsDir: path.join(tmp, ".coder", "artifacts"),
      scratchpadDir: path.join(tmp, ".coder", "scratchpad"),
    };
  }

  it("context-gather chunk prompt includes codebase exploration and repoRoot", async () => {
    const { default: contextGatherMachine } = await import(
      "../src/machines/research/context-gather.machine.js"
    );
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: tmp, stdio: "pipe" });

    const capturedPrompts = [];
    const ctx = makeCtx(capturedPrompts);

    await contextGatherMachine.run(
      { pointers: "Add a caching layer to the API", repoPath: "." },
      ctx,
    );

    // Chunk prompt (first call)
    assert.ok(capturedPrompts.length >= 1, "should have at least 1 prompt");
    const chunkPrompt = capturedPrompts[0];
    assert.ok(
      chunkPrompt.includes("explore the codebase"),
      "chunk prompt should include codebase exploration instruction",
    );
    assert.ok(
      chunkPrompt.includes(tmp),
      "chunk prompt should include repoRoot path",
    );
    assert.ok(
      chunkPrompt.includes("Phase 1"),
      "chunk prompt should have Phase 1 for codebase exploration",
    );

    // Aggregation prompt (second call)
    if (capturedPrompts.length >= 2) {
      const aggPrompt = capturedPrompts[1];
      assert.ok(
        aggPrompt.includes("Codebase Validation"),
        "aggregation prompt should include codebase validation instruction",
      );
    }
  });

  it("issue-synthesis draft prompt references artifact file paths", async () => {
    const { default: issueSynthesisMachine } = await import(
      "../src/machines/research/issue-synthesis.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        version: 1,
        runId: "test",
        current: "init",
        history: [],
        steps: {},
      }) + "\n",
    );
    writeFileSync(
      path.join(stepsDir, "analysis-brief.json"),
      JSON.stringify({
        problem_spaces: [
          { name: "caching", description: "add cache", signals: [] },
        ],
      }),
    );

    const capturedPrompts = [];
    const ctx = makeCtx(capturedPrompts);
    // Override agent to return valid issues
    ctx.agentPool.getAgent = () => ({
      agentName: "test",
      agent: {
        execute: async (prompt) => {
          capturedPrompts.push(prompt);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              issues: [{ id: "IDEA-01", title: "Test Issue" }],
              assumptions: [],
              open_questions: [],
            }),
          };
        },
      },
    });

    await issueSynthesisMachine.run(
      {
        stepsDir,
        scratchpadPath,
        pipelinePath,
        repoRoot: tmp,
        iterations: 1,
        maxIssues: 6,
      },
      ctx,
    );

    assert.ok(capturedPrompts.length >= 1, "should have at least 1 prompt");
    const draftPrompt = capturedPrompts[0];
    // Should reference file paths, not inline JSON
    assert.ok(
      draftPrompt.includes("analysis-brief.json"),
      "draft prompt should reference analysis-brief file path",
    );
    assert.ok(
      draftPrompt.includes("explore the codebase"),
      "draft prompt should include codebase exploration",
    );
    assert.ok(
      !draftPrompt.includes('"problem_spaces"'),
      "draft prompt should NOT inline analysisBrief JSON",
    );
  });

  it("issue-critique prompt references artifact file paths and codebase grounding", async () => {
    const { default: issueCritiqueMachine } = await import(
      "../src/machines/research/issue-critique.machine.js"
    );

    const stepsDir = path.join(tmp, "steps");
    const scratchpadPath = path.join(tmp, "SCRATCHPAD.md");
    const pipelinePath = path.join(tmp, "pipeline.json");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(scratchpadPath, "# Test\n", "utf8");
    writeFileSync(
      pipelinePath,
      JSON.stringify({ version: 1, current: "init", history: [], steps: {} }) +
        "\n",
    );
    writeFileSync(
      path.join(stepsDir, "analysis-brief.json"),
      JSON.stringify({ problem_spaces: [] }),
    );

    const capturedPrompts = [];
    const ctx = makeCtx(capturedPrompts);
    // Override agent to return valid critique
    ctx.agentPool.getAgent = () => ({
      agentName: "test",
      agent: {
        execute: async (prompt) => {
          capturedPrompts.push(prompt);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              verdict: "approve",
              overallScore: 8,
              issueReviews: [],
              backlogIssues: {},
              summary: "good",
              feedback: [],
            }),
          };
        },
      },
    });

    await issueCritiqueMachine.run(
      {
        issues: [
          {
            id: "IDEA-01",
            title: "Test",
            objective: "test obj",
            changes: ["file.js"],
          },
        ],
        repoRoot: tmp,
        stepsDir,
        scratchpadPath,
        pipelinePath,
      },
      ctx,
    );

    assert.ok(capturedPrompts.length >= 1, "should have at least 1 prompt");
    const critiquePrompt = capturedPrompts[0];
    assert.ok(
      critiquePrompt.includes("critique-input-issues.json"),
      "critique prompt should reference issues file path",
    );
    assert.ok(
      critiquePrompt.includes("Codebase Grounding"),
      "critique prompt should include Codebase Grounding review criterion",
    );
    assert.ok(
      critiquePrompt.includes("Codebase Exploration"),
      "critique prompt should include codebase exploration instruction",
    );
    assert.ok(
      critiquePrompt.includes(tmp),
      "critique prompt should include repoRoot",
    );
  });
});

describe("session state helpers", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "session-state-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips session state to disk", async () => {
    const { loadSessionState, saveSessionState } = await import(
      "../src/machines/research/_shared.js"
    );

    // Initially empty
    const initial = loadSessionState(tmp);
    assert.deepEqual(initial, {});

    // Save and reload
    const state = {
      synthesisDraftSessionId: "abc-123",
      synthesisDraftSessionId_agent: "claude",
    };
    saveSessionState(tmp, state);

    const loaded = loadSessionState(tmp);
    assert.deepEqual(loaded, state);

    // Verify file on disk
    const raw = JSON.parse(
      readFileSync(path.join(tmp, "session-state.json"), "utf8"),
    );
    assert.equal(raw.synthesisDraftSessionId, "abc-123");
  });
});
