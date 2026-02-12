import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import pRetry from "p-retry";

import { AgentRunner } from "./agent-runner.js";
import { HostSandboxProvider } from "./host-sandbox.js";
import { ensureLogsDir, makeJsonlLogger, closeAllLoggers, sanitizeLogEvent } from "./logging.js";
import { loadState, saveState, loadLoopState, saveLoopState, statePathFor } from "./state.js";
import { resolveConfig } from "./config.js";
import { sanitizeBranchForRef } from "./worktrees.js";
import { IssuesPayloadSchema, QuestionsPayloadSchema, ProjectsPayloadSchema } from "./schemas.js";
import {
  buildSecrets,
  extractJson,
  extractGeminiPayloadJson,
  heredocPipe,
  geminiJsonPipeWithModel,
  gitCleanOrThrow,
  runPlanreview,
  runPpcommit,
  runHostTests,
  computeGitWorktreeFingerprint,
  upsertIssueCompletionBlock,
  formatCommandFailure,
  stripAgentNoise,
  sanitizeIssueMarkdown,
  buildPrBodyFromIssue,
  DEFAULT_PASS_ENV,
  detectDefaultBranch,
} from "./helpers.js";

const GEMINI_DEFAULT_HANG_TIMEOUT_MS = 1000 * 60;
const GEMINI_PROJECT_LIST_HANG_TIMEOUT_MS = 1000 * 120;
const GEMINI_AUTH_FAILURE_PATTERNS = [
  "rejected stored OAuth token",
  "Please re-authenticate using: /mcp auth",
];
const SUPPORTED_AGENTS = new Set(["gemini", "claude", "codex"]);

export class CoderOrchestrator {
  /**
   * @param {string} workspaceDir - Absolute path to the workspace directory
   * @param {{
   *   passEnv?: string[],
   *   verbose?: boolean,
   *   testCmd?: string,
   *   testConfigPath?: string,
   *   allowNoTests?: boolean,
   *   strictMcpStartup?: boolean,
   *   claudeDangerouslySkipPermissions?: boolean,
   *   agentRoles?: Partial<{
   *     issueSelector: "gemini"|"claude"|"codex",
   *     planner: "gemini"|"claude"|"codex",
   *     planReviewer: "gemini"|"claude"|"codex",
   *     programmer: "gemini"|"claude"|"codex",
   *     reviewer: "gemini"|"claude"|"codex",
   *     committer: "gemini"|"claude"|"codex",
   *   }>
   * }} [opts]
   */
  constructor(workspaceDir, opts = {}) {
    this.workspaceDir = path.resolve(workspaceDir);

    // Build config overrides from opts
    const overrides = {};
    if (opts.verbose !== undefined) overrides.verbose = opts.verbose;
    if (opts.testCmd) overrides.test = { ...overrides.test, command: opts.testCmd };
    if (opts.allowNoTests !== undefined) overrides.test = { ...overrides.test, allowNoTests: opts.allowNoTests };
    if (opts.strictMcpStartup !== undefined) overrides.mcp = { strictStartup: opts.strictMcpStartup };
    if (opts.claudeDangerouslySkipPermissions !== undefined) overrides.claude = { skipPermissions: opts.claudeDangerouslySkipPermissions };
    if (opts.agentRoles) overrides.workflow = { ...overrides.workflow, agentRoles: opts.agentRoles };

    this.config = resolveConfig(this.workspaceDir, overrides);
    this.passEnv = opts.passEnv || DEFAULT_PASS_ENV;
    this.verbose = this.config.verbose;
    this.testCmd = this.config.test.command;
    this.testConfigPath = opts.testConfigPath || "";
    this.allowNoTests = this.config.test.allowNoTests;
    this.agentRoles = this.config.workflow.agentRoles;

    this.issueFile = "ISSUE.md";
    this.planFile = "PLAN.md";
    this.critiqueFile = "PLANREVIEW.md";
    this.artifactsDir = path.join(this.workspaceDir, ".coder", "artifacts");

    mkdirSync(path.join(this.workspaceDir, ".coder"), { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });
    ensureLogsDir(this.workspaceDir);

    this._ensureGitignore();

    this.log = makeJsonlLogger(this.workspaceDir, "coder");
    this.secrets = buildSecrets(this.passEnv);

    this._workspaceAgents = new Map();
    this._repoAgents = new Map();

    this._cancelRequested = false;
    this._pauseRequested = false;

    this.strictMcpStartup = this.config.mcp.strictStartup;
    this.claudeDangerouslySkipPermissions = this.config.claude.skipPermissions;
  }

  requestCancel() { this._cancelRequested = true; }
  requestPause() { this._pauseRequested = true; }
  requestResume() { this._pauseRequested = false; }

  /**
   * Check MCP health for an agent. Throws if strict mode is on and the agent has failed servers.
   * @param {string} agentName
   */
  _checkMcpHealth(agentName) {
    if (!this.strictMcpStartup) return;
    const healthPath = path.join(this.workspaceDir, ".coder", "mcp-health.json");
    if (!existsSync(healthPath)) return;
    try {
      const health = JSON.parse(readFileSync(healthPath, "utf8"));
      const entry = health[agentName];
      if (entry && entry.failed && entry.failed !== "0" && entry.failed.toLowerCase() !== "none") {
        throw new Error(`MCP startup failure for ${agentName}: failed servers: ${entry.failed}`);
      }
    } catch (err) {
      if (err.message.startsWith("MCP startup failure")) throw err;
      // parse error — ignore
    }
  }

  // --- Agent construction ---

  _attachAgentLogging(name, vk) {
    const agentLog = makeJsonlLogger(this.workspaceDir, name);
    vk.on("stdout", (d) => agentLog({ stream: "stdout", data: d }));
    vk.on("stderr", (d) => agentLog({ stream: "stderr", data: d }));
    vk.on("update", (d) => agentLog({ stream: "update", data: d }));
    vk.on("error", (d) => agentLog({ stream: "error", data: d }));
    if (this.verbose) {
      vk.on("stdout", (d) => process.stdout.write(`[${name}] ${sanitizeLogEvent(String(d))}`));
      vk.on("stderr", (d) => process.stderr.write(`[${name}] ${sanitizeLogEvent(String(d))}`));
    }

    // MCP health parsing: detect startup health from stderr
    let mcpHealthParsed = false;
    vk.on("stderr", (d) => {
      if (mcpHealthParsed) return;
      const line = String(d);
      const match = line.match(/mcp startup:\s*ready:\s*(.+?);\s*failed:\s*(.+)/i);
      if (!match) return;
      mcpHealthParsed = true;
      const ready = match[1].trim();
      const failed = match[2].trim();
      const healthPath = path.join(this.workspaceDir, ".coder", "mcp-health.json");
      try {
        let health = {};
        if (existsSync(healthPath)) {
          try { health = JSON.parse(readFileSync(healthPath, "utf8")); } catch { /* fresh */ }
        }
        health[name] = { ready, failed, parsedAt: new Date().toISOString() };
        writeFileSync(healthPath, JSON.stringify(health, null, 2) + "\n");
      } catch { /* best-effort */ }
      this.log({ event: "mcp_health", agent: name, ready, failed });
    });

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

  _claudeBaseFlags({ outputFormat = "stream-json" } = {}) {
    let flags = "claude -p";
    if (outputFormat) {
      flags += ` --output-format ${outputFormat}`;
      if (outputFormat === "stream-json") flags += " --verbose";
    }
    if (this.config.models.claude) flags += ` --model ${this.config.models.claude}`;
    if (this.claudeDangerouslySkipPermissions) flags += " --dangerously-skip-permissions";
    return flags;
  }

  _resolveAgentName(name) {
    const normalized = String(name || "").trim().toLowerCase();
    if (!SUPPORTED_AGENTS.has(normalized)) {
      throw new Error(`Unsupported agent: ${name}. Expected one of: gemini, claude, codex.`);
    }
    return normalized;
  }

  _roleAgentName(role) {
    const selected = this.agentRoles?.[role];
    return this._resolveAgentName(selected);
  }

  _makeAgent(name, cwd) {
    const provider = new HostSandboxProvider({ defaultCwd: cwd, baseEnv: this.secrets });
    const agent = new AgentRunner(provider);
    this._attachAgentLogging(name, agent);
    return agent;
  }

  _getWorkspaceAgent(name) {
    const agentName = this._resolveAgentName(name);
    if (!this._workspaceAgents.has(agentName)) {
      this._workspaceAgents.set(agentName, this._makeAgent(agentName, this.workspaceDir));
    }
    return this._workspaceAgents.get(agentName);
  }

  _getRepoAgent(name) {
    const agentName = this._resolveAgentName(name);
    if (!this._repoAgents.has(agentName)) {
      const state = this._loadState();
      const repoRoot = path.resolve(this.workspaceDir, state.repoPath || ".");
      this._repoAgents.set(agentName, this._makeAgent(agentName, repoRoot));
    }
    return this._repoAgents.get(agentName);
  }

  _getRoleAgent(role, { scope = "repo" } = {}) {
    const agentName = this._roleAgentName(role);
    const agent = scope === "workspace" ? this._getWorkspaceAgent(agentName) : this._getRepoAgent(agentName);
    return { agentName, agent };
  }

  _buildPromptCommand(agentName, prompt, { structured = false, sessionId, resumeId } = {}) {
    const selected = this._resolveAgentName(agentName);
    if (selected === "gemini") {
      if (structured) return geminiJsonPipeWithModel(prompt, this.config.models.gemini);
      const model = this.config.models.gemini;
      const cmd = model ? `gemini --yolo -m ${model}` : "gemini --yolo";
      return heredocPipe(prompt, cmd);
    }

    if (selected === "claude") {
      let flags = this._claudeBaseFlags({ outputFormat: null });
      if (sessionId) flags += ` --session-id ${sessionId}`;
      if (resumeId) flags += ` --resume ${resumeId}`;
      return heredocPipe(prompt, flags);
    }

    // codex
    return `codex exec --full-auto --skip-git-repo-check ${JSON.stringify(prompt)}`;
  }

  _parseStructuredAgentPayload(agentName, stdout) {
    return this._resolveAgentName(agentName) === "gemini"
      ? extractGeminiPayloadJson(stdout)
      : extractJson(stdout);
  }

  _getGemini() { return this._getWorkspaceAgent("gemini"); }
  _getClaude() { return this._getRepoAgent("claude"); }
  _getCodex() { return this._getRepoAgent("codex"); }

  // --- Gitignore ---

  _ensureGitignore() {
    // Keep workflow internals out of git.
    const gitignorePath = path.join(this.workspaceDir, ".gitignore");
    let giContent = "";
    if (existsSync(gitignorePath)) {
      giContent = readFileSync(gitignorePath, "utf8");
    }
    if (!giContent.split("\n").some((line) => line.trim() === ".coder/")) {
      const suffix = giContent.endsWith("\n") || giContent === "" ? "" : "\n";
      writeFileSync(gitignorePath, giContent + `${suffix}# coder workflow artifacts\n.coder/\n`);
    }
    if (!giContent.split("\n").some((line) => line.trim() === ".gemini/")) {
      // Re-read in case we just wrote .coder/ above
      const updated = readFileSync(gitignorePath, "utf8");
      const suffix = updated.endsWith("\n") || updated === "" ? "" : "\n";
      writeFileSync(gitignorePath, updated + `${suffix}.gemini/\n`);
    }
    const latestGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    if (!latestGitignore.split("\n").some((line) => line.trim() === ".coder/logs/")) {
      const suffix = latestGitignore.endsWith("\n") || latestGitignore === "" ? "" : "\n";
      writeFileSync(gitignorePath, latestGitignore + `${suffix}.coder/logs/\n`);
    }

    const artifacts = [this.issueFile, this.planFile, this.critiqueFile];

    // Some Gemini versions prioritize .gitignore behavior. Explicitly unignore
    // workflow markdown artifacts for Gemini.
    const geminiIgnorePath = path.join(this.workspaceDir, ".geminiignore");
    let gmContent = "";
    if (existsSync(geminiIgnorePath)) {
      gmContent = readFileSync(geminiIgnorePath, "utf8");
    }
    // If `.coder/` is ignored, we must also unignore the intermediate dirs.
    const keepRules = [
      // Current layout (.coder/artifacts)
      "!.coder/",
      "!.coder/artifacts/",
      ...artifacts.map((name) => `!.coder/artifacts/${name}`),
    ];
    const missingGeminiRules = keepRules.filter(
      (rule) => !gmContent.split("\n").some((line) => line.trim() === rule),
    );
    if (missingGeminiRules.length > 0) {
      const suffix = gmContent.endsWith("\n") || gmContent === "" ? "" : "\n";
      writeFileSync(
        geminiIgnorePath,
        gmContent + `${suffix}# coder workflow artifacts must remain readable\n${missingGeminiRules.join("\n")}\n`,
      );
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
      issue: path.join(this.artifactsDir, this.issueFile),
      plan: path.join(this.artifactsDir, this.planFile),
      critique: path.join(this.artifactsDir, this.critiqueFile),
    };
  }

  _repoRoot(state) {
    if (!state.repoPath) throw new Error("No repo path set. Run draftIssue first.");
    return path.resolve(this.workspaceDir, state.repoPath);
  }

  /**
   * Normalize a repo path to a safe workspace-relative directory.
   * Falls back to "." when path is empty, outside workspace, absolute, or missing.
   * @param {string} repoPath
   * @param {{ fallback?: string }} [opts]
   */
  _normalizeRepoPath(repoPath, { fallback = "." } = {}) {
    const inWorkspace = (absPath) =>
      absPath === this.workspaceDir || absPath.startsWith(this.workspaceDir + path.sep);

    const resolveGitRoot = (absStartDir) => {
      const rootRes = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: absStartDir,
        encoding: "utf8",
      });
      if (rootRes.status !== 0) return null;
      const root = path.resolve(absStartDir, (rootRes.stdout || "").trim());
      if (!inWorkspace(root)) return null;
      return path.relative(this.workspaceDir, root) || ".";
    };

    const resolveIfValid = (candidate) => {
      const raw = String(candidate || "").trim();
      if (!raw) return null;
      if (path.isAbsolute(raw)) return null;

      const abs = path.resolve(this.workspaceDir, raw);
      if (!inWorkspace(abs)) return null;
      if (!existsSync(abs)) return null;
      const stats = statSync(abs);
      const searchDir = stats.isDirectory() ? abs : path.dirname(abs);
      return resolveGitRoot(searchDir);
    };

    return resolveIfValid(repoPath) || resolveIfValid(fallback) || ".";
  }

  /**
   * Check for artifact collisions before starting a new workflow.
   * Prevents overwriting foreign files or stale workflow artifacts.
   * @param {{ force?: boolean }} [opts]
   */
  _checkArtifactCollisions({ force } = {}) {
    if (force) return;

    const paths = this._artifactPaths();
    const hasArtifacts = existsSync(paths.issue) || existsSync(paths.plan) || existsSync(paths.critique);
    const statePath = path.join(this.workspaceDir, ".coder", "state.json");
    const hasState = existsSync(statePath);

    if (hasArtifacts && !hasState) {
      throw new Error(
        "Artifact collision: workflow artifacts exist but no .coder/state.json found. " +
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
   * Execute a command via an agent, then enforce strict MCP startup health if enabled.
   * @param {string|null} agentName
   * @param {object} agent - AgentRunner instance
   * @param {string} cmd - Command to execute
   * @param {{ timeoutMs?: number, hangTimeoutMs?: number, hangResetOnStderr?: boolean, killOnStderrPatterns?: string[] }} opts
   */
  async _executeAgentCommand(
    agentName,
    agent,
    cmd,
    { timeoutMs = 1000 * 60 * 10, hangTimeoutMs = 0, hangResetOnStderr, killOnStderrPatterns } = {},
  ) {
    const isGemini = agentName === "gemini";
    const effectiveHangTimeout = hangTimeoutMs > 0 ? hangTimeoutMs : 0;
    const effectiveHangResetOnStderr = hangResetOnStderr ?? !isGemini;
    const effectiveKillPatterns = killOnStderrPatterns ?? (isGemini ? GEMINI_AUTH_FAILURE_PATTERNS : []);

    const res = await agent.executeCommand(cmd, {
      timeoutMs,
      hangTimeoutMs: effectiveHangTimeout,
      hangResetOnStderr: effectiveHangResetOnStderr,
      killOnStderrPatterns: effectiveKillPatterns,
    });
    if (agentName) this._checkMcpHealth(agentName);
    return res;
  }

  /**
   * Retry wrapper with exponential backoff via p-retry.
   * Does not retry timeout, auth, or MCP startup errors.
   */
  async _executeWithRetry(agent, cmd, {
    timeoutMs = 1000 * 60 * 10,
    hangTimeoutMs = 0,
    hangResetOnStderr,
    killOnStderrPatterns,
    retries = 1,
    backoffMs = 5000,
    agentName = null,
    retryOnRateLimit = false,
  } = {}) {
    const isRateLimited = (txt) =>
      /rate limit|429|resource_exhausted|quota/i.test(String(txt || ""));

    const parseRetryAfterMs = (txt) => {
      const m = String(txt || "").match(/retry(?:ing)?(?:\s+after|\s+in)?\s+(\d+)\s*(ms|milliseconds|s|sec|seconds|m|min|minutes)?/i);
      if (!m) return null;
      const num = Number.parseInt(m[1], 10);
      if (!Number.isFinite(num) || num <= 0) return null;
      const unit = (m[2] || "s").toLowerCase();
      if (unit === "ms" || unit.startsWith("millisecond")) return num;
      if (unit === "m" || unit === "min" || unit.startsWith("minute")) return num * 60 * 1000;
      return num * 1000;
    };

    return pRetry(async () => {
      const res = await this._executeAgentCommand(agentName, agent, cmd, {
        timeoutMs, hangTimeoutMs, hangResetOnStderr, killOnStderrPatterns,
      });

      if (retryOnRateLimit && res.exitCode !== 0) {
        const details = `${res.stderr || ""}\n${res.stdout || ""}`;
        if (isRateLimited(details)) {
          const rateErr = new Error(`Rate limited: ${details.slice(0, 300)}`);
          rateErr.name = "RateLimitError";
          rateErr.rateLimitDetails = details;
          throw rateErr;
        }
      }

      return res;
    }, {
      retries,
      minTimeout: backoffMs,
      factor: 2,
      shouldRetry: (ctx) => {
        // p-retry passes { error, attemptNumber, retriesLeft, retriesConsumed }
        const err = ctx.error;
        // Don't retry deterministic failures
        if (err.name === "CommandTimeoutError") return false;
        if (err.name === "CommandAuthError") return false;
        if ((err.message || "").startsWith("MCP startup failure")) return false;
        return true;
      },
      shouldConsumeRetry: (ctx) => {
        // Rate limits don't count toward retry budget — we handle timing ourselves
        if (ctx.error.name === "RateLimitError") return false;
        return true;
      },
      onFailedAttempt: async (err) => {
        // For rate limits, sleep the exact server-directed delay
        const details = `${err.rateLimitDetails || ""}\n${err.message || ""}`;
        if (isRateLimited(details)) {
          const serverDelay = parseRetryAfterMs(details);
          if (serverDelay) {
            await new Promise((r) => setTimeout(r, serverDelay));
          }
        }
        this.log({ event: "retry", attempt: err.attemptNumber, error: err.message });
      },
    });
  }

  /**
   * Wrap a stage of runAuto() with structured tracking.
   * Sets currentStage/activeAgent on loopState, emits stage events, clears on completion.
   * @param {object} loopState - The loop state object (mutated in place)
   * @param {string} stageName - e.g. "draft", "plan", "implement"
   * @param {string|null} agentName - e.g. "gemini", "claude", "codex", or null
   * @param {() => Promise<any>} fn - The async work to execute
   */
  async _withStage(loopState, stageName, agentName, fn) {
    if (this._cancelRequested) throw new Error("Run cancelled");
    if (this._pauseRequested) {
      loopState.status = "paused";
      saveLoopState(this.workspaceDir, loopState);
      this._appendAutoLog({ event: "auto_paused", stage: stageName });
      while (this._pauseRequested && !this._cancelRequested) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this._cancelRequested) throw new Error("Run cancelled");
      loopState.status = "running";
      saveLoopState(this.workspaceDir, loopState);
      this._appendAutoLog({ event: "auto_resumed", stage: stageName });
    }

    const now = new Date().toISOString();
    loopState.currentStage = stageName;
    loopState.currentStageStartedAt = now;
    loopState.activeAgent = agentName;
    loopState.lastHeartbeatAt = now;
    saveLoopState(this.workspaceDir, loopState);
    this._appendAutoLog({ event: "stage_start", stage: stageName, agent: agentName });

    try {
      const result = await fn();
      this._appendAutoLog({ event: "stage_done", stage: stageName });
      return result;
    } finally {
      loopState.currentStage = null;
      loopState.currentStageStartedAt = null;
      loopState.activeAgent = null;
      saveLoopState(this.workspaceDir, loopState);
    }
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
      const { agentName: issueSelectorName, agent: issueSelector } = this._getRoleAgent("issueSelector", { scope: "workspace" });

      // Sub-step: list Linear teams if available and not cached
      if (this.secrets.LINEAR_API_KEY && (!state.steps.listedProjects || !state.linearProjects)) {
        this.log({ event: "step0_list_projects" });
        try {
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
          const projCmd = this._buildPromptCommand(issueSelectorName, projPrompt, { structured: true });
          const projRes = await this._executeWithRetry(issueSelector, projCmd, {
            timeoutMs: 1000 * 60 * 5,
            hangTimeoutMs: GEMINI_PROJECT_LIST_HANG_TIMEOUT_MS,
            retries: 2,
            agentName: issueSelectorName,
            retryOnRateLimit: true,
          });
          if (projRes.exitCode !== 0) {
            throw new Error(formatCommandFailure(`${issueSelectorName} project listing failed`, projRes));
          }
          const projPayload = ProjectsPayloadSchema.parse(this._parseStructuredAgentPayload(issueSelectorName, projRes.stdout));
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
        } catch (err) {
          // Linear is optional. Continue with GitHub issue listing when team discovery fails.
          this.log({ event: "step0_list_projects_failed", error: err.message || String(err) });
          state.steps.listedProjects = true;
          state.linearProjects ||= [];
          this._saveState(state);
        }
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

Then estimate implementation difficulty and directness (prefer small, self-contained changes). Keep this lightweight: do not do deep repository scans unless absolutely required to disambiguate repo_path.

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

      const cmd = this._buildPromptCommand(issueSelectorName, listPrompt, { structured: true });
      const res = await this._executeWithRetry(issueSelector, cmd, {
        timeoutMs: 1000 * 60 * 10,
        hangTimeoutMs: GEMINI_DEFAULT_HANG_TIMEOUT_MS,
        retries: 2,
        agentName: issueSelectorName,
        retryOnRateLimit: true,
      });
      if (res.exitCode !== 0) {
        throw new Error(formatCommandFailure(`${issueSelectorName} issue listing failed`, res));
      }
      const issuesPayload = IssuesPayloadSchema.parse(this._parseStructuredAgentPayload(issueSelectorName, res.stdout));

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
      const normalizedRepoPath = this._normalizeRepoPath(repoPath, { fallback: "." });
      if ((repoPath || "").trim() !== normalizedRepoPath) {
        this.log({
          event: "repo_path_normalized",
          requested: repoPath || "",
          resolved: normalizedRepoPath,
          issue: `${issue.source}#${issue.id}`,
        });
      }
      state.repoPath = normalizedRepoPath;
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
      const { agentName: issueSelectorName, agent: issueSelector } = this._getRoleAgent("issueSelector", { scope: "workspace" });

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

      const cmd = this._buildPromptCommand(issueSelectorName, issuePrompt);
      const res = await this._executeAgentCommand(issueSelectorName, issueSelector, cmd, { timeoutMs: 1000 * 60 * 10 });
      if (res.exitCode !== 0) {
        throw new Error(formatCommandFailure(`${issueSelectorName} ISSUE.md drafting failed`, res));
      }

      // Gemini may write the file via tool use and respond conversationally,
      // or it may output the markdown directly to stdout.  Prefer the on-disk
      // file if it exists and looks like real markdown content.
      let issueMd;
      if (existsSync(issuePath)) {
        const onDisk = sanitizeIssueMarkdown(readFileSync(issuePath, "utf8"));
        if (onDisk.length > 40 && onDisk.startsWith("#")) {
          issueMd = onDisk + "\n";
          if (issueMd !== readFileSync(issuePath, "utf8")) {
            writeFileSync(issuePath, issueMd);
          }
        }
      }
      if (!issueMd) {
        issueMd = sanitizeIssueMarkdown(res.stdout.trimEnd()) + "\n";
        if (!issueMd.trim().startsWith("#")) {
          const fallback = stripAgentNoise(res.stdout || "", { dropLeadingOnly: true }).trim();
          if (!fallback.startsWith("#")) {
            const rawPreview = (res.stdout || "").slice(0, 300).replace(/\n/g, "\\n");
            throw new Error(
              `${issueSelectorName} draft output did not contain valid ISSUE.md markdown after sanitization. ` +
              `Raw output preview (first 300 chars): "${rawPreview}"`,
            );
          }
          issueMd = fallback + "\n";
        }
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
   * Have the configured planner write PLAN.md, then run the configured
   * plan-reviewer to critique it.
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
      const { agentName: plannerName, agent: plannerAgent } = this._getRoleAgent("planner", { scope: "repo" });
      const { agentName: planReviewerName, agent: planReviewerAgent } = this._getRoleAgent("planReviewer", { scope: "repo" });

      // Step 3a: Planner writes PLAN.md
      if (!state.steps.wrotePlan) {
        const repoRoot = this._repoRoot(state);
        const artifactFiles = [this.issueFile, this.planFile, this.critiqueFile, ".coder/", ".gemini/"];
        const isArtifact = (p) =>
          artifactFiles.some((a) => (a.endsWith("/") ? p.replace(/\\/g, "/").startsWith(a) : p === a));

        const gitPorcelain = () => {
          const st = spawnSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repoRoot, encoding: "utf8" });
          if (st.status !== 0) throw new Error("Failed to check git status during planning.");
          const tokens = (st.stdout || "").split("\0").filter(Boolean);
          /** @type {{ status: string, path: string }[]} */
          const entries = [];
          for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.length < 4) continue;
            const status = t.slice(0, 2);
            let filePath = t.slice(3);
            if ((status[0] === "R" || status[0] === "C") && i + 1 < tokens.length) {
              filePath = tokens[i + 1];
              i++;
            }
            entries.push({ status, path: filePath });
          }
          return entries;
        };

        const pre = gitPorcelain();
        const preUntracked = new Set(pre.filter((e) => e.status === "??").map((e) => e.path));

        // Generate a session ID for Claude session reuse across steps.
        if (plannerName === "claude" && !state.claudeSessionId) {
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

        const cmd = this._buildPromptCommand(plannerName, planPrompt, {
          sessionId: plannerName === "claude" ? state.claudeSessionId : undefined,
        });
        const res = await this._executeAgentCommand(plannerName, plannerAgent, cmd, { timeoutMs: 1000 * 60 * 20 });
        if (res.exitCode !== 0) throw new Error(formatCommandFailure(`${plannerName} plan generation failed`, res));

        // Hard gate: planner must not change tracked files during planning.
        // But allow untracked exploration artifacts (e.g. cargo init) and clean up newly-created ones
        // to avoid contaminating later stages.
        const post = gitPorcelain();
        const postUntracked = post.filter((e) => e.status === "??").map((e) => e.path);
        const newUntracked = postUntracked
          .filter((p) => !preUntracked.has(p) && !isArtifact(p));

        const trackedDirty = post
          .filter((e) => e.status !== "??" && !isArtifact(e.path))
          .map((e) => `${e.status} ${e.path}`);
        if (trackedDirty.length > 0) {
          throw new Error(`Planning step modified tracked files. Aborting.\n${trackedDirty.join("\n")}`);
        }

        if (newUntracked.length > 0) {
          this.log({ event: "plan_untracked_cleanup", count: newUntracked.length, paths: newUntracked.slice(0, 50) });
          // Best-effort cleanup of only the new untracked paths created during planning.
          const chunkSize = 100;
          for (let i = 0; i < newUntracked.length; i += chunkSize) {
            const chunk = newUntracked.slice(i, i + chunkSize);
            spawnSync("git", ["clean", "-fd", "--", ...chunk], { cwd: repoRoot, encoding: "utf8" });
          }
        }

        if (!existsSync(paths.plan)) throw new Error(`PLAN.md not found: ${paths.plan}`);
        state.steps.wrotePlan = true;
        this._saveState(state);
      }

      // Step 3b: Plan review
      if (!state.steps.wroteCritique) {
        if (planReviewerName === "gemini") {
          const rc = runPlanreview(this._repoRoot(state), paths.plan, paths.critique);
          if (rc !== 0) this.log({ event: "plan_review_nonzero", exitCode: rc });
        } else {
          const reviewPrompt = `Review ${paths.plan} and write a critical plan critique to ${paths.critique}.

Required sections (in order):
1. Critical Issues (Must Fix)
2. Over-Engineering Concerns
3. Concerns (Should Address)
4. Questions (Need Clarification)
5. Verdict (REJECT | REVISE | PROCEED WITH CAUTION | APPROVED)

Constraints:
- Do not modify tracked files.
- Keep critique concrete with file-level references when possible.
- Write markdown content directly to ${paths.critique}.`;
          const reviewCmd = this._buildPromptCommand(planReviewerName, reviewPrompt);
          const reviewRes = await this._executeAgentCommand(planReviewerName, planReviewerAgent, reviewCmd, {
            timeoutMs: 1000 * 60 * 20,
          });
          if (reviewRes.exitCode !== 0) {
            throw new Error(formatCommandFailure(`${planReviewerName} plan review failed`, reviewRes));
          }
          if (!existsSync(paths.critique)) {
            const cleaned = stripAgentNoise(reviewRes.stdout || "", { dropLeadingOnly: true });
            const filtered = stripAgentNoise(cleaned).trim();
            if (!filtered) throw new Error(`${planReviewerName} plan review produced no critique output.`);
            writeFileSync(paths.critique, filtered + "\n", "utf8");
          }
        }
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
   * Have the configured programmer implement the feature based on PLAN.md + PLANREVIEW.md.
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
      const { agentName: programmerName, agent: programmerAgent } = this._getRoleAgent("programmer", { scope: "repo" });

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

      const cmd = this._buildPromptCommand(programmerName, implPrompt, {
        resumeId: programmerName === "claude" ? state.claudeSessionId : undefined,
      });
      const res = await this._executeAgentCommand(programmerName, programmerAgent, cmd, { timeoutMs: 1000 * 60 * 60 });
      if (res.exitCode !== 0) throw new Error(formatCommandFailure(`${programmerName} implementation failed`, res));

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
   * Have the configured reviewer/committer run review fixes, then enforce
   * ppcommit and host tests.
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
      const { agentName: reviewerName, agent: reviewerAgent } = this._getRoleAgent("reviewer", { scope: "repo" });
      const { agentName: committerName, agent: committerAgent } = this._getRoleAgent("committer", { scope: "repo" });
      const paths = this._artifactPaths();

      const runReviewerPass = async (agentName, agent, ppSection, label) => {
        const prompt = `You are reviewing uncommitted changes for commit readiness.
Read ${paths.issue} to understand what was originally requested.

## Checklist

### 1. Scope Conformance
- Does the change ONLY implement what ${paths.issue} requested?
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

Then run the repo's standard lint/format/test commands and fix any failures.

Hard constraints:
- Never bypass tests or reduce coverage/quality
- If a command fails, fix the underlying issue and re-run until it passes
- Remove ALL unnecessary code, comments, and abstractions`;
        const cmd = this._buildPromptCommand(agentName, prompt);
        const res = await this._executeAgentCommand(agentName, agent, cmd, { timeoutMs: 1000 * 60 * 90 });
        if (res.exitCode !== 0) throw new Error(formatCommandFailure(`${agentName} ${label} failed`, res));
      };

      const ppBefore = await runPpcommit(workDir, this.config.ppcommit);
      state.steps.ppcommitInitiallyClean = ppBefore.exitCode === 0;
      this.log({ event: "ppcommit_before", exitCode: ppBefore.exitCode });
      this._saveState(state);

      // Step 5a: reviewer pass + ppcommit fix
      if (!state.steps.reviewerCompleted && !state.steps.codexReviewed) {
        this.log({ event: "step5_review" });
        const ppOutput = (ppBefore.stdout || ppBefore.stderr || "").trim();
        const ppSection = ppBefore.exitCode === 0
          ? `ppcommit passed (no issues). Focus on code review.`
          : `ppcommit found issues — fix ALL of them:\n---\n${ppOutput}\n---\n\nCoder will re-run ppcommit and fail hard if anything remains.`;
        await runReviewerPass(reviewerName, reviewerAgent, ppSection, "review pass");
        state.steps.reviewerCompleted = true;
        state.steps.codexReviewed = true;
        this._saveState(state);
      }

      // Hard gate: ppcommit must be clean. Retry with configured committer
      // output to avoid silent drift between initial/final checks.
      const maxPpcommitRetries = 2;
      let ppAfter = await runPpcommit(workDir, this.config.ppcommit);
      this.log({ event: "ppcommit_after", attempt: 0, exitCode: ppAfter.exitCode });
      for (let attempt = 1; attempt <= maxPpcommitRetries && ppAfter.exitCode !== 0; attempt++) {
        const ppAfterOutput = (ppAfter.stdout || ppAfter.stderr || "").trim();
        this.log({ event: "ppcommit_retry", attempt, exitCode: ppAfter.exitCode });
        const retrySection = `ppcommit still failing after review pass. Fix ALL remaining ppcommit issues:\n---\n${ppAfterOutput}\n---`;
        await runReviewerPass(committerName, committerAgent, retrySection, "committer pass");
        ppAfter = await runPpcommit(workDir, this.config.ppcommit);
        this.log({ event: "ppcommit_after", attempt, exitCode: ppAfter.exitCode });
      }
      if (ppAfter.exitCode !== 0) {
        throw new Error(`ppcommit still reports issues after ${committerName} pass:\n${ppAfter.stdout || ppAfter.stderr}`);
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
      // Capture a fingerprint of the reviewed worktree so PR creation can detect drift.
      state.reviewFingerprint = computeGitWorktreeFingerprint(workDir);
      state.reviewedAt = new Date().toISOString();
      this._saveState(state);

      // Keep the workflow's ISSUE.md updated with a clear completion signal.
      upsertIssueCompletionBlock(paths.issue, {
        ppcommitClean: true,
        testsPassed: true,
        note: "Review + ppcommit + tests completed. Ready to create PR.",
      });

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

  // --- Step 6: Create PR ---

  /**
   * Create a pull request from the feature branch.
   * @param {{ type?: string, semanticName?: string, title?: string, description?: string, base?: string }} params
   * @returns {Promise<{ prUrl: string, branch: string, base: string | null }>}
   */
  async createPR({ type = "feat", semanticName, title, description, base } = {}) {
    try {
      const state = this._loadState();
      state.steps ||= {};

      if (!state.steps.testsPassed) {
        throw new Error(
          "Precondition failed: tests have not passed. " +
            "Run coder_review_and_test first.",
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

      // Re-validate that the tree hasn't drifted since review_and_test ran.
      const currentFp = computeGitWorktreeFingerprint(repoRoot);
      if (state.reviewFingerprint && state.reviewFingerprint !== currentFp) {
        throw new Error(
          "Worktree changed since coder_review_and_test completed. " +
            "Re-run coder_review_and_test to re-validate ppcommit and tests before creating a PR.",
        );
      }

      // Defense-in-depth: run ppcommit again immediately before committing/pushing.
      const ppNow = await runPpcommit(repoRoot, this.config.ppcommit);
      if (ppNow.exitCode !== 0) {
        throw new Error(`ppcommit reports issues prior to PR creation:\n${ppNow.stdout || ppNow.stderr}`);
      }

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
          body = buildPrBodyFromIssue(issueMd, { maxLines: 10 });
          if (!body) {
            this.log({ event: "pr_body_sanitized_empty", issue: state.selected || null });
          }
        }
      }
      if (!body) {
        body = `## Summary\nAutomated changes for: ${state.selected?.title || "workflow issue"}`;
      }
      body = stripAgentNoise(body).trim();

      // Append issue link
      if (state.selected) {
        const { source, id } = state.selected;
        if (source === "github") {
          const normalized = String(id).trim();
          body += normalized.includes("#")
            ? `\n\nCloses ${normalized}`
            : `\n\nCloses #${normalized}`;
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
    const artifacts = this._artifactPaths();
    for (const p of [artifacts.issue, artifacts.plan, artifacts.critique]) {
      if (existsSync(p)) unlinkSync(p);
    }

    // Checkout default branch and optionally clean changes in the repo
    if (repoPath) {
      const repoRoot = path.resolve(this.workspaceDir, repoPath);
      if (existsSync(repoRoot)) {
        const defaultBranch = detectDefaultBranch(repoRoot);

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
    this._workspaceAgents.clear();
    this._repoAgents.clear();
  }

  // --- Autonomous loop ---

  /**
   * Use the configured issue selector to filter issues by goal, analyze dependencies, and produce an
   * ordered queue. Returns the raw queue array ready for loop-state.
   */
  async _buildAutoQueue(issues, goal, maxIssues) {
    const { agentName: issueSelectorName, agent: issueSelector } = this._getRoleAgent("issueSelector", { scope: "workspace" });

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
4. **Dependency quality**: Include ONLY hard/blocking dependencies in depends_on. Prefer empty depends_on when unsure.
${maxIssues ? `5. **Limit**: Return at most ${maxIssues} issues.` : ""}

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

    const cmd = this._buildPromptCommand(issueSelectorName, prompt, { structured: true });
    const res = await this._executeWithRetry(issueSelector, cmd, {
      timeoutMs: 1000 * 60 * 5,
      hangTimeoutMs: GEMINI_DEFAULT_HANG_TIMEOUT_MS,
      retries: 2,
      agentName: issueSelectorName,
      retryOnRateLimit: true,
    });

    // Best-effort parse — fall back to difficulty sort if Gemini fails
    try {
      if (res.exitCode !== 0) throw new Error(formatCommandFailure(`${issueSelectorName} queue building failed`, res));
      const payload = this._parseStructuredAgentPayload(issueSelectorName, res.stdout);
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

      const queue = payload.queue.map((item) => {
        const issueRef = `${item.source}#${item.id}`;
        const mappedRepoPath = repoPathMap.get(issueRef) || ".";
        const requestedRepoPath = item.repo_path || mappedRepoPath;
        const repoPath = this._normalizeRepoPath(requestedRepoPath, {
          fallback: mappedRepoPath,
        });
        if ((requestedRepoPath || "").trim() !== repoPath) {
          this._appendAutoLog({
            event: "queue_repo_path_normalized",
            issueRef,
            requested: requestedRepoPath || "",
            resolved: repoPath,
          });
        }
        return {
        source: item.source,
        id: item.id,
        title: item.title,
        repoPath,
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
      };
      });

      this._appendAutoLog({
        event: "queue_built",
        method: issueSelectorName,
        total: queue.length,
        excluded: payload.excluded?.length || 0,
      });
      if (maxIssues) {
        queue.splice(maxIssues);
      }
      return queue;
    } catch {
      this._appendAutoLog({
        event: "queue_fallback",
        reason: `${issueSelectorName} queue building failed, using difficulty sort`,
      });
    }

    // Fallback: difficulty sort, no dependency analysis
    const sorted = [...issues].sort((a, b) => (a.difficulty || 3) - (b.difficulty || 3));
    return sorted.slice(0, maxIssues || sorted.length).map((iss) => ({
      source: iss.source,
      id: iss.id,
      title: iss.title,
      repoPath: this._normalizeRepoPath(iss.repo_path || ".", { fallback: "." }),
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
   * Uses the goal prompt to filter and dependency-sort the issue queue via the
   * configured issue selector.
   * Failed dependencies are treated as soft ordering hints; downstream issues
   * are still attempted to avoid full queue starvation.
   * @param {{ goal?: string, projectFilter?: string, maxIssues?: number, testCmd?: string, testConfigPath?: string, allowNoTests?: boolean, destructiveReset?: boolean }} opts
   * @returns {Promise<{ status: "completed"|"failed"|"cancelled", completed: number, failed: number, skipped: number, results: Array }>}
   */
  async runAuto({
    goal = "resolve all assigned issues",
    projectFilter,
    maxIssues,
    testCmd,
    testConfigPath,
    allowNoTests,
    destructiveReset = false,
    runId: externalRunId,
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
        runId: externalRunId || randomUUID().slice(0, 8),
        goal,
        status: "running",
        projectFilter: projectFilter || null,
        maxIssues: maxIssues || null,
        issueQueue: queue,
        currentIndex: 0,
        currentStage: null,
        currentStageStartedAt: null,
        lastHeartbeatAt: null,
        runnerPid: process.pid,
        activeAgent: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      saveLoopState(this.workspaceDir, loopState);

      // Reset per-issue state from listIssues call, using actual repo paths
      // so destructiveReset can clean the working tree before the first issue.
      const repoPaths = [...new Set(queue.map((e) => e.repoPath).filter(Boolean))];
      this._resetForNextIssue(repoPaths[0] || "", { destructive: destructiveReset });
    } else {
      this._appendAutoLog({ event: "auto_resume", currentIndex: loopState.currentIndex });
      loopState.runnerPid = process.pid;
      saveLoopState(this.workspaceDir, loopState);
    }

    const issueRef = (entry) => `${entry.source}#${entry.id}`;
    const autoStageAgents = {
      draft: this._roleAgentName("issueSelector"),
      plan: this._roleAgentName("planner"),
      implement: this._roleAgentName("programmer"),
      review: this._roleAgentName("reviewer"),
    };
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

    // Heartbeat: update lastHeartbeatAt every 5 seconds
    const heartbeatInterval = setInterval(() => {
      try {
        loopState.lastHeartbeatAt = new Date().toISOString();
        loopState.runnerPid = process.pid;
        saveLoopState(this.workspaceDir, loopState);
      } catch { /* best-effort */ }
    }, 5000);

    let runCancelled = false;
    let runAbortedInfra = false;

    // Phase 2: Loop through issues
    try {
    for (let i = loopState.currentIndex; i < loopState.issueQueue.length; i++) {
      const entry = loopState.issueQueue[i];
      loopState.currentIndex = i;

      // Cooperative cancel/pause check between issues
      if (this._cancelRequested) {
        this._appendAutoLog({ event: "auto_cancelled" });
        runCancelled = true;
        break;
      }
      if (this._pauseRequested) {
        loopState.status = "paused";
        saveLoopState(this.workspaceDir, loopState);
        this._appendAutoLog({ event: "auto_paused" });
        while (this._pauseRequested && !this._cancelRequested) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (this._cancelRequested) {
          this._appendAutoLog({ event: "auto_cancelled" });
          runCancelled = true;
          break;
        }
        loopState.status = "running";
        saveLoopState(this.workspaceDir, loopState);
        this._appendAutoLog({ event: "auto_resumed" });
      }

      if (entry.status === "completed" || entry.status === "failed" || entry.status === "skipped") {
        loopState.currentIndex = i + 1;
        saveLoopState(this.workspaceDir, loopState);
        continue;
      }

      const dependencyRefs = (entry.dependsOn || [])
        .map((dep) => normalizeDepRef(dep, entry.source))
        .filter((dep) => !!dep);
      entry.dependsOn = dependencyRefs;

      // Skip issues whose dependencies all failed — there's nothing to build on.
      // If only some dependencies failed, treat remaining as stacking hints.
      let effectiveDependencyRefs = dependencyRefs;
      const blockedBy = dependencyRefs.filter((depRef) => failedRefs.has(depRef));
      if (blockedBy.length > 0 && blockedBy.length === dependencyRefs.length) {
        // All dependencies failed — skip this issue entirely
        entry.status = "skipped";
        entry.error = `Skipped: all dependencies failed (${blockedBy.join(", ")})`;
        entry.completedAt = new Date().toISOString();
        failedRefs.add(issueRef(entry));
        this._appendAutoLog({
          event: "dependency_skipped",
          index: i,
          id: entry.id,
          blockedBy,
        });
        loopState.currentIndex = i + 1;
        saveLoopState(this.workspaceDir, loopState);
        continue;
      } else if (blockedBy.length > 0) {
        // Some dependencies failed — proceed with the ones that succeeded
        this._appendAutoLog({
          event: "dependency_failed_continue",
          index: i,
          id: entry.id,
          blockedBy,
        });
        effectiveDependencyRefs = dependencyRefs.filter((depRef) => !failedRefs.has(depRef));
      }

      let autoBaseBranch = null;
      if (effectiveDependencyRefs.length > 0) {
        const depEntries = effectiveDependencyRefs
          .map((depRef) => loopState.issueQueue.find((e) => issueRef(e) === depRef))
          .filter((dep) => !!dep);
        const branchDeps = depEntries.filter((dep) => dep.branch).map((dep) => dep.branch);
        if (branchDeps.length > 0) autoBaseBranch = branchDeps[0];
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

      let abortAfterThisIssue = false;
      try {
        await this._withStage(loopState, "draft", autoStageAgents.draft, () =>
          this.draftIssue({
            issue: { source: entry.source, id: entry.id, title: entry.title },
            repoPath: entry.repoPath,
            baseBranch: autoBaseBranch || undefined,
            clarifications: `Auto-mode (no human in the loop). Goal: ${goal}. ` +
              `You MUST include a concrete verification command in the Verification section. ` +
              `Do not ask questions — use repo conventions and the codebase as ground truth.`,
            force: true,
          }),
        );

        await this._withStage(loopState, "plan", autoStageAgents.plan, () => this.createPlan());
        await this._withStage(loopState, "implement", autoStageAgents.implement, () => this.implement());
        await this._withStage(loopState, "review", autoStageAgents.review, () => this.reviewAndTest());

        let prResult;
        try {
          prResult = await this._withStage(loopState, "pr", null, () =>
            this.createPR({ base: autoBaseBranch || undefined }),
          );
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
        if ((err?.message || "") === "Run cancelled") {
          runCancelled = true;
          entry.status = "skipped";
          entry.error = "Skipped: run cancelled";
          entry.completedAt = new Date().toISOString();
          this._appendAutoLog({ event: "issue_skipped", index: i, id: entry.id, reason: "run_cancelled" });
          loopState.currentIndex = i + 1;
          saveLoopState(this.workspaceDir, loopState);
          break;
        }

        entry.status = "failed";
        entry.error = err.message || String(err);
        entry.completedAt = new Date().toISOString();
        failedRefs.add(issueRef(entry));

        if (err?.name === "TestInfrastructureError") {
          // Test infra failures (e.g. missing Cargo.toml for cargo test) will cascade.
          // Abort the run and mark remaining issues as skipped with a clear reason.
          runAbortedInfra = true;
          abortAfterThisIssue = true;
          this._appendAutoLog({ event: "auto_abort_test_infra", index: i, id: entry.id, error: entry.error });
          for (let j = i + 1; j < loopState.issueQueue.length; j++) {
            const next = loopState.issueQueue[j];
            if (next.status === "pending" || next.status === "in_progress") {
              next.status = "skipped";
              next.error = `Skipped: test infrastructure error earlier in run: ${entry.error}`;
              next.completedAt = new Date().toISOString();
            }
          }
        }

        try {
          const state = this._loadState();
          entry.branch = state.branch || null;
        } catch { /* best-effort */ }

        this._appendAutoLog({ event: "issue_failed", index: i, id: entry.id, error: entry.error });
      }

      this._resetForNextIssue(entry.repoPath, { destructive: destructiveReset });
      loopState.currentIndex = i + 1;
      saveLoopState(this.workspaceDir, loopState);
      if (abortAfterThisIssue) break;
    }
    } finally {
      clearInterval(heartbeatInterval);
    }

    // Phase 3: Summarize
    const completed = loopState.issueQueue.filter((e) => e.status === "completed").length;
    const failed = loopState.issueQueue.filter((e) => e.status === "failed").length;
    const skipped = loopState.issueQueue.filter((e) => e.status === "skipped").length;

    if (loopState.issueQueue.length === 0) {
      loopState.status = "completed";
    } else if (runCancelled) {
      loopState.status = "cancelled";
    } else if (runAbortedInfra) {
      loopState.status = "failed";
    } else {
      loopState.status = failed === loopState.issueQueue.length ? "failed" : "completed";
    }
    loopState.runnerPid = null;
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

    // Read loop state for heartbeat/stage fields
    const loopState = loadLoopState(this.workspaceDir);

    // Read MCP health file if it exists
    const mcpHealthPath = path.join(this.workspaceDir, ".coder", "mcp-health.json");
    let mcpHealth = null;
    if (existsSync(mcpHealthPath)) {
      try {
        mcpHealth = JSON.parse(readFileSync(mcpHealthPath, "utf8"));
      } catch { /* best-effort */ }
    }

    return {
      version: state.version,
      selected: state.selected,
      selectedProject: state.selectedProject,
      repoPath: state.repoPath,
      baseBranch: state.baseBranch,
      branch: state.branch,
      agentRoles: this.agentRoles,
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
      currentStage: loopState.currentStage,
      currentStageStartedAt: loopState.currentStageStartedAt,
      lastHeartbeatAt: loopState.lastHeartbeatAt,
      activeAgent: loopState.activeAgent,
      mcpHealth,
    };
  }

  async cleanup() {
    await closeAllLoggers();
  }
}
