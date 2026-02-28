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

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 60_000;
const RETRY_INTERVAL_MS = 200;
const CORRUPT_FILE_MIN_AGE_MS = 2000;

export function lockPathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "start.lock");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryEvictStaleLock(lockPath) {
  try {
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    const age = Date.now() - Date.parse(content.createdAt);
    if (age > STALE_LOCK_MS || !isPidAlive(content.pid)) {
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== "ENOENT") return;
      }
    }
  } catch {
    // Empty/corrupt file — only evict if mtime is old enough
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > CORRUPT_FILE_MIN_AGE_MS) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    } catch {}
  }
}

async function acquireStartLock(workspaceDir) {
  const lockPath = lockPathFor(workspaceDir);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
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
      tryEvictStaleLock(lockPath);
      await sleep(RETRY_INTERVAL_MS);
    }
  }
  throw new Error(
    "workflow start lock busy: could not acquire lock within 5000ms",
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

export async function withStartLock(workspaceDir, fn) {
  const { lockPath, token } = await acquireStartLock(workspaceDir);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
