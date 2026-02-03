#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWorkflowTools } from "../src/mcp/tools/workflow.js";
import { registerStatusTools } from "../src/mcp/tools/status.js";
import { registerResources } from "../src/mcp/resources.js";
import { registerPrompts } from "../src/mcp/prompts.js";

const server = new McpServer(
  { name: "coder", version: "0.3.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const defaultWorkspace = process.cwd();

registerWorkflowTools(server, defaultWorkspace);
registerStatusTools(server, defaultWorkspace);
registerResources(server, defaultWorkspace);
registerPrompts(server);

const transport = new StdioServerTransport();
await server.connect(transport);
