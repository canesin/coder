import pRetry from "p-retry";
import { buildSecrets, isRateLimitError, resolvePassEnv } from "../helpers.js";
import { AgentAdapter } from "./_base.js";
import { createApiAgent } from "./api-agent.js";
import { CliAgent, resolveAgentName } from "./cli-agent.js";
import { McpAgent } from "./mcp-agent.js";

/**
 * Wraps a primary agent with configurable retry and optional fallback agent.
 * If the primary exhausts retries, the fallback (if provided) is tried.
 */
class RetryFallbackWrapper extends AgentAdapter {
  constructor(primary, { fallback, retries, backoffMs, retryOnRateLimit }) {
    super();
    this._primary = primary;
    this._fallback = fallback ?? null;
    this._retries = retries;
    this._backoffMs = backoffMs;
    this._retryOnRateLimit = retryOnRateLimit;
  }

  async execute(prompt, opts) {
    return this._runWithFallback("execute", prompt, opts);
  }

  async executeStructured(prompt, opts) {
    return this._runWithFallback("executeStructured", prompt, opts);
  }

  async executeWithRetry(prompt, opts) {
    return this.execute(prompt, opts);
  }

  async _runWithFallback(method, prompt, opts) {
    try {
      return await this._callWithRetry(() =>
        this._primary[method](prompt, opts),
      );
    } catch (err) {
      if (this._fallback) {
        return await this._callWithRetry(() =>
          this._fallback[method](prompt, opts),
        );
      }
      throw err;
    }
  }

  async _callWithRetry(fn) {
    const retryOnRateLimit = this._retryOnRateLimit;
    return pRetry(
      async () => {
        const res = await fn();
        if (res.exitCode !== 0) {
          const details = `${res.stderr || ""}\n${res.stdout || ""}`.trim();
          if (retryOnRateLimit && isRateLimitError(details)) {
            const rateErr = new Error(`Rate limited: ${details.slice(0, 300)}`);
            rateErr.name = "RateLimitError";
            throw rateErr;
          }
          const err = new Error(
            details.slice(0, 300) || "Agent execution failed",
          );
          err.exitCode = res.exitCode;
          throw err;
        }
        return res;
      },
      {
        retries: this._retries,
        minTimeout: this._backoffMs,
        factor: 2,
        shouldRetry: (ctx) => {
          const name = ctx.error.name;
          if (name === "CommandTimeoutError") return false;
          if (
            name === "CommandFatalStderrError" &&
            ctx.error.category === "auth"
          )
            return false;
          if (name === "McpStartupError") return false;
          return true;
        },
        onFailedAttempt: (err) => {
          process.stderr.write(
            `[retry-wrapper] attempt=${err.attemptNumber} left=${err.retriesLeft} error=${err.message?.slice(0, 200)}\n`,
          );
        },
      },
    );
  }

  async kill() {
    await Promise.allSettled([
      this._primary.kill(),
      this._fallback?.kill() ?? Promise.resolve(),
    ]);
  }
}

/**
 * AgentPool — manages agent instances by (name, scope) key.
 *
 * Each machine requests agents from the pool. The pool lazily creates
 * and caches agent instances keyed by `${agentName}:${scope}:${cwd}`.
 */
export class AgentPool {
  /**
   * @param {{
   *   config: import("../config.js").CoderConfig,
   *   workspaceDir: string,
   *   repoRoot?: string,
   *   passEnv?: string[],
   *   verbose?: boolean,
   * }} opts
   */
  constructor(opts) {
    this.config = opts.config;
    this.workspaceDir = opts.workspaceDir;
    this.repoRoot = opts.repoRoot || opts.workspaceDir;
    this.secrets = buildSecrets(opts.passEnv || resolvePassEnv(opts.config));
    this.verbose = opts.verbose ?? opts.config.verbose;
    this.steeringContext = opts.steeringContext;

    /** @type {Map<string, import("./cli-agent.js").CliAgent>} */
    this._agents = new Map();
  }

  /**
   * Get an agent instance for a given role and scope.
   *
   * @param {string} role - Agent role from config (issueSelector, planner, etc.)
   * @param {{ scope?: "workspace" | "repo", mode?: "cli" | "api" | "mcp" }} [opts]
   * @returns {{ agentName: string, agent: import("./_base.js").AgentAdapter }}
   */
  getAgent(role, { scope = "repo", mode = "cli" } = {}) {
    const agentName = this._roleAgentName(role);
    const cwd = scope === "workspace" ? this.workspaceDir : this.repoRoot;

    if (mode === "api") {
      return this._getApiAgent(role, { scope });
    }

    if (mode === "mcp") {
      return this._getMcpAgent(role, { scope });
    }

    if (mode !== "cli") {
      throw new Error(`Agent mode "${mode}" is not supported`);
    }

    const key = `cli:${agentName}:${cwd}`;
    if (!this._agents.has(key)) {
      this._agents.set(
        key,
        new CliAgent(agentName, {
          cwd,
          secrets: this.secrets,
          config: this.config,
          workspaceDir: this.workspaceDir,
          verbose: this.verbose,
          steeringContext: this.steeringContext,
        }),
      );
    }
    const rawAgent = this._agents.get(key);

    const retryCfg = this.config.agents?.retry;
    const fallbackName = this.config.agents?.fallback?.[role];
    if ((retryCfg?.retries ?? 0) > 0 || fallbackName) {
      let fallbackAgent = null;
      if (fallbackName) {
        const resolvedFallback = resolveAgentName(fallbackName);
        const fallbackKey = `cli:${resolvedFallback}:${cwd}`;
        if (!this._agents.has(fallbackKey)) {
          this._agents.set(
            fallbackKey,
            new CliAgent(resolvedFallback, {
              cwd,
              secrets: this.secrets,
              config: this.config,
              workspaceDir: this.workspaceDir,
              verbose: this.verbose,
              steeringContext: this.steeringContext,
            }),
          );
        }
        fallbackAgent = this._agents.get(fallbackKey);
      }
      return {
        agentName,
        agent: new RetryFallbackWrapper(rawAgent, {
          fallback: fallbackAgent,
          retries: retryCfg?.retries ?? 1,
          backoffMs: retryCfg?.backoffMs ?? 5000,
          retryOnRateLimit: retryCfg?.retryOnRateLimit ?? true,
        }),
      };
    }

    return { agentName, agent: rawAgent };
  }

  /**
   * Get or create an MCP agent for a given server config.
   * @param {string} role
   * @param {{ transport?: "stdio" | "http", serverCommand?: string, serverArgs?: string[], serverUrl?: string, authHeader?: string, env?: Record<string, string>, serverName?: string }} [opts]
   */
  _getMcpAgent(role, opts = {}) {
    const transport = opts.transport || "stdio";
    const serverCommand = opts.serverCommand || "";
    const serverUrl = opts.serverUrl || "";
    const serverName = opts.serverName || role;

    if (transport === "stdio" && !serverCommand) {
      throw new Error(
        `MCP agent for role "${role}" requires a serverCommand for stdio transport. ` +
          `Configure design.stitch.serverCommand in coder.json.`,
      );
    }
    if (transport === "http" && !serverUrl) {
      throw new Error(
        `MCP agent for role "${role}" requires a serverUrl for HTTP transport. ` +
          `Configure design.stitch.serverUrl in coder.json.`,
      );
    }

    const keyId = transport === "http" ? serverUrl : serverCommand;
    const key = `mcp:${serverName}:${keyId}`;
    if (!this._agents.has(key)) {
      const retryCfg = this.config.agents?.retry;
      this._agents.set(
        key,
        new McpAgent({
          transport,
          serverCommand,
          serverArgs: opts.serverArgs || [],
          serverUrl,
          authHeader: opts.authHeader || "",
          env: opts.env || {},
          serverName,
          retries: retryCfg?.retries ?? 3,
          backoffMs: retryCfg?.backoffMs ?? 1000,
        }),
      );
    }
    return { agentName: serverName, agent: this._agents.get(key) };
  }

  /**
   * Get or create an API agent for direct HTTP calls.
   * @param {string} role
   * @param {{ provider?: "gemini" | "anthropic", systemPrompt?: string }} [opts]
   */
  _getApiAgent(role, opts = {}) {
    const provider = opts.provider || "gemini";
    const key = `api:${provider}:${role}`;
    if (!this._agents.has(key)) {
      this._agents.set(
        key,
        createApiAgent({
          config: this.config,
          secrets: this.secrets,
          provider,
          systemPrompt: opts.systemPrompt,
        }),
      );
    }
    const agentName = `${provider}-api`;
    return { agentName, agent: this._agents.get(key) };
  }

  _roleAgentName(role) {
    const selected = this.config.workflow?.agentRoles?.[role];
    return resolveAgentName(selected || "gemini");
  }

  /**
   * Update the repo root (e.g. after issue draft sets repoPath).
   */
  async setRepoRoot(repoRoot) {
    this.repoRoot = repoRoot;
    // Invalidate repo-scoped agents since cwd changed — kill before removing
    const stale = [];
    for (const [key, agent] of this._agents) {
      const parts = key.split(":");
      // cli agents keyed as cli:name:cwd — kill those pointing at a different repo root
      if (
        parts[0] === "cli" &&
        parts[2] !== repoRoot &&
        parts[2] !== this.workspaceDir
      ) {
        stale.push({ key, agent });
      }
    }
    for (const { key, agent } of stale) {
      this._agents.delete(key);
      await agent.kill();
    }
  }

  /**
   * Kill all agent processes.
   */
  async killAll() {
    const kills = [];
    for (const agent of this._agents.values()) {
      kills.push(agent.kill());
    }
    await Promise.allSettled(kills);
    this._agents.clear();
  }
}
