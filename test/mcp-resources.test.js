import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerResources } from "../src/mcp/resources.js";

function makeWorkspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-mcp-resources-"));
  mkdirSync(path.join(ws, ".coder", "artifacts"), { recursive: true });
  return ws;
}

function makeServer() {
  const resources = new Map();
  return {
    resource(_name, uri, _meta, handler) {
      resources.set(uri, handler);
    },
    resources,
  };
}

test("MCP markdown resources read from .coder/artifacts", async () => {
  const ws = makeWorkspace();
  writeFileSync(path.join(ws, ".coder", "artifacts", "ISSUE.md"), "# Issue\n", "utf8");
  writeFileSync(path.join(ws, ".coder", "artifacts", "PLAN.md"), "# Plan\n", "utf8");
  writeFileSync(path.join(ws, ".coder", "artifacts", "PLANREVIEW.md"), "# Critique\n", "utf8");

  const server = makeServer();
  registerResources(server, ws);

  const issue = await server.resources.get("coder://issue")();
  const plan = await server.resources.get("coder://plan")();
  const critique = await server.resources.get("coder://critique")();

  assert.match(issue.contents[0].text, /^# Issue/m);
  assert.match(plan.contents[0].text, /^# Plan/m);
  assert.match(critique.contents[0].text, /^# Critique/m);
});
