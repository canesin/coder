import test from "node:test";
import assert from "node:assert/strict";

test("test 1", async (t) => {
  t.mock.module("node:child_process", {
    namedExports: { spawnSync: () => ({ status: 1 }) }
  });
  const { doSpawn } = await import("./module-under-test.js?1");
  assert.equal(doSpawn().status, 1);
});

test("test 2", async (t) => {
  t.mock.module("node:child_process", {
    namedExports: { spawnSync: () => ({ status: 2 }) }
  });
  const { doSpawn } = await import("./module-under-test.js?2");
  assert.equal(doSpawn().status, 2);
});
