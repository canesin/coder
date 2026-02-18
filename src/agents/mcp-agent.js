import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentAdapter } from "./_base.js";

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

    /** @type {Client|null} */
    this._client = null;
    /** @type {import("@modelcontextprotocol/sdk/shared/transport.js").Transport|null} */
    this._transport = null;
    /** @type {Map<string, object>|null} */
    this._toolsCache = null;
  }

  async _ensureClient() {
    if (this._client) return this._client;

    if (this.transportType === "http") {
      if (!this.serverUrl) {
        throw new Error("McpAgent: serverUrl is required for HTTP transport.");
      }
      const url = new URL(this.serverUrl);
      const requestInit = {};

      // Set auth header if API key is available
      if (this.authHeader) {
        // Look for the API key in env (passed from config resolution)
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
  }

  /**
   * List available tools from the connected MCP server.
   * @returns {Promise<Array<{ name: string, description: string, inputSchema: object }>>}
   */
  async listTools() {
    const client = await this._ensureClient();
    const result = await client.listTools();
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
    return client.callTool({ name: toolName, arguments: args });
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
      parsed: res.exitCode === 0 ? JSON.parse(res.stdout) : null,
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
