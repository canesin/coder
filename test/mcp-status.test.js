import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerStatusTools } from "../src/mcp/tools/status.js";

function makeWorkspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-mcp-status-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  mkdirSync(path.join(ws, ".coder", "scratchpad"), { recursive: true });
  return ws;
}

function makeServer() {
  const tools = new Map();
  return {
    registerTool(name, _meta, handler) {
      tools.set(name, handler);
    },
    tools,
  };
}

test("coder_status mcpHealth is null when mcp-health.json does not exist", async () => {
  const ws = makeWorkspace();
  const server = makeServer();
  registerStatusTools(server, ws);

  const result = await server.tools.get("coder_status")({ workspace: ws });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.mcpHealth, null);
});

test("coder_status mcpHealth returns parsed JSON when mcp-health.json is valid", async () => {
  const ws = makeWorkspace();
  const health = { gemini: { ok: true }, claude: { ok: false } };
  writeFileSync(
    path.join(ws, ".coder", "mcp-health.json"),
    JSON.stringify(health),
    "utf8",
  );

  const server = makeServer();
  registerStatusTools(server, ws);

  const result = await server.tools.get("coder_status")({ workspace: ws });
  const status = JSON.parse(result.content[0].text);
  assert.deepEqual(status.mcpHealth, health);
});

test("coder_status mcpHealth is null when mcp-health.json contains invalid JSON", async () => {
  const ws = makeWorkspace();
  writeFileSync(
    path.join(ws, ".coder", "mcp-health.json"),
    "not valid json",
    "utf8",
  );

  const server = makeServer();
  registerStatusTools(server, ws);

  const result = await server.tools.get("coder_status")({ workspace: ws });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.mcpHealth, null);
});
