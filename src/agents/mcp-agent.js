import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pRetry, { AbortError } from "p-retry";
import { AgentAdapter } from "./_base.js";

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isTransientError(err) {
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (err instanceof TypeError && /fetch failed/i.test(err.message))
    return true;
  // Duck-type StreamableHTTPError (numeric .code = HTTP status)
  if (typeof err.code === "number") return err.code >= 500;
  return false;
}

/**
 * McpAgent — connects to an external MCP server and calls tools programmatically.
 *
 * Used for services like Google Stitch that expose tool APIs via MCP.
 * Unlike CliAgent which spawns shell processes, McpAgent uses the MCP SDK client
 * to make structured tool calls.
 *
 * Supports two transports:
 * - "stdio" (default): spawns a local process via StdioClientTransport
 * - "http": connects to a remote server via StreamableHTTPClientTransport
 */
export class McpAgent extends AgentAdapter {
  /**
   * @param {{
   *   transport?: "stdio" | "http",
   *   serverCommand?: string,
   *   serverArgs?: string[],
   *   serverUrl?: string,
   *   authHeader?: string,
   *   env?: Record<string, string>,
   *   serverName?: string,
   *   retries?: number,
   *   backoffMs?: number,
   * }} opts
   */
  constructor(opts) {
    super();
    this.transportType = opts.transport || "stdio";
    this.serverCommand = opts.serverCommand || "";
    this.serverArgs = opts.serverArgs || [];
    this.serverUrl = opts.serverUrl || "";
    this.authHeader = opts.authHeader || "";
    this.env = opts.env || {};
    this.serverName = opts.serverName || "mcp-server";
    this._retries = opts.retries ?? 3;
    this._backoffMs = opts.backoffMs ?? 1000;

    /** @type {Client|null} */
    this._client = null;
    /** @type {import("@modelcontextprotocol/sdk/shared/transport.js").Transport|null} */
    this._transport = null;
    /** @type {Map<string, object>|null} */
    this._toolsCache = null;
  }

  _withRetry(fn, label) {
    if (this.transportType !== "http" || this._retries === 0) return fn();
    return pRetry(
      async () => {
        try {
          return await fn();
        } catch (err) {
          if (!isTransientError(err)) throw new AbortError(err);
          throw err;
        }
      },
      {
        retries: this._retries,
        minTimeout: this._backoffMs,
        factor: 2,
        onFailedAttempt: (err) => {
          process.stderr.write(
            `[mcp-agent] ${label} attempt=${err.attemptNumber} left=${err.retriesLeft} error=${err.message?.slice(0, 200)}\n`,
          );
        },
      },
    );
  }

  async _ensureClient() {
    if (this._client) return this._client;

    return this._withRetry(async () => {
      // Reset stale state from a prior failed attempt
      this._client = null;
      this._transport = null;

      if (this.transportType === "http") {
        if (!this.serverUrl) {
          throw new Error(
            "McpAgent: serverUrl is required for HTTP transport.",
          );
        }
        const url = new URL(this.serverUrl);
        const requestInit = {};

        if (this.authHeader) {
          const apiKey = Object.values(this.env)[0] || "";
          if (apiKey) {
            requestInit.headers = { [this.authHeader]: apiKey };
          }
        }

        this._transport = new StreamableHTTPClientTransport(url, {
          requestInit,
        });
      } else {
        if (!this.serverCommand) {
          throw new Error(
            "McpAgent: serverCommand is required for stdio transport.",
          );
        }
        this._transport = new StdioClientTransport({
          command: this.serverCommand,
          args: this.serverArgs,
          env: { ...process.env, ...this.env },
        });
      }

      this._client = new Client(
        { name: "coder-mcp-agent", version: "1.0.0" },
        { capabilities: {} },
      );

      await this._client.connect(this._transport);
      return this._client;
    }, "connect");
  }

  /**
   * List available tools from the connected MCP server.
   * @returns {Promise<Array<{ name: string, description: string, inputSchema: object }>>}
   */
  async listTools() {
    const client = await this._ensureClient();
    const result = await this._withRetry(() => client.listTools(), "listTools");
    const tools = result.tools || [];
    this._toolsCache = new Map(tools.map((t) => [t.name, t]));
    return tools;
  }

  /**
   * Call a tool on the connected MCP server.
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<{ content: Array<{ type: string, text?: string, data?: string, mimeType?: string }>, isError?: boolean }>}
   */
  async callTool(toolName, args = {}) {
    const client = await this._ensureClient();
    return this._withRetry(
      () => client.callTool({ name: toolName, arguments: args }),
      "callTool",
    );
  }

  /**
   * Call a tool and extract text content.
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<string>}
   */
  async callToolText(toolName, args = {}) {
    const result = await this.callTool(toolName, args);
    if (result.isError) {
      const errText = (result.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      throw new Error(
        `MCP tool ${toolName} failed: ${errText || "unknown error"}`,
      );
    }
    return (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  /**
   * Call a tool and extract image content (base64).
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<{ data: string, mimeType: string }|null>}
   */
  async callToolImage(toolName, args = {}) {
    const result = await this.callTool(toolName, args);
    if (result.isError) {
      const errText = (result.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      throw new Error(
        `MCP tool ${toolName} failed: ${errText || "unknown error"}`,
      );
    }
    const imageContent = (result.content || []).find((c) => c.type === "image");
    return imageContent
      ? { data: imageContent.data, mimeType: imageContent.mimeType }
      : null;
  }

  /**
   * AgentAdapter interface — execute a prompt.
   * For MCP agents this is less natural; we provide a basic implementation
   * that describes available tools.
   */
  async execute(prompt, _opts = {}) {
    try {
      const tools = await this.listTools();
      return {
        exitCode: 0,
        stdout: JSON.stringify({ tools: tools.map((t) => t.name), prompt }),
        stderr: "",
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      };
    }
  }

  async executeStructured(prompt, opts = {}) {
    const res = await this.execute(prompt, opts);
    return {
      ...res,
      parsed: res.exitCode === 0 ? JSON.parse(res.stdout) : undefined,
    };
  }

  async kill() {
    if (this._client) {
      try {
        await this._client.close();
      } catch {
        // best-effort
      }
      this._client = null;
    }
    if (this._transport) {
      try {
        await this._transport.close();
      } catch {
        // best-effort
      }
      this._transport = null;
    }
    this._toolsCache = null;
  }
}
