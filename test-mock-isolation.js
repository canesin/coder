import test from "node:test";
import assert from "node:assert/strict";

test("test 1", async (t) => {
  t.mock.module("node:child_process", {
    namedExports: { spawnSync: () => ({ status: 1 }) }
  });
  const cp = await import("node:child_process");
  assert.equal(cp.spawnSync().status, 1);
});

test("test 2", async (t) => {
  t.mock.module("node:child_process", {
    namedExports: { spawnSync: () => ({ status: 2 }) }
  });
  const cp = await import("node:child_process");
  assert.equal(cp.spawnSync().status, 2);
});
