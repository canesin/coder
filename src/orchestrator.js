import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import process from "node:process";

import { HostSandboxProvider } from "./host-sandbox.js";
import { ensureLogsDir, makeJsonlLogger, closeAllLoggers } from "./logging.js";

/**
 * Thin wrapper around HostSandboxProvider that exposes the executeCommand()
 * and EventEmitter interface the orchestrator expects.
 */
class AgentRunner extends EventEmitter {
  constructor(provider) {
    super();
    this._provider = provider;
    this._sandbox = null;
  }

  async executeCommand(command, opts = {}) {
    if (!this._sandbox) {
      this._sandbox = await this._provider.create();
      this._sandbox.on("stdout", (d) => this.emit("stdout", d));
      this._sandbox.on("stderr", (d) => this.emit("stderr", d));
    }
    return this._sandbox.commands.run(command, opts);
  }
}
import { loadState, saveState, loadLoopState, saveLoopState, statePathFor } from "./state.js";
import { sanitizeBranchForRef } from "./worktrees.js";
import { IssuesPayloadSchema, QuestionsPayloadSchema, ProjectsPayloadSchema } from "./schemas.js";
import {
  buildSecrets,
  extractJson,
  extractGeminiPayloadJson,
  heredocPipe,
  geminiJsonPipe,
  gitCleanOrThrow,
  runPlanreview,
  runPpcommit,
  runHostTests,
  formatCommandFailure,
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
      const provider = new HostSandboxProvider({ defaultCwd: this.workspaceDir, baseEnv: this.secrets });
      this._gemini = new AgentRunner(provider);
      this._attachAgentLogging("gemini", this._gemini);
    }
    return this._gemini;
  }

  _makeRepoAgent(name) {
    const state = this._loadState();
    const repoRoot = path.resolve(this.workspaceDir, state.repoPath);

    const provider = new HostSandboxProvider({ defaultCwd: repoRoot, baseEnv: this.secrets });
    const agent = new AgentRunner(provider);
    this._attachAgentLogging(name, agent);
    return agent;
  }

  _getClaude() {
    if (!this._claude) {
      this._claude = this._makeRepoAgent("claude");
    }
    return this._claude;
  }

  _getCodex() {
    if (!this._codex) {
      this._codex = this._makeRepoAgent("codex");
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
   * @param {object} agent - AgentRunner instance
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
      if (this.secrets.LINEAR_API_KEY && (!state.steps.listedProjects || !state.linearProjects)) {
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
        if (projRes.exitCode !== 0) {
          throw new Error(formatCommandFailure("Gemini project listing failed", projRes));
        }
        const projPayload = ProjectsPayloadSchema.parse(extractGeminiPayloadJson(projRes.stdout));
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
      if (res.exitCode !== 0) {
        throw new Error(formatCommandFailure("Gemini issue listing failed", res));
      }
      const issuesPayload = IssuesPayloadSchema.parse(extractGeminiPayloadJson(res.stdout));

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
   * @param {{ issue: { source: string, id: string, title: string }, repoPath: string, clarifications: string, baseBranch?: string }} params
   * @returns {Promise<{ issueMd: string }>}
   */
  async draftIssue({ issue, repoPath, clarifications, baseBranch, force }) {
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
      state.baseBranch = baseBranch || null;
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

      // Optional stacked-base checkout for dependency chains.
      if (state.baseBranch) {
        const baseCheckout = spawnSync("git", ["checkout", state.baseBranch], {
          cwd: repoRoot,
          encoding: "utf8",
        });
        if (baseCheckout.status !== 0) {
          throw new Error(
            `Failed to checkout base branch ${state.baseBranch} before creating ${state.branch}: ` +
              `${baseCheckout.stderr || baseCheckout.stdout}`,
          );
        }
      }

      // Create/checkout the feature branch
      this._ensureBranch(state);

      // Draft ISSUE.md
      this.log({ event: "step2_draft_issue", issue });
      const { issue: issuePath } = this._artifactPaths();
      const gemini = this._getGemini();

      const issuePrompt = `Draft an ISSUE.md for the chosen issue. Use the local codebase in ${repoRoot} as ground truth.

Chosen issue:
- source: ${issue.source}
- id: ${issue.id}
- title: ${issue.title}
- repo_root: ${repoRoot}

Clarifications from user:
${clarifications || "(none provided)"}

Output ONLY markdown suitable for writing directly to ISSUE.md.

## Required Sections (in order)
1. **Metadata**: Source, Issue ID, Repo Root (relative path)
2. **Problem**: What's wrong or missing — reference specific files/functions
3. **Changes**: Exactly which files need to change and how
4. **Verification**: A concrete shell command or test to prove the fix works (e.g. \`npm test\`, \`node -e "..."\`, \`curl ...\`). This is critical — downstream agents use this to close the feedback loop.
5. **Out of Scope**: What this does NOT include
`;

      const cmd = heredocPipe(issuePrompt, "gemini --yolo");
      const res = await gemini.executeCommand(cmd, { timeoutMs: 1000 * 60 * 10 });
      if (res.exitCode !== 0) {
        throw new Error(formatCommandFailure("Gemini ISSUE.md drafting failed", res));
      }

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
   * @param {{ type?: string, semanticName?: string, title?: string, description?: string, base?: string }} params
   * @returns {Promise<{ prUrl: string, branch: string, base: string | null }>}
   */
  async createPR({ type = "feat", semanticName, title, description, base } = {}) {
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
        return { prUrl: state.prUrl, branch: state.prBranch || state.branch, base: state.prBase || state.baseBranch || null };
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
      const baseBranch = base || state.baseBranch || null;

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
      const prArgs = ["pr", "create", "--head", remoteBranch, "--title", prTitle, "--body", body];
      if (baseBranch) prArgs.push("--base", baseBranch);
      const pr = spawnSync("gh", prArgs, { cwd: repoRoot, encoding: "utf8" });
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
      state.prBase = baseBranch;
      state.steps.prCreated = true;
      this._saveState(state);

      this.log({ event: "pr_created", prUrl, branch: remoteBranch, base: baseBranch });

      return { prUrl, branch: remoteBranch, base: baseBranch };
    } catch (err) {
      this._recordError(err);
      throw err;
    }
  }

  // --- Autonomous loop helpers ---

  /**
   * Append a structured entry to .coder/logs/auto.jsonl.
   */
  _appendAutoLog(entry) {
    const logPath = path.join(this.workspaceDir, ".coder", "logs", "auto.jsonl");
    ensureLogsDir(this.workspaceDir);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(logPath, line + "\n");
  }

  /**
   * Clean slate between issues: delete per-issue state/artifacts,
   * checkout main branch, discard uncommitted changes, and destroy
   * agent instances to prevent context pollution.
   */
  _resetForNextIssue(repoPath, { destructive = false } = {}) {
    // Delete per-issue workflow state
    const statePath = statePathFor(this.workspaceDir);
    if (existsSync(statePath)) unlinkSync(statePath);

    // Delete workflow artifacts
    const artifacts = [this.issueFile, this.planFile, this.critiqueFile];
    for (const name of artifacts) {
      const p = path.join(this.workspaceDir, name);
      if (existsSync(p)) unlinkSync(p);
    }

    // Checkout default branch and optionally clean changes in the repo
    if (repoPath) {
      const repoRoot = path.resolve(this.workspaceDir, repoPath);
      if (existsSync(repoRoot)) {
        // Determine default branch
        let defaultBranch = "main";
        const originHead = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
          cwd: repoRoot, encoding: "utf8",
        });
        if (originHead.status === 0) {
          const raw = (originHead.stdout || "").trim();
          if (raw.startsWith("origin/") && raw.length > "origin/".length) {
            defaultBranch = raw.slice("origin/".length);
          }
        } else {
          const mainCheck = spawnSync("git", ["rev-parse", "--verify", "main"], {
            cwd: repoRoot, encoding: "utf8",
          });
          defaultBranch = mainCheck.status === 0 ? "main" : "master";
        }

        const checkout = spawnSync("git", ["checkout", defaultBranch], { cwd: repoRoot, encoding: "utf8" });
        if (checkout.status !== 0) {
          this._appendAutoLog({
            event: "reset_warning",
            repoPath,
            error: `Could not checkout ${defaultBranch}: ${checkout.stderr || checkout.stdout}`,
          });
        }

        const status = spawnSync("git", ["status", "--porcelain"], {
          cwd: repoRoot, encoding: "utf8",
        });
        if (status.status === 0) {
          const isDirty = ((status.stdout || "").trim().length > 0);
          if (isDirty && destructive) {
            const restore = spawnSync("git", ["restore", "--staged", "--worktree", "."], {
              cwd: repoRoot, encoding: "utf8",
            });
            if (restore.status !== 0) {
              spawnSync("git", ["checkout", "--", "."], { cwd: repoRoot, encoding: "utf8" });
            }
            spawnSync("git", ["clean", "-fd"], { cwd: repoRoot, encoding: "utf8" });
          } else if (isDirty) {
            this._appendAutoLog({
              event: "reset_dirty_repo",
              repoPath,
              mode: "safe",
              message:
                "Repo has uncommitted changes. Skipping destructive cleanup. " +
                "Use coder_auto with destructiveReset=true to force cleanup.",
            });
          }
        }
      }
    }

    // Destroy agent instances — forces fresh sessions per issue
    this._gemini = null;
    this._claude = null;
    this._codex = null;
  }

  // --- Autonomous loop ---

  /**
   * Use Gemini to filter issues by goal, analyze dependencies, and produce an
   * ordered queue. Returns the raw queue array ready for loop-state.
   */
  async _buildAutoQueue(issues, goal, maxIssues) {
    const gemini = this._getGemini();

    const issueList = issues.map((iss) =>
      `- [${iss.source}#${iss.id}] "${iss.title}" (difficulty: ${iss.difficulty || "?"})`
    ).join("\n");

    const prompt = `You are an engineering manager triaging a batch of issues for autonomous processing.

## User's goal
${goal}

## Available issues
${issueList}

## Your task
1. **Filter**: Only include issues relevant to the user's goal. If the goal is generic (e.g. "resolve all assigned issues"), include all issues.
2. **Analyze dependencies**: Determine if any issue depends on another being completed first. For example, if issue A adds a monitoring API and issue B adds dashboards that consume that API, then B depends on A.
3. **Sort**: Produce a topological order — dependencies before dependents. Among independent issues, sort by difficulty ascending (easy wins first).
${maxIssues ? `4. **Limit**: Return at most ${maxIssues} issues.` : ""}

Return ONLY valid JSON in this schema:
{
  "queue": [
    {
      "source": "github" | "linear",
      "id": "string",
      "title": "string",
      "repo_path": "string",
      "depends_on": ["source#id"],
      "reason": "short explanation of why included and ordering rationale"
    }
  ],
  "excluded": [
    { "id": "string", "reason": "why excluded" }
  ]
}`;

    const cmd = geminiJsonPipe(prompt);
    const res = await this._executeWithRetry(gemini, cmd, { timeoutMs: 1000 * 60 * 5, retries: 1 });

    // Best-effort parse — fall back to difficulty sort if Gemini fails
    try {
      if (res.exitCode !== 0) throw new Error(formatCommandFailure("Gemini queue building failed", res));
      const payload = extractGeminiPayloadJson(res.stdout);
      if (!payload?.queue || !Array.isArray(payload.queue)) throw new Error("Invalid queue payload");

      // Build lookups from the original issues
      const repoPathMap = new Map(issues.map((iss) => [`${iss.source}#${iss.id}`, iss.repo_path || ""]));
      const refsById = new Map();
      for (const iss of issues) {
        const key = String(iss.id);
        const ref = `${iss.source}#${iss.id}`;
        const refs = refsById.get(key) || [];
        refs.push(ref);
        refsById.set(key, refs);
      }

      const normalizeDepRef = (dep, fallbackSource) => {
        const raw = String(dep || "").trim();
        if (!raw) return null;
        if (raw.includes("#")) return raw;
        const matches = refsById.get(raw) || [];
        if (matches.length === 1) return matches[0];
        return `${fallbackSource}#${raw}`;
      };

      const queue = payload.queue.map((item) => ({
        source: item.source,
        id: item.id,
        title: item.title,
        repoPath: item.repo_path || repoPathMap.get(`${item.source}#${item.id}`) || "",
        baseBranch: null,
        status: "pending",
        branch: null,
        prUrl: null,
        error: null,
        startedAt: null,
        completedAt: null,
        dependsOn: Array.isArray(item.depends_on)
          ? item.depends_on
            .map((dep) => normalizeDepRef(dep, item.source))
            .filter((dep) => !!dep)
          : [],
      }));

      this._appendAutoLog({
        event: "queue_built",
        method: "gemini",
        total: queue.length,
        excluded: payload.excluded?.length || 0,
      });
      if (maxIssues) {
        queue.splice(maxIssues);
      }
      return queue;
    } catch {
      this._appendAutoLog({ event: "queue_fallback", reason: "Gemini queue building failed, using difficulty sort" });
    }

    // Fallback: difficulty sort, no dependency analysis
    const sorted = [...issues].sort((a, b) => (a.difficulty || 3) - (b.difficulty || 3));
    return sorted.slice(0, maxIssues || sorted.length).map((iss) => ({
      source: iss.source,
      id: iss.id,
      title: iss.title,
      repoPath: iss.repo_path || "",
      baseBranch: null,
      status: "pending",
      branch: null,
      prUrl: null,
      error: null,
      startedAt: null,
      completedAt: null,
      dependsOn: [],
    }));
  }

  /**
   * Process multiple assigned issues end-to-end without human intervention.
   * Uses the goal prompt to filter and dependency-sort the issue queue via Gemini.
   * Issues whose dependencies failed are automatically skipped.
   * @param {{ goal?: string, projectFilter?: string, maxIssues?: number, testCmd?: string, testConfigPath?: string, allowNoTests?: boolean, destructiveReset?: boolean }} opts
   * @returns {Promise<{ status: string, completed: number, failed: number, skipped: number, results: Array }>}
   */
  async runAuto({
    goal = "resolve all assigned issues",
    projectFilter,
    maxIssues,
    testCmd,
    testConfigPath,
    allowNoTests,
    destructiveReset = false,
  } = {}) {
    if (maxIssues !== undefined && maxIssues !== null) {
      if (!Number.isInteger(maxIssues) || maxIssues < 1) {
        throw new Error("maxIssues must be an integer >= 1.");
      }
    }

    if (testCmd) this.testCmd = testCmd;
    if (testConfigPath) this.testConfigPath = testConfigPath;
    if (allowNoTests) this.allowNoTests = allowNoTests;

    let loopState = loadLoopState(this.workspaceDir);

    // Phase 1: Build queue (skip if resuming a running loop)
    if (loopState.status !== "running" || loopState.issueQueue.length === 0) {
      this._appendAutoLog({ event: "auto_start", goal, projectFilter, maxIssues, destructiveReset });

      const listResult = await this.listIssues({ projectFilter });
      const queue = await this._buildAutoQueue(listResult.issues, goal, maxIssues);

      loopState = {
        version: 1,
        goal,
        status: "running",
        projectFilter: projectFilter || null,
        maxIssues: maxIssues || null,
        issueQueue: queue,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      saveLoopState(this.workspaceDir, loopState);

      // Reset per-issue state from listIssues call
      this._resetForNextIssue("", { destructive: destructiveReset });
    } else {
      this._appendAutoLog({ event: "auto_resume", currentIndex: loopState.currentIndex });
    }

    const issueRef = (entry) => `${entry.source}#${entry.id}`;
    const refsById = new Map();
    for (const item of loopState.issueQueue) {
      const key = String(item.id);
      const refs = refsById.get(key) || [];
      refs.push(issueRef(item));
      refsById.set(key, refs);
    }
    const normalizeDepRef = (dep, fallbackSource) => {
      const raw = String(dep || "").trim();
      if (!raw) return null;
      if (raw.includes("#")) return raw;
      const matches = refsById.get(raw) || [];
      if (matches.length === 1) return matches[0];
      return `${fallbackSource}#${raw}`;
    };

    // Track failed issue refs for dependency-aware skipping
    const failedRefs = new Set(
      loopState.issueQueue
        .filter((e) => e.status === "failed")
        .map((e) => issueRef(e)),
    );

    // Phase 2: Loop through issues
    for (let i = loopState.currentIndex; i < loopState.issueQueue.length; i++) {
      const entry = loopState.issueQueue[i];
      loopState.currentIndex = i;

      if (entry.status === "completed" || entry.status === "failed" || entry.status === "skipped") {
        loopState.currentIndex = i + 1;
        saveLoopState(this.workspaceDir, loopState);
        continue;
      }

      const dependencyRefs = (entry.dependsOn || [])
        .map((dep) => normalizeDepRef(dep, entry.source))
        .filter((dep) => !!dep);
      entry.dependsOn = dependencyRefs;

      // Dependency check: skip if any dependency failed
      if (dependencyRefs.length > 0) {
        const blockedBy = dependencyRefs.filter((depRef) => failedRefs.has(depRef));
        if (blockedBy.length > 0) {
          entry.status = "skipped";
          entry.error = `Skipped: depends on failed issue(s) ${blockedBy.join(", ")}`;
          entry.completedAt = new Date().toISOString();
          this._appendAutoLog({ event: "issue_skipped", index: i, id: entry.id, blockedBy });
          loopState.currentIndex = i + 1;
          saveLoopState(this.workspaceDir, loopState);
          continue;
        }

        // Also skip if a dependency is still pending (shouldn't happen with topo sort, but guard)
        const unresolved = dependencyRefs.filter((depRef) => {
          const dep = loopState.issueQueue.find((e) => issueRef(e) === depRef);
          return !dep || dep.status !== "completed";
        });
        if (unresolved.length > 0) {
          entry.status = "skipped";
          entry.error = `Skipped: unresolved dependencies ${unresolved.join(", ")}`;
          entry.completedAt = new Date().toISOString();
          this._appendAutoLog({ event: "issue_skipped", index: i, id: entry.id, unresolved });
          loopState.currentIndex = i + 1;
          saveLoopState(this.workspaceDir, loopState);
          continue;
        }
      }

      let autoBaseBranch = null;
      if (dependencyRefs.length > 0) {
        const depEntries = dependencyRefs
          .map((depRef) => loopState.issueQueue.find((e) => issueRef(e) === depRef))
          .filter((dep) => !!dep);
        const branchDeps = depEntries.filter((dep) => dep.branch).map((dep) => dep.branch);
        if (branchDeps.length === 0) {
          entry.status = "skipped";
          entry.error = "Skipped: dependencies completed but no dependency branch was available for stacked mode.";
          entry.completedAt = new Date().toISOString();
          this._appendAutoLog({ event: "issue_skipped", index: i, id: entry.id, reason: "missing_dependency_branch" });
          loopState.currentIndex = i + 1;
          saveLoopState(this.workspaceDir, loopState);
          continue;
        }
        autoBaseBranch = branchDeps[0];
        if (branchDeps.length > 1) {
          this._appendAutoLog({
            event: "multi_dependency_base_selected",
            index: i,
            id: entry.id,
            selectedBase: autoBaseBranch,
            availableBases: branchDeps,
          });
        }
      }
      entry.baseBranch = autoBaseBranch;

      entry.status = "in_progress";
      entry.startedAt = new Date().toISOString();
      saveLoopState(this.workspaceDir, loopState);

      this._appendAutoLog({ event: "issue_start", index: i, id: entry.id, title: entry.title });

      try {
        await this.draftIssue({
          issue: { source: entry.source, id: entry.id, title: entry.title },
          repoPath: entry.repoPath,
          baseBranch: autoBaseBranch || undefined,
          clarifications: `Auto-mode (no human in the loop). Goal: ${goal}. ` +
            `You MUST include a concrete verification command in the Verification section. ` +
            `Do not ask questions — use repo conventions and the codebase as ground truth.`,
          force: true,
        });

        await this.createPlan();
        await this.implement();
        await this.reviewAndTest();
        await this.finalize();

        let prResult;
        try {
          prResult = await this.createPR({ base: autoBaseBranch || undefined });
        } catch (prErr) {
          this._appendAutoLog({ event: "pr_failed", index: i, error: prErr.message });
          throw prErr;
        }

        const state = this._loadState();
        entry.branch = state.branch || null;
        entry.prUrl = prResult?.prUrl || state.prUrl || null;
        entry.baseBranch = autoBaseBranch || state.baseBranch || null;
        entry.status = "completed";
        entry.completedAt = new Date().toISOString();

        this._appendAutoLog({ event: "issue_completed", index: i, id: entry.id, prUrl: entry.prUrl });
      } catch (err) {
        entry.status = "failed";
        entry.error = err.message || String(err);
        entry.completedAt = new Date().toISOString();
        failedRefs.add(issueRef(entry));

        try {
          const state = this._loadState();
          entry.branch = state.branch || null;
        } catch { /* best-effort */ }

        this._appendAutoLog({ event: "issue_failed", index: i, id: entry.id, error: entry.error });
      }

      this._resetForNextIssue(entry.repoPath, { destructive: destructiveReset });
      loopState.currentIndex = i + 1;
      saveLoopState(this.workspaceDir, loopState);
    }

    // Phase 3: Summarize
    const completed = loopState.issueQueue.filter((e) => e.status === "completed").length;
    const failed = loopState.issueQueue.filter((e) => e.status === "failed").length;
    const skipped = loopState.issueQueue.filter((e) => e.status === "skipped").length;

    if (loopState.issueQueue.length === 0) {
      loopState.status = "completed";
    } else {
      loopState.status = failed === loopState.issueQueue.length ? "failed" : "completed";
    }
    loopState.completedAt = new Date().toISOString();
    saveLoopState(this.workspaceDir, loopState);

    this._appendAutoLog({
      event: "auto_done",
      status: loopState.status,
      completed,
      failed,
      skipped,
      total: loopState.issueQueue.length,
    });

    return {
      status: loopState.status,
      completed,
      failed,
      skipped,
      results: loopState.issueQueue,
    };
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
      baseBranch: state.baseBranch,
      branch: state.branch,
      steps: state.steps,
      lastError: state.lastError,
      prUrl: state.prUrl,
      prBranch: state.prBranch,
      prBase: state.prBase,
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
