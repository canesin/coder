import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import pRetry from "p-retry";
import {
  extractGeminiPayloadJson,
  extractJson,
  geminiJsonPipeWithModel,
  heredocPipe,
  isRateLimitError,
  resolveModelName,
  shellEscape,
} from "../helpers.js";
import { HostSandboxProvider } from "../host-sandbox.js";
import { makeJsonlLogger, sanitizeLogEvent } from "../logging.js";
import { AgentAdapter } from "./_base.js";

const GEMINI_AUTH_FAILURE_PATTERNS = [
  { pattern: "rejected stored OAuth token", category: "auth" },
  { pattern: "Please re-authenticate using: /mcp auth", category: "auth" },
];
/** @internal Exported for testing */
export const CLAUDE_RESUME_FAILURE_PATTERNS = [
  { pattern: "No conversation found with session ID", category: "auth" },
  { pattern: "Conversation not found", category: "auth" },
  { pattern: "Session not found", category: "auth" },
  { pattern: "Invalid session ID", category: "auth" },
  { pattern: "Conversation has expired", category: "auth" },
  { pattern: "Session has expired", category: "auth" },
  { pattern: "is already in use", category: "auth" }, // "Session ID <uuid> is already in use" (claude-code #5524)
];
const CODEX_RESUME_FAILURE_PATTERNS = [
  { pattern: "session not found", category: "auth" },
  { pattern: "invalid session", category: "auth" },
  { pattern: "session has expired", category: "auth" },
  { pattern: "no such session", category: "auth" },
];
const GEMINI_TRANSIENT_FAILURE_PATTERNS = [
  { pattern: "An unexpected critical error occurred", category: "transient" },
  { pattern: "fetch failed sending request", category: "transient" },
  { pattern: "Error when talking to Gemini API", category: "transient" },
];
const CODEX_FAILURE_PATTERNS = [
  { pattern: "org.freedesktop.secrets", category: "auth" },
  { pattern: "Cannot autolaunch D-Bus", category: "auth" },
];
const agentNameRegex = /^[a-zA-Z0-9._-]+$/;

/**
 * Parse first thread.started event from Codex --json JSONL stdout.
 * @param {string} stdout - JSONL output from codex exec --json
 * @returns {string|null} - thread_id or null
 */
function parseThreadStartedFromJsonl(stdout) {
  const lines = String(stdout || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj?.type === "thread.started" &&
        typeof obj?.thread_id === "string"
      ) {
        return obj.thread_id;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

export function resolveAgentName(name) {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  if (!normalized || !agentNameRegex.test(normalized)) {
    throw new Error(
      `Invalid agent name: "${name}". Must be non-empty and contain only alphanumerics, dots, hyphens, underscores.`,
    );
  }
  return normalized;
}

/**
 * CLI-based agent — wraps HostSandboxProvider for shell-based LLM tools.
 */
export class CliAgent extends AgentAdapter {
  /**
   * @param {string} agentName - Agent identifier (alphanumerics, dots, hyphens, underscores)
   * @param {{
   *   cwd: string,
   *   secrets: Record<string, string>,
   *   config: import("../config.js").CoderConfig,
   *   workspaceDir: string,
   *   verbose?: boolean,
   * }} opts
   */
  constructor(agentName, opts) {
    super();
    this.name = resolveAgentName(agentName);
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.verbose = opts.verbose ?? opts.config.verbose;
    this.workspaceDir = opts.workspaceDir;

    this._events = new EventEmitter();
    this._provider = new HostSandboxProvider({
      defaultCwd: opts.cwd,
      baseEnv: opts.secrets,
    });
    this._sandbox = null;
    this._sandboxPromise = null;
    this._log = makeJsonlLogger(opts.workspaceDir, this.name);

    this.steeringContext = opts.steeringContext;
    this._mcpHealthParsed = false;
    this._strictMcpStartup = opts.config.mcp.strictStartup;
    /** @type {boolean | null} Cached: does Codex support --session? null = not yet checked */
    this._codexSessionSupported = null;
  }

  /**
   * Check if the installed Codex CLI supports --session for initial named-session creation.
   * Caches result. Logs codex_session_unavailable when unsupported.
   * @returns {boolean}
   */
  _checkCodexSessionSupport() {
    if (this._codexSessionSupported !== null)
      return this._codexSessionSupported;
    try {
      const out = spawnSync("codex", ["exec", "--help"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const help = `${out.stdout || ""}\n${out.stderr || ""}`;
      this._codexSessionSupported = help.includes("--session");
      if (!this._codexSessionSupported) {
        this._log({ event: "codex_session_unavailable" });
      }
    } catch {
      this._codexSessionSupported = false;
      this._log({ event: "codex_session_unavailable" });
    }
    return this._codexSessionSupported;
  }

  /**
   * Whether this agent (Codex) supports --session for named-session creation.
   * Used by implementation machine to decide whether to persist implementationSessionId.
   * @returns {boolean}
   */
  codexSessionSupported() {
    return this.name === "codex" ? this._checkCodexSessionSupport() : false;
  }

  get events() {
    return this._events;
  }

  async _ensureSandbox() {
    if (this._sandbox) return this._sandbox;
    if (this._sandboxPromise) return this._sandboxPromise;

    const promise = (async () => {
      try {
        const sandbox = await this._provider.create();

        // kill() was called or a new promise replaced this one — abort
        if (this._sandboxPromise !== promise) {
          sandbox.kill().catch(() => {});
          const err = new Error("Sandbox creation aborted");
          err.name = "AbortError";
          throw err;
        }

        sandbox.on("stdout", (d) => {
          this._log({ stream: "stdout", data: d });
          this._events.emit("stdout", d);
          if (this.verbose) {
            process.stdout.write(
              `[${this.name}] ${sanitizeLogEvent(String(d))}`,
            );
          }
        });

        sandbox.on("stderr", (d) => {
          this._log({ stream: "stderr", data: d });
          this._events.emit("stderr", d);
          if (this.verbose) {
            process.stderr.write(
              `[${this.name}] ${sanitizeLogEvent(String(d))}`,
            );
          }
          this._parseMcpHealth(d);
        });

        this._sandbox = sandbox;
        this._sandboxPromise = null;
        return sandbox;
      } catch (err) {
        if (this._sandboxPromise === promise) {
          this._sandboxPromise = null;
        }
        throw err;
      }
    })();

    this._sandboxPromise = promise;
    return promise;
  }

  _parseMcpHealth(data) {
    if (this._mcpHealthParsed) return;
    const line = String(data);
    const match = line.match(
      /mcp startup:\s*ready:\s*(.+?);\s*failed:\s*(.+)/i,
    );
    if (!match) return;
    this._mcpHealthParsed = true;
    this._log({
      event: "mcp_health",
      agent: this.name,
      ready: match[1].trim(),
      failed: match[2].trim(),
    });
  }

  _checkMcpHealth() {
    // No-op — strict MCP startup checking deferred to workflow context
    // This allows individual machine calls to succeed even when MCP health is degraded
  }

  _buildCommand(
    prompt,
    {
      structured = false,
      sessionId,
      resumeId,
      execWithJsonCapture = false,
    } = {},
  ) {
    if (this.steeringContext) {
      prompt = `<steering_context>\n${this.steeringContext}\n</steering_context>\n\n${prompt}`;
    }
    if (this.name === "gemini") {
      const modelName = resolveModelName(this.config.models.gemini);
      if (structured) {
        return geminiJsonPipeWithModel(prompt, modelName);
      }
      let cmd = modelName
        ? `gemini --yolo -m ${shellEscape(modelName)}`
        : "gemini --yolo";
      if (resumeId) cmd += ` --resume ${shellEscape(resumeId)}`;
      return heredocPipe(prompt, cmd);
    }

    if (this.name === "claude") {
      const needsPersistence = sessionId || resumeId;
      let flags = "claude -p";
      if (!needsPersistence) flags += " --no-session-persistence";
      const claudeModel = resolveModelName(this.config.models.claude);
      if (claudeModel) {
        flags += ` --model ${shellEscape(claudeModel)}`;
      }
      if (this.config.claude.skipPermissions) {
        flags += " --dangerously-skip-permissions";
      }
      if (sessionId) flags += ` --session-id ${shellEscape(sessionId)}`;
      if (resumeId) flags += ` --resume ${shellEscape(resumeId)}`;
      return heredocPipe(prompt, flags);
    }

    // codex: resume is a subcommand, not a flag
    // --full-auto forces sandbox=workspace-write which blocks /bin/bash via Landlock
    // on Linux 6.2+. Use --dangerously-bypass-approvals-and-sandbox instead — outer
    // isolation (systemd-run with NoNewPrivileges + PrivateTmp) still applies.
    if (resumeId) {
      if (resumeId === "__last__") {
        return `codex exec resume --last --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${shellEscape(prompt)}`;
      }
      return `codex exec resume ${shellEscape(resumeId)} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${shellEscape(prompt)}`;
    }
    if (sessionId && this._checkCodexSessionSupport()) {
      return `codex exec --session ${shellEscape(sessionId)} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${shellEscape(prompt)}`;
    }
    const jsonFlag = execWithJsonCapture ? " --json" : "";
    return `codex exec${jsonFlag} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${shellEscape(prompt)}`;
  }

  async execute(prompt, opts = {}) {
    const sandbox = await this._ensureSandbox();
    const cmd = this._buildCommand(prompt, opts);

    const isGemini = this.name === "gemini";
    const isClaude = this.name === "claude";
    const isCodex = this.name === "codex";

    // Hang timeout: per-call > config default > 0 (disabled)
    const configHangTimeout = this.config.agents?.retry?.hangTimeoutMs ?? 0;
    const hangTimeoutMs = opts.hangTimeoutMs ?? configHangTimeout;
    const hangResetOnStderr = opts.hangResetOnStderr ?? !isGemini;

    const defaultPatterns = isGemini
      ? [...GEMINI_AUTH_FAILURE_PATTERNS, ...GEMINI_TRANSIENT_FAILURE_PATTERNS]
      : isClaude && (opts.resumeId || opts.sessionId)
        ? CLAUDE_RESUME_FAILURE_PATTERNS
        : isCodex && (opts.resumeId || opts.sessionId)
          ? CODEX_RESUME_FAILURE_PATTERNS
          : isCodex
            ? CODEX_FAILURE_PATTERNS
            : [];
    const killOnStderrPatterns = opts.killOnStderrPatterns ?? defaultPatterns;
    // Claude emits "Session ID X is already in use" to stdout, not stderr — kill on both
    const hasSessionOpts = !!(opts.resumeId || opts.sessionId);
    const killOnStdoutPatterns =
      opts.killOnStdoutPatterns ??
      (isClaude && hasSessionOpts ? CLAUDE_RESUME_FAILURE_PATTERNS : []);

    if (this._log && (hasSessionOpts || killOnStderrPatterns.length > 0)) {
      this._log({
        event: "cli_agent_execute_opts",
        agentName: this.name,
        hasSessionOpts,
        sessionId: opts.sessionId ?? null,
        resumeId: opts.resumeId ?? null,
        killPatternsCount:
          (killOnStderrPatterns?.length ?? 0) +
          (killOnStdoutPatterns?.length ?? 0),
      });
    }

    const hasKillPatterns =
      (killOnStderrPatterns?.length ?? 0) +
        (killOnStdoutPatterns?.length ?? 0) >
      0;
    const result = await sandbox.commands.run(cmd, {
      timeoutMs: opts.timeoutMs ?? 1000 * 60 * 10,
      hangTimeoutMs,
      hangResetOnStderr,
      killOnStderrPatterns,
      killOnStdoutPatterns,
      log: hasKillPatterns && this._log ? this._log : undefined,
    });

    if (isCodex && opts.execWithJsonCapture && result.stdout) {
      const threadId = parseThreadStartedFromJsonl(result.stdout);
      if (threadId) return { ...result, threadId };
    }
    return result;
  }

  async executeStructured(prompt, opts = {}) {
    const res = await this.execute(prompt, { ...opts, structured: true });
    const parsed =
      this.name === "gemini"
        ? extractGeminiPayloadJson(res.stdout)
        : extractJson(res.stdout);
    return { ...res, parsed };
  }

  async executeWithRetry(prompt, opts = {}) {
    const retries = opts.retries ?? 1;
    const backoffMs = opts.backoffMs ?? 5000;
    const retryOnRateLimit = opts.retryOnRateLimit ?? false;
    const isTransientResult = opts.isTransientResult;

    return pRetry(
      async () => {
        const res = await this.execute(prompt, opts);
        if (retryOnRateLimit && res.exitCode !== 0) {
          const details = `${res.stderr || ""}\n${res.stdout || ""}`;
          if (isRateLimitError(details)) {
            const rateErr = new Error(`Rate limited: ${details.slice(0, 300)}`);
            rateErr.name = "RateLimitError";
            throw rateErr;
          }
        }
        if (typeof isTransientResult === "function") {
          const reason = isTransientResult(res);
          if (reason) {
            const transientError = new Error(
              `Transient result: ${String(reason).slice(0, 300)}`,
            );
            transientError.name = "TransientResultError";
            throw transientError;
          }
        }
        return res;
      },
      {
        retries,
        minTimeout: backoffMs,
        factor: 2,
        shouldRetry: (ctx) => {
          const err = ctx.error;
          if (err.name === "AbortError") return false;
          if (err.name === "CommandTimeoutError") return false;
          if (
            (err.name === "CommandFatalStderrError" ||
              err.name === "CommandFatalStdoutError") &&
            err.category === "auth"
          )
            return false;
          if (err.name === "McpStartupError") return false;
          return true;
        },
        onFailedAttempt: (err) => {
          this._log({
            event: "retry",
            agent: this.name,
            attempt: err.attemptNumber,
            retriesLeft: err.retriesLeft,
            error: err.message?.slice(0, 300),
          });
        },
      },
    );
  }

  async kill() {
    this._sandboxPromise = null;
    if (this._sandbox) {
      await this._sandbox.kill();
      this._sandbox = null;
    }
  }
}
