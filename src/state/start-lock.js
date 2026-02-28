import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { isPidAlive } from "../helpers.js";

export const LOCK_DEFAULTS = {
  lockTimeoutMs: 5000,
  staleLockMs: 60_000,
  retryIntervalMs: 200,
  corruptFileMinAgeMs: 2000,
};

export function lockPathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "start.lock");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryEvictStaleLock(lockPath, opts) {
  const staleLockMs = opts.staleLockMs ?? LOCK_DEFAULTS.staleLockMs;
  const corruptFileMinAgeMs =
    opts.corruptFileMinAgeMs ?? LOCK_DEFAULTS.corruptFileMinAgeMs;
  try {
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    const age = Date.now() - Date.parse(content.createdAt);
    if (age > staleLockMs || !isPidAlive(content.pid)) {
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code === "ENOENT") return;
      }
    }
  } catch {
    // Empty/corrupt file — only evict if mtime is old enough
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > corruptFileMinAgeMs) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    } catch {}
  }
}

async function acquireStartLock(workspaceDir, opts) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_DEFAULTS.lockTimeoutMs;
  const retryIntervalMs = opts.retryIntervalMs ?? LOCK_DEFAULTS.retryIntervalMs;
  const lockPath = lockPathFor(workspaceDir);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + lockTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      const data = JSON.stringify({
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      });
      writeSync(fd, data);
      closeSync(fd);
      return { lockPath, token };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      tryEvictStaleLock(lockPath, opts);
      await sleep(retryIntervalMs * (0.5 + Math.random()));
    }
  }
  throw new Error(
    `workflow start lock busy: could not acquire lock within ${lockTimeoutMs}ms`,
  );
}

function releaseLock(lockPath, token) {
  try {
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    if (content.token !== token) return;
    unlinkSync(lockPath);
  } catch (err) {
    if (err.code === "ENOENT") return;
    console.error(`[coder] warning: lock release failed: ${err.message}`);
  }
}

export async function withStartLock(workspaceDir, fn, opts = {}) {
  const { lockPath, token } = await acquireStartLock(workspaceDir, opts);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
