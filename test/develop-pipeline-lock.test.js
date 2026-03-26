import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  developPipelineLockPathFor,
  withDevelopPipelineLock,
} from "../src/state/start-lock.js";

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-dev-pipeline-lock-"));
  mkdirSync(path.join(dir, ".coder", "locks"), { recursive: true });
  return dir;
}

test("withDevelopPipelineLock acquires and releases develop-pipeline.lock", async () => {
  const ws = makeTmpDir();
  let entered = false;
  const lp = developPipelineLockPathFor(ws);
  await withDevelopPipelineLock(ws, async () => {
    entered = true;
    assert.ok(existsSync(lp));
  });
  assert.ok(entered);
  assert.ok(!existsSync(lp));
  rmSync(ws, { recursive: true, force: true });
});

test("concurrent develop pipelines: second caller gets busy error", async () => {
  const ws = makeTmpDir();
  const opts = { lockTimeoutMs: 200, retryIntervalMs: 20 };
  const slow = withDevelopPipelineLock(
    ws,
    async () => {
      await new Promise((r) => setTimeout(r, 400));
      return "first";
    },
    opts,
  );
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(
    () => withDevelopPipelineLock(ws, async () => "second", opts),
    (err) => {
      assert.equal(err.code, "DEVELOP_PIPELINE_LOCK_BUSY");
      assert.match(err.message, /already running a develop pipeline/i);
      return true;
    },
  );
  const result = await slow;
  assert.equal(result, "first");
  rmSync(ws, { recursive: true, force: true });
});
