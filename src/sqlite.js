import { spawnSync } from "node:child_process";

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

/**
 * Run a SQL statement against a sqlite3 database via CLI.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {string} sql - SQL statement(s) to execute
 * @returns {string} stdout from sqlite3
 */
export function runSqlite(dbPath, sql, timeoutMs = 30000) {
  const res = spawnSync("sqlite3", [dbPath], {
    encoding: "utf8",
    input: `${sql}\n`,
    timeout: timeoutMs,
  });
  if (res.signal === "SIGTERM") {
    throw new Error(`sqlite3 query timed out after ${timeoutMs}ms`);
  }
  if (res.status !== 0) {
    throw new Error(
      `sqlite3 failed: ${(res.stderr || res.stdout || "").trim() || "unknown error"}`,
    );
  }
  return res.stdout || "";
}

/**
 * Persist a payload to SQLite via the sqlite3 CLI. No-op if sqlite3 is unavailable.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {string} sql - SQL to execute
 */
export function runSqliteIgnoreErrors(dbPath, sql) {
  if (!dbPath || !sqliteAvailable()) return;
  spawnSync("sqlite3", [dbPath], {
    encoding: "utf8",
    input: `${sql}\n`,
    stdio: ["pipe", "ignore", "ignore"],
  });
}
