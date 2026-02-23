import { EventEmitter } from "node:events";
import pRetry from "p-retry";
import {
  extractGeminiPayloadJson,
  extractJson,
  geminiJsonPipeWithModel,
  heredocPipe,
  resolveModelName,
} from "../helpers.js";
import { HostSandboxProvider } from "../host-sandbox.js";
import { makeJsonlLogger, sanitizeLogEvent } from "../logging.js";
import { AgentAdapter } from "./_base.js";

const GEMINI_AUTH_FAILURE_PATTERNS = [
  "rejected stored OAuth token",
  "Please re-authenticate using: /mcp auth",
];
const SUPPORTED_AGENTS = new Set(["gemini", "claude", "codex"]);

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
    this._log = makeJsonlLogger(opts.workspaceDir, this.name);

    this._mcpHealthParsed = false;
    this._strictMcpStartup = opts.config.mcp.strictStartup;
  }

  get events() {
    return this._events;
  }

  async _ensureSandbox() {
    if (this._sandbox) return this._sandbox;
    this._sandbox = await this._provider.create();

    this._sandbox.on("stdout", (d) => {
      this._log({ stream: "stdout", data: d });
      this._events.emit("stdout", d);
      if (this.verbose) {
        process.stdout.write(`[${this.name}] ${sanitizeLogEvent(String(d))}`);
      }
    });

    this._sandbox.on("stderr", (d) => {
      this._log({ stream: "stderr", data: d });
      this._events.emit("stderr", d);
      if (this.verbose) {
        process.stderr.write(`[${this.name}] ${sanitizeLogEvent(String(d))}`);
      }
      this._parseMcpHealth(d);
    });

    return this._sandbox;
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

  _buildCommand(prompt, { structured = false, sessionId, resumeId } = {}) {
    if (this.name === "gemini") {
      const modelName = resolveModelName(this.config.models.gemini);
      if (structured) {
        return geminiJsonPipeWithModel(prompt, modelName);
      }
      let cmd = modelName ? `gemini --yolo -m ${modelName}` : "gemini --yolo";
      if (sessionId) cmd += ` --sandbox-id ${sessionId}`;
      if (resumeId) cmd += ` --sandbox-id ${resumeId}`;
      return heredocPipe(prompt, cmd);
    }

    if (this.name === "claude") {
      let flags = "claude -p";
      const claudeModel = resolveModelName(this.config.models.claude);
      if (claudeModel) {
        flags += ` --model ${claudeModel}`;
      }
      if (this.config.claude.skipPermissions) {
        flags += " --dangerously-skip-permissions";
      }
      if (sessionId) flags += ` --session-id ${sessionId}`;
      if (resumeId) flags += ` --resume ${resumeId}`;
      return heredocPipe(prompt, flags);
    }

    // codex
    let codexCmd = "codex exec --full-auto --skip-git-repo-check";
    if (resumeId) codexCmd += ` --resume ${resumeId}`;
    codexCmd += ` ${JSON.stringify(prompt)}`;
    return codexCmd;
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

  async kill() {
    if (this._sandbox) {
      await this._sandbox.kill();
      this._sandbox = null;
    }
  }
}
