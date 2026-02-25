import assert from "node:assert/strict";
import test from "node:test";
import { validateStitchConfig } from "../src/machines/design/_shared.js";
import { runDesignPipeline } from "../src/workflows/design.workflow.js";

function makeCtx(stitchConfig) {
  let agentCalled = false;
  return {
    ctx: {
      workspaceDir: "/tmp/test-gh83",
      repoPath: ".",
      config: {
        design: { stitch: stitchConfig, specDir: "spec/UI" },
        workflow: { timeouts: { designStep: 5000 }, hooks: [] },
      },
      agentPool: {
        getAgent() {
          agentCalled = true;
          return { agentName: "stub", agent: { execute: async () => ({}) } };
        },
      },
      log() {},
      cancelToken: { cancelled: false, paused: false },
      secrets: {},
      artifactsDir: "/tmp/test-gh83/.coder/artifacts",
      scratchpadDir: "/tmp/test-gh83/.coder/scratchpad",
    },
    wasAgentCalled: () => agentCalled,
  };
}

test("GH-83: runDesignPipeline throws immediately when stitch disabled", async () => {
  const { ctx, wasAgentCalled } = makeCtx({ enabled: false });
  await assert.rejects(
    () => runDesignPipeline({ intent: "test" }, ctx),
    (err) => {
      assert.match(err.message, /Stitch is not enabled/);
      return true;
    },
  );
  assert.equal(wasAgentCalled(), false, "no agent should be invoked");
});

test("GH-83: runDesignPipeline throws when stitch missing from config", async () => {
  const { ctx } = makeCtx(undefined);
  await assert.rejects(
    () => runDesignPipeline({ intent: "test" }, ctx),
    (err) => {
      assert.match(err.message, /Stitch is not enabled/);
      return true;
    },
  );
});

test("GH-83: runDesignPipeline throws when stdio transport missing serverCommand", async () => {
  const { ctx } = makeCtx({ enabled: true, transport: "stdio" });
  await assert.rejects(
    () => runDesignPipeline({ intent: "test" }, ctx),
    (err) => {
      assert.match(err.message, /server command not configured/i);
      return true;
    },
  );
});

test("GH-83: runDesignPipeline throws when http transport missing serverUrl", async () => {
  const { ctx } = makeCtx({ enabled: true, transport: "http" });
  await assert.rejects(
    () => runDesignPipeline({ intent: "test" }, ctx),
    (err) => {
      assert.match(err.message, /server URL not configured/i);
      return true;
    },
  );
});

test("GH-83: validateStitchConfig passes with valid stdio config", () => {
  const { ctx } = makeCtx({
    enabled: true,
    transport: "stdio",
    serverCommand: "npx stitch",
  });
  assert.doesNotThrow(() => validateStitchConfig(ctx));
});

test("GH-83: validateStitchConfig passes with valid http config", () => {
  const { ctx } = makeCtx({
    enabled: true,
    transport: "http",
    serverUrl: "http://localhost:3000",
  });
  assert.doesNotThrow(() => validateStitchConfig(ctx));
});
