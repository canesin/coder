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
  return path.join(workspaceDir, ".coder", "locks", "workflow-start.lock");
}

export function developPipelineLockPathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "locks", "develop-pipeline.lock");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryEvictStaleLock(lockPath, opts) {
  const staleLockMs = opts.staleLockMs ?? LOCK_DEFAULTS.staleLockMs;
  const corruptFileMinAgeMs =
    opts.corruptFileMinAgeMs ?? LOCK_DEFAULTS.corruptFileMinAgeMs;
  const evictOnlyDeadPid = opts.evictOnlyDeadPid === true;
  try {
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    const age = Date.now() - Date.parse(content.createdAt);
    const alive = isPidAlive(content.pid);
    const pidGone = alive === false || alive === null;
    const shouldEvict = evictOnlyDeadPid
      ? pidGone
      : age > staleLockMs || pidGone;
    if (shouldEvict) {
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

/**
 * @param {string} lockPath
 * @param {typeof LOCK_DEFAULTS & { busyMessage?: string, busyCode?: string }} opts
 */
async function acquireFileLock(lockPath, opts) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_DEFAULTS.lockTimeoutMs;
  const retryIntervalMs = opts.retryIntervalMs ?? LOCK_DEFAULTS.retryIntervalMs;
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
  const err = new Error(
    opts.busyMessage ??
      `lock busy: could not acquire ${lockPath} within ${lockTimeoutMs}ms`,
  );
  err.code = opts.busyCode ?? "LOCK_BUSY";
  throw err;
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

/**
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {typeof LOCK_DEFAULTS & { busyMessage?: string, busyCode?: string }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withFileLock(lockPath, fn, opts = {}) {
  const { token } = await acquireFileLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

export async function withStartLock(workspaceDir, fn, opts = {}) {
  return withFileLock(lockPathFor(workspaceDir), fn, {
    ...opts,
    busyMessage:
      opts.busyMessage ??
      `workflow start lock busy: could not acquire lock within ${opts.lockTimeoutMs ?? LOCK_DEFAULTS.lockTimeoutMs}ms`,
    busyCode: opts.busyCode ?? "WORKFLOW_START_LOCK_BUSY",
  });
}

/**
 * Serialize develop pipeline work on a workspace (CLI session ids, state.json).
 * Stale locks are evicted only when the recorded PID is not alive (no age-based eviction).
 *
 * @param {string} workspaceDir
 * @param {() => Promise<T>} fn
 * @param {typeof LOCK_DEFAULTS & { lockTimeoutMs?: number }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function withDevelopPipelineLock(workspaceDir, fn, opts = {}) {
  const lockPath = developPipelineLockPathFor(workspaceDir);
  const lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
  return withFileLock(lockPath, fn, {
    ...opts,
    evictOnlyDeadPid: true,
    lockTimeoutMs,
    busyMessage:
      opts.busyMessage ??
      `This workspace is already running a develop pipeline in another process (lock: ${lockPath}). ` +
        `Wait for it to finish, or if it crashed, remove the lock file after confirming no coder process is using this directory.`,
    busyCode: opts.busyCode ?? "DEVELOP_PIPELINE_LOCK_BUSY",
  });
}
