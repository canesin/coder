import { buildSecrets, DEFAULT_PASS_ENV } from "../helpers.js";
import { createApiAgent } from "./api-agent.js";
import { CliAgent, resolveAgentName } from "./cli-agent.js";
import { McpAgent } from "./mcp-agent.js";

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
    this.secrets = buildSecrets(opts.passEnv || DEFAULT_PASS_ENV);
    this.verbose = opts.verbose ?? opts.config.verbose;

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

    if (mode === "cli") {
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
          }),
        );
      }
      return { agentName, agent: this._agents.get(key) };
    }

    if (mode === "api") {
      return this._getApiAgent(role, opts);
    }

    if (mode === "mcp") {
      return this._getMcpAgent(role, opts);
    }

    throw new Error(`Agent mode "${mode}" is not supported`);
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
      const secondColonIndex = key.indexOf(":", key.indexOf(":") + 1);
      const extractedCwd =
        secondColonIndex === -1 ? "" : key.substring(secondColonIndex + 1);
      // cli agents keyed as cli:name:cwd — kill those pointing at a different repo root
      if (
        key.startsWith("cli:") &&
        extractedCwd !== repoRoot &&
        extractedCwd !== this.workspaceDir
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
