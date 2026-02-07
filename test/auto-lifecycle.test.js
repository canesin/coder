import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerAutoLifecycleTools } from "../src/mcp/tools/auto-lifecycle.js";
import { CoderOrchestrator } from "../src/orchestrator.js";

function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-auto-lifecycle-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

function makeServer() {
  const handlers = new Map();
  return {
    handlers,
    registerTool(name, _spec, handler) {
      handlers.set(name, handler);
    },
  };
}

test("coder_auto_start catches background run failures and releases active slot", async () => {
  const ws = makeWorkspace();
  const server = makeServer();

  const originalRunAuto = CoderOrchestrator.prototype.runAuto;
  CoderOrchestrator.prototype.runAuto = async function runAutoFailingStub() {
    throw new Error("boom");
  };

  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.once("unhandledRejection", onUnhandled);

  try {
    registerAutoLifecycleTools(server, ws);
    const start = server.handlers.get("coder_auto_start");
    assert.ok(start);

    const first = await start({ workspace: ws });
    assert.equal(first.isError, undefined);
    assert.equal(JSON.parse(first.content[0].text).status, "started");

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await start({ workspace: ws });
    assert.equal(second.isError, undefined);
    assert.equal(JSON.parse(second.content[0].text).status, "started");

    assert.equal(unhandled, null);
  } finally {
    CoderOrchestrator.prototype.runAuto = originalRunAuto;
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
