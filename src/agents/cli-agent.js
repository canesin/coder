import { EventEmitter } from "node:events";
import pRetry from "p-retry";
import {
  extractGeminiPayloadJson,
  extractJson,
  geminiJsonPipeWithModel,
  heredocPipe,
} from "../helpers.js";
import { HostSandboxProvider } from "../host-sandbox.js";
import { makeJsonlLogger, sanitizeLogEvent } from "../logging.js";
import { AgentAdapter } from "./_base.js";

const GEMINI_AUTH_FAILURE_PATTERNS = [
  "rejected stored OAuth token",
  "Please re-authenticate using: /mcp auth",
];
const SUPPORTED_AGENTS = new Set(["gemini", "claude", "codex"]);

/**
 * Validate a shell argument to prevent command injection.
 * Allows alphanumeric characters, hyphens, underscores, dots, colons, and slashes.
 * @param {string} value
 * @param {string} name - Parameter name for error messages
 * @returns {string}
 */
function validateShellArg(value, name) {
  if (!value) return "";
  const str = String(value);
  if (!/^[a-zA-Z0-9_.\-/:]+$/.test(str)) {
    throw new Error(
      `Invalid ${name}: contains unsafe characters. Must be alphanumeric with _.-/:`,
    );
  }
  return str;
}

export function resolveAgentName(name) {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_AGENTS.has(normalized)) {
    throw new Error(
      `Unsupported agent: ${name}. Expected one of: gemini, claude, codex.`,
    );
  }
  return normalized;
}

/**
 * CLI-based agent — wraps HostSandboxProvider for gemini/claude/codex.
 */
export class CliAgent extends AgentAdapter {
  /**
   * @param {string} agentName - "gemini" | "claude" | "codex"
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
    this._sandboxListeners = [];
    this._log = makeJsonlLogger(opts.workspaceDir, this.name);

    this._mcpHealthParsed = false;
    this._strictMcpStartup = opts.config.mcp.strictStartup;
  }

  get events() {
    return this._events;
  }

  async _ensureSandbox() {
    if (this._sandbox) return this._sandbox;
    if (this._sandboxPromise) return this._sandboxPromise;

    this._sandboxPromise = this._createSandbox();
    try {
      this._sandbox = await this._sandboxPromise;
      return this._sandbox;
    } catch (err) {
      this._sandboxPromise = null;
      throw err;
    }
  }

  async _createSandbox() {
    const sandbox = await this._provider.create();

    const stdoutListener = (d) => {
      this._log({ stream: "stdout", data: d });
      this._events.emit("stdout", d);
      if (this.verbose) {
        process.stdout.write(`[${this.name}] ${sanitizeLogEvent(String(d))}`);
      }
    };

    const stderrListener = (d) => {
      this._log({ stream: "stderr", data: d });
      this._events.emit("stderr", d);
      if (this.verbose) {
        process.stderr.write(`[${this.name}] ${sanitizeLogEvent(String(d))}`);
      }
      this._parseMcpHealth(d);
    };

    sandbox.on("stdout", stdoutListener);
    sandbox.on("stderr", stderrListener);
    this._sandboxListeners = [
      { event: "stdout", fn: stdoutListener },
      { event: "stderr", fn: stderrListener },
    ];

    return sandbox;
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
    { structured = false, sessionId, resumeId, modelOverride } = {},
  ) {
    if (this.name === "gemini") {
      if (structured) {
        const modelObj = modelOverride || this.config.models.gemini;
        const modelStr =
          modelObj && typeof modelObj === "object" ? modelObj.model : modelObj;
        if (modelStr) validateShellArg(modelStr, "model");
        return geminiJsonPipeWithModel(prompt, modelObj);
      }
      const model = validateShellArg(
        modelOverride || this.config.models.gemini?.model,
        "model",
      );
      const cmd = model ? `gemini --yolo -m ${model}` : "gemini --yolo";
      return heredocPipe(prompt, cmd);
    }

    if (this.name === "claude") {
      let flags = "claude -p";
      const claudeModel = validateShellArg(
        modelOverride || this.config.models.claude?.model,
        "model",
      );
      if (claudeModel) {
        flags += ` --model ${claudeModel}`;
      }
      if (this.config.claude.skipPermissions) {
        flags += " --dangerously-skip-permissions";
      }
      const safeSessionId = validateShellArg(sessionId, "sessionId");
      const safeResumeId = validateShellArg(resumeId, "resumeId");
      if (safeSessionId) flags += ` --session-id ${safeSessionId}`;
      if (safeResumeId) flags += ` --resume ${safeResumeId}`;
      return heredocPipe(prompt, flags);
    }

    // codex
    return heredocPipe(prompt, "codex exec --full-auto --skip-git-repo-check");
  }

  async execute(prompt, opts = {}) {
    const sandbox = await this._ensureSandbox();
    const cmd = this._buildCommand(prompt, opts);

    const isGemini = this.name === "gemini";
    const hangTimeoutMs = opts.hangTimeoutMs ?? 0;
    const hangResetOnStderr = opts.hangResetOnStderr ?? !isGemini;
    const killOnStderrPatterns =
      opts.killOnStderrPatterns ??
      (isGemini ? GEMINI_AUTH_FAILURE_PATTERNS : []);

    return sandbox.commands.run(cmd, {
      timeoutMs: opts.timeoutMs ?? 1000 * 60 * 10,
      hangTimeoutMs,
      hangResetOnStderr,
      killOnStderrPatterns,
    });
  }

  async executeStructured(prompt, opts = {}) {
    const res = await this.execute(prompt, { ...opts, structured: true });
    let parsed = null;
    let parseError = null;
    try {
      parsed =
        this.name === "gemini"
          ? extractGeminiPayloadJson(res.stdout)
          : extractJson(res.stdout);
    } catch (err) {
      parseError = err.message;
    }
    return { ...res, parsed, parseError };
  }

  async executeWithRetry(prompt, opts = {}) {
    const retries = opts.retries ?? 5;
    const backoffMs = opts.backoffMs ?? 5000;
    const maxTimeout = opts.maxTimeoutMs ?? 60000;
    const retryOnRateLimit = opts.retryOnRateLimit ?? true;

    const isRateLimited = (txt) =>
      /rate limit|429|resource_exhausted|quota/i.test(String(txt || ""));

    return pRetry(
      async () => {
        const res = await this.execute(prompt, opts);
        if (retryOnRateLimit && res.exitCode !== 0) {
          const details = `${res.stderr || ""}\n${res.stdout || ""}`;
          if (isRateLimited(details)) {
            const rateErr = new Error(`Rate limited: ${details.slice(0, 300)}`);
            rateErr.name = "RateLimitError";
            throw rateErr;
          }
        }
        return res;
      },
      {
        retries,
        minTimeout: backoffMs,
        maxTimeout,
        factor: 2,
        shouldRetry: (ctx) => {
          const err = ctx.error;
          if (err.name === "CommandTimeoutError") return false;
          if (err.name === "CommandAuthError") return false;
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

  async executeWithFallback(prompt, opts = {}) {
    try {
      return await this.executeWithRetry(prompt, {
        ...opts,
        retryOnRateLimit: true,
      });
    } catch (err) {
      if (err.name === "RateLimitError") {
        const fallback = this.config.models[this.name]?.fallbackModel;
        if (fallback) {
          this._log({
            event: "rate_limit_fallback",
            agent: this.name,
            fallback,
          });
          return this.executeWithRetry(prompt, {
            ...opts,
            modelOverride: fallback,
            retryOnRateLimit: true,
          });
        }
      }
      throw err;
    }
  }

  async kill() {
    if (this._sandboxPromise) {
      try {
        await this._sandboxPromise;
      } catch {
        // best-effort - creation may have failed
      }
    }
    if (this._sandbox) {
      for (const { event, fn } of this._sandboxListeners) {
        this._sandbox.off(event, fn);
      }
      this._sandboxListeners = [];
      await this._sandbox.kill();
      this._sandbox = null;
    }
    this._sandboxPromise = null;
  }
}
