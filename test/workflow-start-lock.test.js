import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LOCK_DEFAULTS,
  lockPathFor,
  withStartLock,
} from "../src/state/start-lock.js";

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-start-lock-"));
  mkdirSync(path.join(dir, ".coder"), { recursive: true });
  return dir;
}

test("acquires and releases lock", async () => {
  const ws = makeTmpDir();
  let entered = false;
  await withStartLock(ws, async () => {
    entered = true;
    assert.ok(existsSync(lockPathFor(ws)));
  });
  assert.ok(entered);
  assert.ok(!existsSync(lockPathFor(ws)));
  rmSync(ws, { recursive: true, force: true });
});

test("concurrent starts: second caller gets lock-busy error", async () => {
  const ws = makeTmpDir();
  const opts = { lockTimeoutMs: 200, retryIntervalMs: 20 };
  const slow = withStartLock(
    ws,
    async () => {
      await new Promise((r) => setTimeout(r, 400));
      return "first";
    },
    opts,
  );
  // Give the first call time to acquire
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(() => withStartLock(ws, async () => "second", opts), {
    message: /workflow start lock busy/,
  });
  // Clean up the slow holder
  const result = await slow;
  assert.equal(result, "first");
  rmSync(ws, { recursive: true, force: true });
});

test("sequential starts: second caller succeeds after first releases", async () => {
  const ws = makeTmpDir();
  const r1 = await withStartLock(ws, async () => "a");
  const r2 = await withStartLock(ws, async () => "b");
  assert.equal(r1, "a");
  assert.equal(r2, "b");
  rmSync(ws, { recursive: true, force: true });
});

test("stale lock eviction by age", async () => {
  const ws = makeTmpDir();
  const lp = lockPathFor(ws);
  writeFileSync(
    lp,
    JSON.stringify({
      token: "old-token",
      pid: process.pid,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    }),
  );
  const result = await withStartLock(ws, async () => "evicted-age");
  assert.equal(result, "evicted-age");
  rmSync(ws, { recursive: true, force: true });
});

test("stale lock eviction by dead PID", async () => {
  const ws = makeTmpDir();
  const lp = lockPathFor(ws);
  writeFileSync(
    lp,
    JSON.stringify({
      token: "dead-token",
      pid: 999999,
      createdAt: new Date().toISOString(),
    }),
  );
  const result = await withStartLock(ws, async () => "evicted-pid");
  assert.equal(result, "evicted-pid");
  rmSync(ws, { recursive: true, force: true });
});

test("lock released on callback error", async () => {
  const ws = makeTmpDir();
  await assert.rejects(
    () =>
      withStartLock(ws, async () => {
        throw new Error("boom");
      }),
    { message: "boom" },
  );
  assert.ok(!existsSync(lockPathFor(ws)));
  rmSync(ws, { recursive: true, force: true });
});

test("corrupt lock file eviction (old mtime)", async () => {
  const ws = makeTmpDir();
  const lp = lockPathFor(ws);
  writeFileSync(lp, "NOT-JSON!!!");
  const oldTime = new Date(Date.now() - 120_000);
  utimesSync(lp, oldTime, oldTime);
  const result = await withStartLock(ws, async () => "evicted-corrupt");
  assert.equal(result, "evicted-corrupt");
  rmSync(ws, { recursive: true, force: true });
});

test("stale-evicted lock is not deleted by original holder", async () => {
  const ws = makeTmpDir();
  const lp = lockPathFor(ws);
  let holderAToken;
  // Acquire lock, capture internal state, then simulate stale eviction
  await withStartLock(ws, async () => {
    const content = JSON.parse(readFileSync(lp, "utf8"));
    holderAToken = content.token;
    // Overwrite with a different token (simulating holder B acquiring after eviction)
    writeFileSync(
      lp,
      JSON.stringify({
        token: "holder-b-token",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
    );
  });
  // releaseLock should NOT have deleted holder B's lock
  assert.ok(existsSync(lp));
  const remaining = JSON.parse(readFileSync(lp, "utf8"));
  assert.equal(remaining.token, "holder-b-token");
  assert.notEqual(holderAToken, "holder-b-token");
  rmSync(ws, { recursive: true, force: true });
});

test("custom options are accepted and used", async () => {
  const ws = makeTmpDir();
  const opts = { lockTimeoutMs: 100, retryIntervalMs: 10 };
  const result = await withStartLock(ws, async () => "custom", opts);
  assert.equal(result, "custom");
  assert.ok(!existsSync(lockPathFor(ws)));
  // Verify timeout uses custom value
  const lp = lockPathFor(ws);
  writeFileSync(
    lp,
    JSON.stringify({
      token: "blocker",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(() => withStartLock(ws, async () => "fail", opts), {
    message: /within 100ms/,
  });
  rmSync(ws, { recursive: true, force: true });
});

test("LOCK_DEFAULTS exports expected keys", () => {
  assert.ok(LOCK_DEFAULTS.lockTimeoutMs > 0);
  assert.ok(LOCK_DEFAULTS.staleLockMs > 0);
  assert.ok(LOCK_DEFAULTS.retryIntervalMs > 0);
  assert.ok(LOCK_DEFAULTS.corruptFileMinAgeMs > 0);
});
