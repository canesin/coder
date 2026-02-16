import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoderOrchestrator } from "../src/orchestrator.js";
import { loadState } from "../src/state.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-orch-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  run("git", ["init"], dir);
  return dir;
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `command failed: ${cmd} ${args.join(" ")}\n${res.stderr || res.stdout}`,
  );
  return res;
}

function commitInitial(cwd) {
  run("git", ["config", "user.email", "test@example.com"], cwd);
  run("git", ["config", "user.name", "Test User"], cwd);
  writeFileSync(path.join(cwd, "README.md"), "hello\n", "utf8");
  run("git", ["add", "."], cwd);
  run("git", ["commit", "-m", "initial"], cwd);
}

class StubOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
    this._responses = [];
    this.secrets = { ...this.secrets, LINEAR_API_KEY: "linear-token" };
  }

  queueResponse(res) {
    this._responses.push(res);
  }

  _getGemini() {
    return {};
  }

  async _executeWithRetry() {
    const next = this._responses.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

class StubPlanOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
  }
  _getClaude() {
    return {};
  }
  async _executeAgentCommand(agentName, _agent, _cmd) {
    // Simulate Claude writing PLAN.md and creating untracked exploration artifacts.
    if (agentName === "claude") {
      writeFileSync(
        path.join(this.workspaceDir, ".coder", "artifacts", "PLAN.md"),
        "# Plan\n",
        "utf8",
      );
      writeFileSync(
        path.join(this.workspaceDir, "Cargo.toml"),
        "[package]\nname='x'\n",
        "utf8",
      );
      mkdirSync(path.join(this.workspaceDir, "src"), { recursive: true });
      writeFileSync(
        path.join(this.workspaceDir, "src", "lib.rs"),
        "pub fn x() {}\n",
        "utf8",
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class StubAutoInfraOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
  }
  async listIssues() {
    return {
      issues: [
        {
          source: "github",
          id: "1",
          title: "Issue 1",
          repo_path: ".",
          difficulty: 1,
        },
        {
          source: "github",
          id: "2",
          title: "Issue 2",
          repo_path: ".",
          difficulty: 1,
        },
      ],
      recommended_index: 0,
      linearProjects: [],
    };
  }
  async _buildAutoQueue() {
    return [
      {
        source: "github",
        id: "1",
        title: "Issue 1",
        repoPath: ".",
        baseBranch: null,
        status: "pending",
        branch: null,
        prUrl: null,
        error: null,
        startedAt: null,
        completedAt: null,
        dependsOn: [],
      },
      {
        source: "github",
        id: "2",
        title: "Issue 2",
        repoPath: ".",
        baseBranch: null,
        status: "pending",
        branch: null,
        prUrl: null,
        error: null,
        startedAt: null,
        completedAt: null,
        dependsOn: [],
      },
    ];
  }
  _resetForNextIssue() {}
  async draftIssue() {
    const state = loadState(this.workspaceDir);
    state.repoPath = ".";
    state.branch = "coder/github-1";
    state.steps = {
      ...(state.steps || {}),
      wroteIssue: true,
      verifiedCleanRepo: true,
    };
    writeFileSync(
      path.join(this.workspaceDir, ".coder", "artifacts", "ISSUE.md"),
      "# Issue\n",
      "utf8",
    );
    run("git", ["checkout", "-B", state.branch], this.workspaceDir);
    writeFileSync(
      path.join(this.workspaceDir, ".coder", "state.json"),
      JSON.stringify(state, null, 2) + "\n",
      "utf8",
    );
  }
  async createPlan() {
    const state = loadState(this.workspaceDir);
    state.steps = {
      ...(state.steps || {}),
      wrotePlan: true,
      wroteCritique: true,
    };
    writeFileSync(
      path.join(this.workspaceDir, ".coder", "artifacts", "PLAN.md"),
      "# Plan\n",
      "utf8",
    );
    writeFileSync(
      path.join(this.workspaceDir, ".coder", "state.json"),
      JSON.stringify(state, null, 2) + "\n",
      "utf8",
    );
    return { planMd: "# Plan\n", critiqueMd: "" };
  }
  async implement() {
    const state = loadState(this.workspaceDir);
    state.steps = { ...(state.steps || {}), implemented: true };
    writeFileSync(
      path.join(this.workspaceDir, ".coder", "state.json"),
      JSON.stringify(state, null, 2) + "\n",
      "utf8",
    );
    return { summary: "ok" };
  }
  async reviewAndTest() {
    const err = new Error("Test infra missing");
    err.name = "TestInfrastructureError";
    throw err;
  }
  async createPR() {}
}

class StubIdeaOrchestrator extends CoderOrchestrator {
  constructor(workspaceDir) {
    super(workspaceDir, { allowNoTests: true });
    this._responses = [];
    this._commands = [];
  }
  queueResponse(res) {
    this._responses.push(res);
  }
  _getRoleAgent(role) {
    if (role === "planReviewer") return { agentName: "claude", agent: {} };
    return { agentName: "gemini", agent: {} };
  }
  async _executeWithRetry(_agent, cmd) {
    this._commands.push(String(cmd || ""));
    const next = this._responses.shift();
    if (!next) throw new Error("No queued response");
    if (next instanceof Error) throw next;
    return next;
  }
}

test("_normalizeRepoPath keeps valid workspace-relative paths and rejects invalid ones", () => {
  const ws = makeWorkspace();
  mkdirSync(path.join(ws, "subrepo"), { recursive: true });
  run("git", ["init"], path.join(ws, "subrepo"));
  mkdirSync(path.join(ws, "subrepo", "src"), { recursive: true });
  writeFileSync(
    path.join(ws, "subrepo", "src", "file.js"),
    "console.log('x');\n",
    "utf8",
  );
  const orch = new CoderOrchestrator(ws);

  assert.equal(orch._normalizeRepoPath("subrepo"), "subrepo");
  assert.equal(orch._normalizeRepoPath("subrepo/src/file.js"), "subrepo");
  assert.equal(orch._normalizeRepoPath("."), ".");
  assert.equal(orch._normalizeRepoPath("../escape"), ".");
  assert.equal(orch._normalizeRepoPath("/tmp"), ".");
  assert.equal(orch._normalizeRepoPath("does-not-exist"), ".");
});

test("workflow agent role overrides are applied", () => {
  const ws = makeWorkspace();
  writeFileSync(
    path.join(ws, "coder.json"),
    JSON.stringify(
      {
        workflow: {
          agentRoles: {
            issueSelector: "claude",
            planner: "codex",
            planReviewer: "claude",
            programmer: "codex",
            reviewer: "gemini",
            committer: "claude",
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const orch = new CoderOrchestrator(ws, { allowNoTests: true });

  assert.equal(orch._roleAgentName("issueSelector"), "claude");
  assert.equal(orch._roleAgentName("planner"), "codex");
  assert.equal(orch._roleAgentName("planReviewer"), "claude");
  assert.equal(orch._roleAgentName("programmer"), "codex");
  assert.equal(orch._roleAgentName("reviewer"), "gemini");
  assert.equal(orch._roleAgentName("committer"), "claude");
});

test("listIssues continues when optional Linear project listing fails", async () => {
  const ws = makeWorkspace();
  const orch = new StubOrchestrator(ws);

  orch.queueResponse(new Error("linear auth failed"));
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({ issues: [], recommended_index: 0 }),
  });

  const result = await orch.listIssues();
  assert.deepEqual(result, {
    issues: [],
    recommended_index: 0,
    linearProjects: [],
  });

  const state = loadState(ws);
  assert.equal(state.steps.listedProjects, true);
  assert.equal(state.steps.listedIssues, true);
});

test("_buildAutoQueue normalizes invalid repo_path from Gemini output", async () => {
  const ws = makeWorkspace();
  mkdirSync(path.join(ws, "valid-subdir"), { recursive: true });
  run("git", ["init"], path.join(ws, "valid-subdir"));
  const orch = new StubOrchestrator(ws);

  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      queue: [
        {
          source: "github",
          id: "1",
          title: "Issue 1",
          repo_path: "acme/private-repo",
          depends_on: [],
          reason: "invalid path",
        },
        {
          source: "github",
          id: "2",
          title: "Issue 2",
          repo_path: "valid-subdir",
          depends_on: [],
          reason: "valid path",
        },
      ],
      excluded: [],
    }),
  });

  const queue = await orch._buildAutoQueue(
    [
      {
        source: "github",
        id: "1",
        title: "Issue 1",
        repo_path: ".",
        difficulty: 1,
      },
      {
        source: "github",
        id: "2",
        title: "Issue 2",
        repo_path: ".",
        difficulty: 1,
      },
    ],
    "resolve all",
  );

  assert.equal(queue[0].repoPath, ".");
  assert.equal(queue[1].repoPath, "valid-subdir");
});

test("_executeWithRetry enforces strict MCP startup checks and does not retry", async () => {
  const ws = makeWorkspace();
  writeFileSync(
    path.join(ws, ".coder", "mcp-health.json"),
    JSON.stringify({ gemini: { ready: "foo", failed: "bar" } }, null, 2) + "\n",
    "utf8",
  );

  const orch = new CoderOrchestrator(ws, { strictMcpStartup: true });
  let calls = 0;
  const fakeAgent = {
    async executeCommand() {
      calls += 1;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };

  await assert.rejects(
    async () =>
      orch._executeWithRetry(fakeAgent, "noop", {
        retries: 3,
        agentName: "gemini",
      }),
    /MCP startup failure for gemini/,
  );
  assert.equal(calls, 1);
});

test("_ensureGitignore writes .geminiignore unignore rules for workflow artifacts", () => {
  const ws = makeWorkspace();
  // Constructor calls _ensureGitignore.
  // eslint-disable-next-line no-new
  new CoderOrchestrator(ws);
  const content = readFileSync(path.join(ws, ".geminiignore"), "utf8");
  assert.match(content, /!\.coder\/$/m);
  assert.match(content, /!\.coder\/artifacts\/$/m);
  assert.match(content, /!\.coder\/artifacts\/ISSUE\.md/);
  assert.match(content, /!\.coder\/artifacts\/PLAN\.md/);
  assert.match(content, /!\.coder\/artifacts\/PLANREVIEW\.md/);
  assert.match(content, /!\.coder\/scratchpad\/$/m);
  assert.match(content, /!\.coder\/scratchpad\/\*\*/);
});

test("getStatus includes WIP and scratchpad durability metadata", () => {
  const ws = makeWorkspace();
  const orch = new CoderOrchestrator(ws);
  const status = orch.getStatus();

  assert.equal(status.wip.enabled, true);
  assert.equal(status.wip.remote, "origin");
  assert.equal(status.wip.lastPushedAt, null);
  assert.equal(status.scratchpad.sqlite.path, ".coder/state.db");
});

test("createPlan allows untracked exploration artifacts but cleans up newly-created ones", async () => {
  const ws = makeWorkspace();
  commitInitial(ws);
  const orch = new StubPlanOrchestrator(ws);
  writeFileSync(
    path.join(ws, ".coder", "artifacts", "ISSUE.md"),
    "# Issue\n",
    "utf8",
  );
  writeFileSync(
    path.join(ws, ".coder", "state.json"),
    JSON.stringify(
      {
        repoPath: ".",
        branch: "coder/github-1",
        selected: { source: "github", id: "1", title: "Issue 1" },
        steps: { wroteIssue: true, wroteCritique: true },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  run("git", ["checkout", "-B", "coder/github-1"], ws);

  await orch.createPlan();

  assert.equal(
    readFileSync(
      path.join(ws, ".coder", "artifacts", "PLAN.md"),
      "utf8",
    ).includes("# Plan"),
    true,
  );
  assert.equal(existsSync(path.join(ws, "Cargo.toml")), false);
  assert.equal(existsSync(path.join(ws, "src")), false);
});

test("runAuto aborts and skips remaining issues on TestInfrastructureError to avoid cascades", async () => {
  const ws = makeWorkspace();
  commitInitial(ws);
  const orch = new StubAutoInfraOrchestrator(ws);
  const res = await orch.runAuto({ destructiveReset: false });
  assert.equal(res.failed, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.status, "failed");
});

test("generateIssuesFromPointers writes iteration artifacts to .coder/scratchpad", async () => {
  const ws = makeWorkspace();
  const orch = new StubIdeaOrchestrator(ws);

  // Step 1: chunk analysis
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      summary: "Health endpoint behavior and test coverage are needed.",
      signals: {
        bugs: [],
        ideas: ["health endpoint contract"],
        constraints: ["production readiness"],
        domains: ["observability"],
        tools: ["tests"],
      },
      actionable_pointers: ["Define health endpoint schema and tests."],
    }),
  });

  // Step 2: aggregate analysis
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      problem_spaces: [
        {
          name: "health endpoint",
          description: "No clear contract or validation for health checks.",
          signals: ["coverage gap", "production reliability risk"],
        },
      ],
      constraints: ["Keep compatibility", "Add concrete verification"],
      suspected_work_types: ["idea"],
      priority_signals: ["production-readiness"],
      unknowns: ["Expected health payload format"],
    }),
  });

  // Step 3: web references
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      topics: [
        {
          topic: "health endpoint",
          references: [
            {
              source: "github",
              title: "upptime",
              url: "https://github.com/upptime/upptime",
              why: "Reference for health/status conventions",
              library: "upptime",
            },
            {
              source: "show_hn",
              title: "Show HN: Status Page Tooling",
              url: "https://news.ycombinator.com/item?id=123456",
              why: "Examples of practical status endpoint expectations",
              library: "n/a",
            },
          ],
        },
      ],
      missing_research: [],
    }),
  });

  // Step 4: validation plan
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      tracks: [
        {
          id: "V1",
          topic: "health endpoint contract",
          mode: "poc",
          tool_preference: ["playwright"],
          procedure: ["Probe endpoint and assert response shape"],
          success_signal: "Stable schema + expected status code",
          fallback: "analysis-only if runtime unavailable",
        },
      ],
      notes: "Prefer lightweight validation before issue finalization",
    }),
  });

  // Step 5: validation execution
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      results: [
        {
          track_id: "V1",
          mode: "poc",
          status: "inconclusive",
          tool_used: "playwright",
          method: "Attempted endpoint probe",
          evidence: ["Probe attempted; no running service in test fixture"],
          limitations: ["No runtime service available in unit-test workspace"],
        },
      ],
      summary: "Validation attempted; environment-limited",
    }),
  });

  // Step 6: issue backlog draft
  orch.queueResponse({
    exitCode: 0,
    stdout: JSON.stringify({
      issues: [
        {
          id: "IDEA-01",
          title: "Add health endpoint coverage",
          objective: "Define and verify health endpoint behavior.",
          problem: "No reproducible healthcheck contract exists.",
          changes: ["Document endpoint contract", "Add tests"],
          verification: "npm test -- health",
          out_of_scope: ["UI redesign"],
          depends_on: [],
          priority: "P1",
          tags: ["observability", "api"],
          estimated_effort: "1d",
          acceptance_criteria: ["Endpoint response schema is documented"],
          research_questions: ["Should healthcheck include dependency status?"],
          risks: ["Breaking existing integrations"],
          notes: "Start with backward-compatible schema",
          references: [
            {
              source: "github",
              title: "upptime",
              url: "https://github.com/upptime/upptime",
              why: "Reference health/status conventions",
            },
          ],
          validation: {
            mode: "poc",
            status: "inconclusive",
            method: "Endpoint probe with Playwright-style HTTP checks",
            evidence: ["No live service in test workspace"],
            limitations: ["Runtime not available"],
          },
        },
      ],
      assumptions: [],
      open_questions: [],
    }),
  });

  const result = await orch.generateIssuesFromPointers({
    pointers: "Need production-ready health endpoint behavior and tests.",
    repoPath: ".",
    iterations: 1,
    maxIssues: 3,
  });

  assert.equal(result.issues.length, 1);
  assert.equal(
    existsSync(path.join(ws, result.issues[0].filePath)),
    true,
    "expected generated issue markdown in scratchpad run dir",
  );
  assert.equal(existsSync(path.join(ws, result.scratchpadPath)), true);
  assert.equal(existsSync(path.join(ws, result.manifestPath)), true);
  assert.equal(existsSync(path.join(ws, result.pipelinePath)), true);
  assert.equal(result.webResearch, true);
  assert.equal(result.validateIdeas, true);
  assert.equal(result.validationMode, "auto");
  assert.equal(result.issues[0].referenceCount, 1);
  assert.equal(result.issues[0].validationStatus, "inconclusive");
  assert.equal(
    orch._commands.some((cmd) => cmd.includes("Show HN")),
    true,
    "expected draft prompt to require Show HN research",
  );
  assert.equal(
    orch._commands.some((cmd) => cmd.includes("playwright")) &&
      orch._commands.some((cmd) => cmd.includes("cratedex")) &&
      orch._commands.some((cmd) => cmd.includes("qt-mcp")),
    true,
    "expected draft prompt to include MCP-based validation guidance",
  );
});

test("_resetForNextIssue removes .coder/artifacts files and preserves workspace root markdown", () => {
  const ws = makeWorkspace();
  const orch = new CoderOrchestrator(ws, { allowNoTests: true });

  const rootIssue = path.join(ws, "ISSUE.md");
  const rootPlan = path.join(ws, "PLAN.md");
  const rootCritique = path.join(ws, "PLANREVIEW.md");
  writeFileSync(rootIssue, "user file\n", "utf8");
  writeFileSync(rootPlan, "user file\n", "utf8");
  writeFileSync(rootCritique, "user file\n", "utf8");

  writeFileSync(
    path.join(ws, ".coder", "state.json"),
    JSON.stringify({ repoPath: "." }) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(ws, ".coder", "artifacts", "ISSUE.md"),
    "artifact\n",
    "utf8",
  );
  writeFileSync(
    path.join(ws, ".coder", "artifacts", "PLAN.md"),
    "artifact\n",
    "utf8",
  );
  writeFileSync(
    path.join(ws, ".coder", "artifacts", "PLANREVIEW.md"),
    "artifact\n",
    "utf8",
  );

  orch._resetForNextIssue(null);

  assert.equal(existsSync(path.join(ws, ".coder", "state.json")), false);
  assert.equal(
    existsSync(path.join(ws, ".coder", "artifacts", "ISSUE.md")),
    false,
  );
  assert.equal(
    existsSync(path.join(ws, ".coder", "artifacts", "PLAN.md")),
    false,
  );
  assert.equal(
    existsSync(path.join(ws, ".coder", "artifacts", "PLANREVIEW.md")),
    false,
  );
  assert.equal(existsSync(rootIssue), true);
  assert.equal(existsSync(rootPlan), true);
  assert.equal(existsSync(rootCritique), true);
});

test("_recordError clears claudeSessionId on CommandTimeoutError", () => {
  const ws = makeWorkspace();
  const orch = new CoderOrchestrator(ws, { allowNoTests: true });

  writeFileSync(
    path.join(ws, ".coder", "state.json"),
    JSON.stringify({ claudeSessionId: "old-session-abc" }) + "\n",
    "utf8",
  );

  const err = new Error("Command timeout after 60000ms: claude ...");
  err.name = "CommandTimeoutError";
  orch._recordError(err);

  const state = loadState(ws);
  assert.equal(state.claudeSessionId, null);
  assert.match(state.lastError, /CommandTimeoutError|Command timeout/);
});

test("_recordError preserves claudeSessionId on non-timeout errors", () => {
  const ws = makeWorkspace();
  const orch = new CoderOrchestrator(ws, { allowNoTests: true });

  writeFileSync(
    path.join(ws, ".coder", "state.json"),
    JSON.stringify({ claudeSessionId: "keep-this-session" }) + "\n",
    "utf8",
  );

  orch._recordError(new Error("some other failure"));

  const state = loadState(ws);
  assert.equal(state.claudeSessionId, "keep-this-session");
});
