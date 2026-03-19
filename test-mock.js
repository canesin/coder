import test from "node:test";
import assert from "node:assert/strict";

test("mock node:child_process", async (t) => {
  t.mock.module("node:child_process", {
    namedExports: {
      spawnSync: () => ({ status: 123 })
    }
  });
  const { spawnSync } = await import("node:child_process");
  assert.equal(spawnSync().status, 123);
});
