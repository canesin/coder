import { spawn, spawnSync } from "node:child_process";

let _sqliteAvailableCache = null;

/**
 * Check if sqlite3 CLI is available. Result is cached for process lifetime.
 */
export function sqliteAvailable() {
  if (_sqliteAvailableCache !== null) return _sqliteAvailableCache;
  const probe = spawnSync("sqlite3", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  _sqliteAvailableCache = probe.status === 0;
  return _sqliteAvailableCache;
}

/**
 * Escape a value for safe interpolation into a SQLite string literal.
 * Handles single quotes and strips NUL bytes (which can truncate strings
 * in some SQLite interfaces).
 */
export function sqlEscape(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .replace(/'/g, "''");
}

export class SqliteTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "SqliteTimeoutError";
  }
}

const KILL_GRACE_MS = 5000;

/**
 * Run SQL asynchronously via the sqlite3 CLI with timeout.
 * @param {string} dbPath
 * @param {string} sql
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runSqliteAsync(dbPath, sql, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("sqlite3", [dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killTimer = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      cleanup();
      if (killed) {
        reject(
          new SqliteTimeoutError(`sqlite3 timed out after ${timeoutMs}ms`),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `sqlite3 failed: ${(stderr || stdout || "").trim() || "unknown error"}`,
          ),
        );
        return;
      }
      resolve(stdout || "");
    });

    child.stdin.write(`${sql}\n`);
    child.stdin.end();
  });
}

/**
 * Async version of runSqliteIgnoreErrors. No-op if sqlite3 is unavailable.
 */
export async function runSqliteAsyncIgnoreErrors(dbPath, sql) {
  if (!dbPath || !sqliteAvailable()) return;
  try {
    await runSqliteAsync(dbPath, sql);
  } catch {
    // best-effort
  }
}
