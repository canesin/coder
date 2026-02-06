import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { VibeKit } from "@vibe-kit/sdk";

import { HostSandboxProvider } from "./host-sandbox.js";
import { ensureLogsDir, makeJsonlLogger, closeAllLoggers } from "./logging.js";
import { loadState, saveState } from "./state.js";
import { sanitizeBranchForRef } from "./worktrees.js";
import { IssuesPayloadSchema, QuestionsPayloadSchema, ProjectsPayloadSchema } from "./schemas.js";
import {
  buildSecrets,
  extractJson,
  heredocPipe,
  geminiJsonPipe,
  gitCleanOrThrow,
  runPlanreview,
  runPpcommit,
  runHostTests,
  DEFAULT_PASS_ENV,
} from "./helpers.js";

export class CoderOrchestrator {
  /**
   * @param {string} workspaceDir - Absolute path to the workspace directory
   * @param {{ passEnv?: string[], verbose?: boolean, testCmd?: string, testConfigPath?: string, allowNoTests?: boolean }} [opts]
   */
  constructor(workspaceDir, opts = {}) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.passEnv = opts.passEnv || DEFAULT_PASS_ENV;
    this.verbose = opts.verbose || false;
    this.testCmd = opts.testCmd || "";
    this.testConfigPath = opts.testConfigPath || "";
    this.allowNoTests = opts.allowNoTests || false;

    this.issueFile = "ISSUE.md";
    this.planFile = "PLAN.md";
    this.critiqueFile = "PLANREVIEW.md";

    mkdirSync(path.join(this.workspaceDir, ".coder"), { recursive: true });
    ensureLogsDir(this.workspaceDir);

    // Ensure coder artifacts are gitignored so only real work gets committed
    this._ensureGitignore();

    this.log = makeJsonlLogger(this.workspaceDir, "coder");
    this.secrets = buildSecrets(this.passEnv);

    // Lazily-initialized agents
    this._gemini = null;
    this._claude = null;
    this._codex = null;
  }

  // --- Agent construction ---

  _attachAgentLogging(name, vk) {
    const agentLog = makeJsonlLogger(this.workspaceDir, name);
    vk.on("stdout", (d) => agentLog({ stream: "stdout", data: d }));
    vk.on("stderr", (d) => agentLog({ stream: "stderr", data: d }));
    vk.on("update", (d) => agentLog({ stream: "update", data: d }));
    vk.on("error", (d) => agentLog({ stream: "error", data: d }));
    if (this.verbose) {
      vk.on("stdout", (d) => process.stdout.write(`[${name}] ${d}`));
      vk.on("stderr", (d) => process.stderr.write(`[${name}] ${d}`));
    }

    // File-based activity tracking (Feature 7)
    // Throttled writer: max 1 write/sec to .coder/activity.json
    const activityPath = path.join(this.workspaceDir, ".coder", "activity.json");
    let lastWriteTs = 0;
    const writeActivity = () => {
      const now = Date.now();
      if (now - lastWriteTs < 1000) return;
      lastWriteTs = now;
      try {
        let activity = {};
        if (existsSync(activityPath)) {
          try {
            activity = JSON.parse(readFileSync(activityPath, "utf8"));
          } catch {
            // corrupted file, start fresh
          }
        }
        activity[name] = { lastActivityTs: now, status: "active" };
        writeFileSync(activityPath, JSON.stringify(activity, null, 2) + "\n");
      } catch {
        // best-effort
      }
    };
    vk.on("stdout", writeActivity);
    vk.on("stderr", writeActivity);
    vk.on("update", writeActivity);
    vk.on("error", writeActivity);
  }

  _getGemini() {
    if (!this._gemini) {
      const geminiConfig = {
        type: "gemini",
        provider: "google",
        model: "gemini-3-flash-preview",
      };
      const geminiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
      if (geminiKey) geminiConfig.apiKey = geminiKey;

      this._gemini = new VibeKit()
        .withSandbox(new HostSandboxProvider({ defaultCwd: this.workspaceDir, baseEnv: this.secrets }))
        .withWorkingDirectory(this.workspaceDir)
        .withSecrets(this.secrets)
        .withAgent(geminiConfig);
      this._attachAgentLogging("gemini", this._gemini);
    }
    return this._gemini;
  }

  _makeRepoAgent(name, agentConfig) {
    const state = this._loadState();
    const repoRoot = path.resolve(this.workspaceDir, state.repoPath);

    const provider = new HostSandboxProvider({ defaultCwd: repoRoot, baseEnv: this.secrets });
    const vk = new VibeKit()
      .withSandbox(provider)
      .withWorkingDirectory(repoRoot)
      .withSecrets(this.secrets)
      .withAgent(agentConfig);
    this._attachAgentLogging(name, vk);
    return vk;
  }

  _getClaude() {
    if (!this._claude) {
      const config = {
        type: "claude",
        provider: "anthropic",
        model: "claude-opus-4-6",
      };
      // Only pass explicit auth when set — otherwise the claude CLI
      // uses its own stored OAuth session (e.g. Max plan login).
      if (process.env.ANTHROPIC_API_KEY) config.apiKey = process.env.ANTHROPIC_API_KEY;
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) config.oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      this._claude = this._makeRepoAgent("claude", config);
    }
    return this._claude;
  }

  _getCodex() {
    if (!this._codex) {
      const config = {
        type: "codex",
        provider: "openai",
        model: "gpt-5.3-codex",
      };
      // Only pass explicit auth when set — otherwise the codex CLI
      // uses its own stored session (e.g. Max plan login).
      if (process.env.OPENAI_API_KEY) config.apiKey = process.env.OPENAI_API_KEY;
      this._codex = this._makeRepoAgent("codex", config);
    }
    return this._codex;
  }

  // --- Gitignore ---

  _ensureGitignore() {
    const gitignorePath = path.join(this.workspaceDir, ".gitignore");
    const entries = [".coder/", this.issueFile, this.planFile, this.critiqueFile];

    let content = "";
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf8");
    }

    const missing = entries.filter((e) => !content.split("\n").some((line) => line.trim() === e));
    if (missing.length > 0) {
      const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
      const block = `${suffix}# coder workflow artifacts\n${missing.join("\n")}\n`;
      writeFileSync(gitignorePath, content + block);
    }
  }

  // --- State helpers ---

  _loadState() {
    return loadState(this.workspaceDir);
  }

  _saveState(state) {
    saveState(this.workspaceDir, state);
  }

  _artifactPaths() {
    return {
      issue: path.join(this.workspaceDir, this.issueFile),
      plan: path.join(this.workspaceDir, this.planFile),
      critique: path.join(this.workspaceDir, this.critiqueFile),
    };
  }

  _repoRoot(state) {
    if (!state.repoPath) throw new Error("No repo path set. Run draftIssue first.");
    return path.resolve(this.workspaceDir, state.repoPath);
  }

  /**
   * Check for artifact collisions before starting a new workflow.
   * Prevents overwriting foreign files or stale workflow artifacts.
   * @param {{ force?: boolean }} [opts]
   */
  _checkArtifactCollisions({ force } = {}) {
    if (force) return;

    const paths = this._artifactPaths();
    const hasArtifacts =
      existsSync(paths.issue) || existsSync(paths.plan) || existsSync(paths.critique);
    const statePath = path.join(this.workspaceDir, ".coder", "state.json");
    const hasState = existsSync(statePath);

    if (hasArtifacts && !hasState) {
      throw new Error(
        "Artifact collision: ISSUE.md/PLAN.md/PLANREVIEW.md exist but no .coder/state.json found. " +
          "These may be foreign files. Remove them or pass force=true to bypass.",
      );
    }

    // If state exists, draftIssue will enforce that a new run matches the
    // already-selected issue unless force=true.
  }

  /**
   * Record an error to state (best-effort).
   */
  _recordError(err) {
    try {
      const state = this._loadState();
      state.lastError = `[${new Date().toISOString()}] ${err.message || String(err)}`;
      this._saveState(state);
    } catch {
      // best-effort — don't mask the original error
    }
  }

  /**
   * Retry wrapper with exponential backoff. Does not retry timeout errors.
   * @param {object} agent - VibeKit agent
   * @param {string} cmd - Command to execute
   * @param {{ timeoutMs?: number, retries?: number, backoffMs?: number }} opts
   */
  async _executeWithRetry(agent, cmd, { timeoutMs = 1000 * 60 * 10, retries = 1, backoffMs = 5000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await agent.executeCommand(cmd, { timeoutMs });
      } catch (err) {
        lastErr = err;
        // Don't retry timeout errors (they're unlikely to succeed)
        if (err.name === "CommandTimeoutError") throw err;
        if (attempt < retries) {
          const delay = backoffMs * Math.pow(2, attempt);
          this.log({ event: "retry", attempt: attempt + 1, delay, error: err.message });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Ensure the repo is on the correct feature branch.
   * Creates the branch if it doesn't exist, checks it out if not current.
   */
  _ensureBranch(state) {
    const repoRoot = this._repoRoot(state);
    const branch = state.branch;
    if (!branch) throw new Error("No branch set. Run draftIssue first.");

    const current = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (current.status !== 0) throw new Error("Failed to determine current git branch.");

    const currentBranch = (current.stdout || "").trim();
    if (currentBranch === branch) return; // already on the right branch

    // Try checking out existing branch first
    const checkout = spawnSync("git", ["checkout", branch], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (checkout.status === 0) return;

    // Branch doesn't exist — create it
    const create = spawnSync("git", ["checkout", "-b", branch], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (create.status !== 0) {
      throw new Error(`Failed to create branch ${branch}: ${create.stderr}`);
    }
  }

  // --- Step 1: List Issues ---

  /**
   * List assigned issues from GitHub/Linear, rate difficulty.
   * @param {{ projectFilter?: string }} [opts]
   * @returns {Promise<{ issues: Array, recommended_index: number, linearProjects?: Array }>}
   */
  async listIssues({ projectFilter } = {}) {
    try {
      const state = this._loadState();
      state.steps ||= {};
      const gemini = this._getGemini();

      // Sub-step: list Linear teams if available and not cached
      if (process.env.LINEAR_API_KEY && (!state.steps.listedProjects || !state.linearProjects)) {
        this.log({ event: "step0_list_projects" });
        const projPrompt = `Use your Linear MCP to list all teams I have access to.

Return ONLY valid JSON in this schema:
{
  "projects": [
    {
      "id": "string (team ID)",
      "name": "string (team name)",
      "key": "string (team key, e.g. ENG)"
    }
  ]
}`;
        const projCmd = geminiJsonPipe(projPrompt);
        const projRes = await this._executeWithRetry(gemini, projCmd, {
          timeoutMs: 1000 * 60 * 5,
          retries: 1,
        });
        if (projRes.exitCode !== 0) throw new Error("Gemini project listing failed.");
        const projPayload = ProjectsPayloadSchema.parse(extractJson(projRes.stdout));
        state.linearProjects = projPayload.projects;

        // If projectFilter is given, auto-select matching project
        if (projectFilter && state.linearProjects.length > 0) {
          const match = state.linearProjects.find(
            (p) =>
              p.name.toLowerCase().includes(projectFilter.toLowerCase()) ||
              p.key.toLowerCase() === projectFilter.toLowerCase(),
          );
          if (match) state.selectedProject = match;
        }

        state.steps.listedProjects = true;
        this._saveState(state);
      }

      // Main issue listing
      this.log({ event: "step1_list_issues" });
      let projectFilterClause = "";
      if (state.selectedProject) {
        projectFilterClause = `\nOnly include Linear issues from the "${state.selectedProject.name}" team (key: ${state.selectedProject.key}).`;
      } else if (projectFilter) {
        projectFilterClause = `\nOnly include Linear issues from projects matching "${projectFilter}".`;
      }

      const listPrompt = `Use your GitHub MCP and Linear MCP to list the issues assigned to me.${projectFilterClause}

Then, for each issue, briefly inspect the local code in the relevant repository folder(s) in this workspace (${this.workspaceDir}) and estimate implementation difficulty and directness (prefer small, self-contained changes).

Return ONLY valid JSON in this schema:
{
  "issues": [
    {
      "source": "github" | "linear",
      "id": "string",
      "title": "string",
      "repo_path": "string (relative path to repo subfolder in workspace, or empty if unknown)",
      "difficulty": 1 | 2 | 3 | 4 | 5,
      "reason": "short explanation"
    }
  ],
  "recommended_index": number
}`;

      const cmd = geminiJsonPipe(listPrompt);
      const res = await this._executeWithRetry(gemini, cmd, {
        timeoutMs: 1000 * 60 * 10,
        retries: 1,
      });
      if (res.exitCode !== 0) throw new Error("Gemini issue listing failed.");
      const issuesPayload = IssuesPayloadSchema.parse(extractJson(res.stdout));

      state.steps.listedIssues = true;
      state.issuesPayload = issuesPayload;
      this._saveState(state);

      return {
        issues: issuesPayload.issues,
        recommended_index: issuesPayload.recommended_index,
        linearProjects: state.linearProjects || undefined,
      };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Step 2: Draft Issue ---

  /**
   * Draft ISSUE.md for a selected issue.
   * @param {{ issue: { source: string, id: string, title: string }, repoPath: string, clarifications: string }} params
   * @returns {Promise<{ issueMd: string }>}
   */
  async draftIssue({ issue, repoPath, clarifications, force }) {
    try {
      this._checkArtifactCollisions({ force });

      const state = this._loadState();
      state.steps ||= {};

      // Check for stale workflow (different issue already selected)
      if (state.selected && !force) {
        const active = state.selected;
        if (active.source !== issue.source || active.id !== issue.id) {
          throw new Error(
            `Stale workflow: state has issue ${active.source}#${active.id} ("${active.title}") ` +
              `but you are trying to start ${issue.source}#${issue.id} ("${issue.title}"). ` +
              `Remove .coder/state.json and artifacts, or pass force=true.`,
          );
        }
      }

      // Store the selected issue and repo path
      state.selected = issue;
      state.repoPath = repoPath;
      state.branch = sanitizeBranchForRef(`coder/${issue.source}-${issue.id}`);
      this._saveState(state);

      const repoRoot = this._repoRoot(state);
      if (!existsSync(repoRoot)) throw new Error(`Repo root does not exist: ${repoRoot}`);

      const isGit = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, encoding: "utf8" });
      if (isGit.status !== 0) throw new Error(`Not a git repository: ${repoRoot}`);

      // Verify repo is clean
      gitCleanOrThrow(repoRoot);
      state.steps.verifiedCleanRepo = true;
      this._saveState(state);

      // Create/checkout the feature branch
      this._ensureBranch(state);

      // Draft ISSUE.md
      this.log({ event: "step2_draft_issue", issue });
      const { issue: issuePath } = this._artifactPaths();
      const gemini = this._getGemini();

      const issuePrompt = `Draft an ISSUE.md for the chosen issue. Use the local codebase in ${repoRoot} as ground truth.
Be specific about what needs to change, and how to verify it.

Chosen issue:
- source: ${issue.source}
- id: ${issue.id}
- title: ${issue.title}
- repo_root: ${repoRoot}

Clarifications from user:
${clarifications || "(none provided)"}

Output ONLY markdown suitable for writing directly to ISSUE.md.
Include a short section at the top with:
- Source
- Issue ID
- Repo Root (relative path if possible)
`;

      const cmd = heredocPipe(issuePrompt, "gemini --yolo");
      const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 10 });
      if (res.exitCode !== 0) throw new Error("Gemini ISSUE.md drafting failed.");

      // Gemini may write the file via tool use and respond conversationally,
      // or it may output the markdown directly to stdout.  Prefer the on-disk
      // file if it exists and looks like real markdown content.
      let issueMd;
      if (existsSync(issuePath)) {
        const onDisk = readFileSync(issuePath, "utf8").trim();
        if (onDisk.length > 40 && onDisk.startsWith("#")) {
          issueMd = onDisk + "\n";
        }
      }
      if (!issueMd) {
        issueMd = res.stdout.trimEnd() + "\n";
        writeFileSync(issuePath, issueMd);
      }

      state.steps.wroteIssue = true;
      this._saveState(state);

      return { issueMd };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Step 3: Create Plan ---

  /**
   * Have Claude write PLAN.md, then run built-in plan review (Gemini) to critique it.
   * Requires ISSUE.md to exist.
   * @returns {Promise<{ planMd: string, critiqueMd: string }>}
   */
  async createPlan() {
    try {
      const state = this._loadState();
      state.steps ||= {};
      const paths = this._artifactPaths();

      // Reconcile from artifacts
      if (existsSync(paths.issue)) state.steps.wroteIssue = true;
      if (!state.steps.wroteIssue) {
        throw new Error("Precondition failed: ISSUE.md does not exist. Run coder_draft_issue first.");
      }

      this._ensureBranch(state);

      this.log({ event: "step3_create_plan" });
      const claude = this._getClaude();

      // Step 3a: Claude writes PLAN.md
      if (!state.steps.wrotePlan) {
        // Generate a session ID for Claude session reuse across steps
        if (!state.claudeSessionId) {
          state.claudeSessionId = randomUUID();
          this._saveState(state);
        }

        const planPrompt = `You are planning an implementation. Follow this structured approach:

## Phase 1: Research (MANDATORY)
Before writing any plan:
1. Read ${paths.issue} completely
2. Search the codebase to understand existing patterns, conventions, and architecture
3. For any external dependencies mentioned:
   - Verify they exist and are actively maintained
   - Read their actual documentation (not your training data)
   - Confirm the APIs you plan to use actually exist
4. Identify similar existing implementations in this codebase to use as templates

## Phase 2: Evaluate Approaches
Consider at least 2 different approaches. For each:
- Pros/cons
- Complexity
- Alignment with existing patterns

Select the simplest approach that solves the problem.

## Phase 3: Write Plan to ${paths.plan}

Structure:
1. **Summary**: One paragraph describing what will change
2. **Approach**: Which approach and why (reference existing patterns)
3. **Files to Modify**: List each file with specific changes
4. **Files to Create**: Only if absolutely necessary (prefer modifying existing files)
5. **Dependencies**: Any new dependencies with version and justification
6. **Testing**: How to verify the implementation works
7. **Out of Scope**: Explicitly list what this change does NOT include

## Complexity Budget
- Prefer modifying 1-3 files over touching many files
- Prefer using existing utilities over creating new abstractions
- Prefer inline code over new helper functions for one-time operations
- Prefer direct solutions over configurable/extensible patterns

## Anti-Patterns to AVOID
- Do NOT add abstractions "for future flexibility"
- Do NOT create wrapper classes/functions around simple operations
- Do NOT add configuration options that aren't requested
- Do NOT refactor unrelated code
- Do NOT add error handling for impossible scenarios

Constraints:
- Do NOT implement code yet
- Do NOT modify any tracked files (only write ${paths.plan})
- Do NOT invent APIs - verify they exist in actual documentation
- Do NOT ask questions; use repo conventions and ISSUE.md as ground truth`;

        const cmd = heredocPipe(
          planPrompt,
          `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --session-id ${state.claudeSessionId}`,
        );
        const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 20 });
        if (res.exitCode !== 0) throw new Error("Claude plan generation failed.");

        // Hard gate: Claude must not change the repo during planning.
        const repoRoot = this._repoRoot(state);
        const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
        if (status.status !== 0) throw new Error("Failed to check git status after planning.");
        const artifactFiles = [this.issueFile, this.planFile, this.critiqueFile, ".coder/"];
        const dirtyLines = (status.stdout || "")
          .split("\n")
          .filter((l) => l.trim() !== "" && !artifactFiles.some((a) => l.includes(a)));
        if (dirtyLines.length > 0) {
          throw new Error(`Planning step modified the repository. Aborting.\n${dirtyLines.join("\n")}`);
        }

        if (!existsSync(paths.plan)) throw new Error(`PLAN.md not found: ${paths.plan}`);
        state.steps.wrotePlan = true;
        this._saveState(state);
      }

      // Step 3b: built-in plan review (Gemini)
      if (!state.steps.wroteCritique) {
        const rc = runPlanreview(this._repoRoot(state), paths.plan, paths.critique);
        if (rc !== 0) this.log({ event: "plan_review_nonzero", exitCode: rc });
        state.steps.wroteCritique = true;
        this._saveState(state);
      }

      const planMd = existsSync(paths.plan) ? readFileSync(paths.plan, "utf8") : "";
      const critiqueMd = existsSync(paths.critique) ? readFileSync(paths.critique, "utf8") : "";

      return { planMd, critiqueMd };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Step 4: Implement ---

  /**
   * Have Claude implement the feature based on PLAN.md + PLANREVIEW.md.
   * @returns {Promise<{ summary: string }>}
   */
  async implement() {
    try {
      const state = this._loadState();
      state.steps ||= {};
      const paths = this._artifactPaths();

      if (!state.steps.wrotePlan || !state.steps.wroteCritique) {
        throw new Error("Precondition failed: PLAN.md and PLANREVIEW.md must exist. Run coder_create_plan first.");
      }

      this._ensureBranch(state);

      if (state.steps.implemented) {
        return { summary: "Implementation already completed (cached)." };
      }

      this.log({ event: "step4_implement" });
      const claude = this._getClaude();

      // Gather branch context for recovery (Feature 9)
      const repoRoot = this._repoRoot(state);
      const branchDiff = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
      const gitLog = spawnSync("git", ["log", "--oneline", "-5"], { cwd: repoRoot, encoding: "utf8" });
      const uncommitted = (branchDiff.stdout || "").trim() || "(none)";
      const recentCommits = (gitLog.stdout || "").trim() || "(none)";

      const recoveryContext = `IMPORTANT — Check for existing work on this branch before starting.
Uncommitted changes:
${uncommitted}

Recent commits:
${recentCommits}

Build upon existing correct work. Do not duplicate or revert it.

`;

      const implPrompt = `${recoveryContext}Read ${paths.plan} and ${paths.critique}.

## Step 1: Address Critique
Update ${paths.plan} to address any Critical Issues or Over-Engineering Concerns from the critique.
If critique says REJECT, revise the plan significantly before proceeding.

## Step 2: Implement
Implement the feature following the plan.

## STRICT Requirements

### Match Existing Patterns
- Study similar code in this repo BEFORE writing
- Copy the EXACT style: naming, formatting, error handling, comments
- If the codebase doesn't have docstrings, don't add them
- If the codebase uses terse variable names, use terse names

### Minimize Changes
- Only modify files listed in the plan
- Only add code that directly implements the feature
- Delete any code that becomes unused
- Prefer fewer lines over "cleaner" abstractions

### NO Tutorial Comments
FORBIDDEN comment patterns:
- "First, we..." / "Now we..." / "Next, we..."
- "This function does X" (obvious from the code)
- "Step 1:", "Step 2:", etc.
- Comments explaining what the next line does
- Comments that restate the function name

ALLOWED comments:
- Non-obvious business logic explanations
- Workaround explanations with ticket/issue references
- Performance optimization explanations
- Regex explanations

### NO Over-Engineering
FORBIDDEN patterns:
- Creating interfaces/base classes for single implementations
- Adding configuration for single use cases
- Factory functions for simple object creation
- Wrapper functions that just call one other function
- Error handling for impossible code paths
- Logging for debugging that won't ship

### Scope Discipline
- If you notice something that "should" be fixed but isn't in the issue, DON'T fix it
- If you think of a "nice to have" feature, DON'T add it
- If code could be "cleaner" with a refactor, DON'T refactor unless required

### Code Quality
- Fix root causes, no hacks
- Do not bypass tests
- Use the repo's normal commands (lint, format, test)`;

      // Session reuse: resume from planning context if available
      let claudeFlags = `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`;
      if (state.claudeSessionId) {
        claudeFlags += ` --resume ${state.claudeSessionId}`;
      }

      const cmd = heredocPipe(implPrompt, claudeFlags);
      const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 60 });
      if (res.exitCode !== 0) throw new Error("Claude implementation failed.");

      state.steps.implemented = true;
      this._saveState(state);

      // Summarize changes
      const diffStat = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd: this._repoRoot(state), encoding: "utf8" });
      const summary = (diffStat.stdout || "").trim() || "Implementation completed (no diff stat available).";

      return { summary };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Step 5: Review and Test ---

  /**
   * Have Codex review changes, run ppcommit, fix issues, run tests.
   * @returns {Promise<{ ppcommitStatus: string, testResults: object }>}
   */
  async reviewAndTest() {
    try {
      const state = this._loadState();
      state.steps ||= {};

      if (!state.steps.implemented) {
        throw new Error("Precondition failed: implementation not complete. Run coder_implement first.");
      }

      this._ensureBranch(state);

      const workDir = this._repoRoot(state);

      // Step 5a: Codex review + ppcommit fix
      if (!state.steps.codexReviewed) {
        this.log({ event: "step5_review" });
        const codex = this._getCodex();

        const ppBefore = runPpcommit(workDir);
        this.log({ event: "ppcommit_before", exitCode: ppBefore.exitCode });

        const ppOutput = (ppBefore.stdout || ppBefore.stderr || "").trim();
        const ppSection = ppBefore.exitCode === 0
          ? `ppcommit passed (no issues). Focus on code review.`
          : `ppcommit found issues — fix ALL of them:\n---\n${ppOutput}\n---`;

        const codexPrompt = `You are reviewing uncommitted changes for commit readiness.
Read ISSUE.md to understand what was originally requested.

## Checklist

### 1. Scope Conformance
- Does the change ONLY implement what ISSUE.md requested?
- Are there any unrequested features added? (Remove them)
- Are there any unrelated refactors? (Revert them)
- Were more files modified than necessary? (Consolidate if possible)

### 2. Completeness
- Is the implementation fully complete? No stubs, no TODOs, no placeholders
- Are there test bypasses or skipped tests? (Fix them)
- Does it solve the problem directly without workarounds?

### 3. Code Quality
- Is this the SIMPLEST solution that works?
- Are there unnecessary abstractions? (Inline them)
- Are there wrapper functions that just call one thing? (Inline them)
- Are there interfaces/base classes with single implementations? (Remove them)
- Are there configuration options for single use cases? (Remove them)

### 4. Comment Hygiene
Look for and REMOVE these comment patterns:
- Tutorial-style: "First we...", "Now we...", "Step N:"
- Restating code: "// increment counter" above counter++
- Obvious descriptions: "// Constructor" above constructor
- Narration: "Here we define...", "This function..."
Keep only: non-obvious logic explanations, workaround refs, performance notes

### 5. Backwards-Compat Hacks
Look for and REMOVE these patterns:
- Variables renamed to start with \`_\` but not used
- Re-exports of removed items for compatibility
- \`// removed\` or \`// deprecated\` comments for deleted code
- Empty functions kept for interface compatibility
If something is unused, DELETE it completely.

### 6. Correctness
- Edge cases handled appropriately
- No off-by-one errors
- Uses industry-standard libraries where appropriate
- Error handling only for errors that can actually occur

## ppcommit (commit hygiene)
${ppSection}
${ppBefore.exitCode === 0 ? "ppcommit is clean." : "Fix ALL ppcommit issues."} Coder will re-run built-in ppcommit checks after your changes (do not assume a ppcommit CLI exists).

Then run the repo's standard lint/format/test commands and fix any failures.

Hard constraints:
- Never bypass tests or reduce coverage/quality
- If a command fails, fix the underlying issue and re-run until it passes
- Remove ALL unnecessary code, comments, and abstractions`;

        const cmd = `codex exec --full-auto --skip-git-repo-check ${JSON.stringify(codexPrompt)}`;
        const res = await codex.executeCommand(cmd, { timeoutMs: 1000 * 60 * 90 });
        if (res.exitCode !== 0) throw new Error("Codex review/fix failed.");
        state.steps.codexReviewed = true;
        this._saveState(state);
      }

      // Hard gate: ppcommit must be clean
      const ppAfter = runPpcommit(workDir);
      if (ppAfter.exitCode !== 0) {
        throw new Error(`ppcommit still reports issues after Codex pass:\n${ppAfter.stdout || ppAfter.stderr}`);
      }
      state.steps.ppcommitClean = true;
      this._saveState(state);

      // Hard gate: tests must pass
      const testRes = await runHostTests(workDir, {
        testCmd: this.testCmd,
        testConfigPath: this.testConfigPath,
        allowNoTests: this.allowNoTests,
      });
      if (testRes.exitCode !== 0) {
        throw new Error(`Tests failed after Codex pass:\n${testRes.stdout}\n${testRes.stderr}`);
      }
      state.steps.testsPassed = true;
      this._saveState(state);

      return {
        ppcommitStatus: "clean",
        testResults: {
          cmd: testRes.cmd,
          exitCode: testRes.exitCode,
          passed: testRes.exitCode === 0,
        },
      };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Step 6: Finalize ---

  /**
   * Claude runs final tests and updates ISSUE.md with completion status.
   * @returns {Promise<{ branch: string, status: string }>}
   */
  async finalize() {
    try {
      const state = this._loadState();
      state.steps ||= {};

      if (!state.steps.testsPassed) {
        throw new Error("Precondition failed: tests have not passed. Run coder_review_and_test first.");
      }

      this._ensureBranch(state);

      if (state.steps.finalized) {
        return {
          branch: state.branch,
          status: "already finalized",
        };
      }

      this.log({ event: "step6_finalize" });
      const paths = this._artifactPaths();
      const claude = this._getClaude();

      const statusPrompt = `Run the repo's standard tests relevant to this change and ensure they pass.
Then update ${paths.issue} with completion status and readiness to push. Do not claim tests passed unless they actually did.`;

      // Session reuse: resume from implementation context if available
      let claudeFlags = `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`;
      if (state.claudeSessionId) {
        claudeFlags += ` --resume ${state.claudeSessionId}`;
      }

      const cmd = heredocPipe(statusPrompt, claudeFlags);
      const res = await claude.executeCommand(cmd, { timeoutMs: 1000 * 60 * 15 });
      if (res.exitCode !== 0) throw new Error("Claude final pass failed.");

      state.steps.finalized = true;
      this._saveState(state);

      this.log({ event: "done", branch: state.branch });

      return {
        branch: state.branch,
        status: "finalized",
      };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Step 7: Create PR ---

  /**
   * Create a pull request from the feature branch.
   * @param {{ type?: string, semanticName?: string, title?: string, description?: string }} params
   * @returns {Promise<{ prUrl: string, branch: string }>}
   */
  async createPR({ type = "feat", semanticName, title, description } = {}) {
    try {
      const state = this._loadState();
      state.steps ||= {};

      if (!state.steps.finalized && !state.steps.testsPassed) {
        throw new Error(
          "Precondition failed: tests have not passed or workflow not finalized. " +
            "Run coder_review_and_test or coder_finalize first.",
        );
      }

      if (!state.steps.ppcommitClean) {
        throw new Error(
          "Precondition failed: ppcommit has not passed. " +
            "Run coder_review_and_test first to get a clean ppcommit check.",
        );
      }

      // Early return if PR already created
      if (state.steps.prCreated && state.prUrl) {
        return { prUrl: state.prUrl, branch: state.prBranch || state.branch };
      }

      this._ensureBranch(state);
      const repoRoot = this._repoRoot(state);

      // Commit any uncommitted changes before pushing
      const status = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const hasChanges = (status.stdout || "").trim().length > 0;
      if (hasChanges) {
        const add = spawnSync("git", ["add", "-A"], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        if (add.status !== 0) {
          throw new Error(`git add failed: ${add.stderr}`);
        }

        const issueTitle = state.selected?.title || "coder workflow changes";
        const commitMsg = `${type}: ${issueTitle}`;
        const commit = spawnSync("git", ["commit", "-m", commitMsg], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        if (commit.status !== 0) {
          throw new Error(`git commit failed: ${commit.stderr}`);
        }
        this.log({ event: "committed", message: commitMsg });
      }

      // Determine remote branch
      const remoteBranch = semanticName
        ? `${type}/${sanitizeBranchForRef(semanticName)}`
        : state.branch;

      // Push to remote
      const push = spawnSync("git", ["push", "-u", "origin", `HEAD:${remoteBranch}`], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (push.status !== 0) {
        throw new Error(`git push failed: ${push.stderr}`);
      }

      // Build PR body
      let body = description || "";
      if (!body) {
        const paths = this._artifactPaths();
        if (existsSync(paths.issue)) {
          const issueMd = readFileSync(paths.issue, "utf8");
          body = issueMd.split("\n").slice(0, 10).join("\n");
        }
      }

      // Append issue link
      if (state.selected) {
        const { source, id } = state.selected;
        if (source === "github") {
          const normalized = String(id).trim();
          body += normalized.includes("#") ? `\n\nCloses ${normalized}` : `\n\nCloses #${normalized}`;
        } else if (source === "linear") {
          body += `\n\nResolves ${id}`;
        }
      }

      // Default title
      const prTitle = title || `${type}: ${state.selected?.title || semanticName || state.branch}`;

      // Create PR (gh pr create outputs the PR URL directly to stdout)
      const pr = spawnSync(
        "gh",
        ["pr", "create", "--head", remoteBranch, "--title", prTitle, "--body", body],
        { cwd: repoRoot, encoding: "utf8" },
      );
      if (pr.status !== 0) {
        throw new Error(`gh pr create failed: ${pr.stderr || pr.stdout}`);
      }

      // gh pr create outputs the URL on the last line of stdout
      const raw = (pr.stdout || "").trim();
      const lines = raw.split("\n").filter((l) => l.trim());
      const prUrl = lines.find((l) => l.startsWith("http")) || lines.pop() || "";
      if (!prUrl || !prUrl.startsWith("http")) {
        throw new Error(`gh pr create did not return a PR URL. Output:\n${raw || "(empty)"}`);
      }

      state.prUrl = prUrl;
      state.prBranch = remoteBranch;
      state.steps.prCreated = true;
      this._saveState(state);

      this.log({ event: "pr_created", prUrl, branch: remoteBranch });

      return { prUrl, branch: remoteBranch };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Status ---

  /**
   * Get current workflow state.
   * @returns {object}
   */
  getStatus() {
    const state = this._loadState();
    const paths = this._artifactPaths();

    // Reconcile artifact presence
    state.steps ||= {};
    if (existsSync(paths.issue)) state.steps.wroteIssue = true;
    if (existsSync(paths.plan)) state.steps.wrotePlan = true;
    if (existsSync(paths.critique)) state.steps.wroteCritique = true;

    // Read activity file if it exists (Feature 7)
    const activityPath = path.join(this.workspaceDir, ".coder", "activity.json");
    let agentActivity = null;
    if (existsSync(activityPath)) {
      try {
        const raw = JSON.parse(readFileSync(activityPath, "utf8"));
        agentActivity = {};
        for (const [name, info] of Object.entries(raw)) {
          const idleMs = info.lastActivityTs ? Date.now() - info.lastActivityTs : null;
          agentActivity[name] = {
            ...info,
            idleMs,
            status: idleMs !== null && idleMs > 10_000 ? "idle" : (info.status || "active"),
          };
        }
      } catch {
        // best-effort
      }
    }

    return {
      version: state.version,
      selected: state.selected,
      selectedProject: state.selectedProject,
      repoPath: state.repoPath,
      branch: state.branch,
      steps: state.steps,
      lastError: state.lastError,
      prUrl: state.prUrl,
      prBranch: state.prBranch,
      artifacts: {
        issueExists: existsSync(paths.issue),
        planExists: existsSync(paths.plan),
        critiqueExists: existsSync(paths.critique),
      },
      agentActivity,
    };
  }

  async cleanup() {
    await closeAllLoggers();
  }
}
