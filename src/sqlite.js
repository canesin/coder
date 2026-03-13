import { spawn, spawnSync } from "node:child_process";

let _sqliteBackendCache;

/**
 * Detect which sqlite backend is available: "cli" (sqlite3), "python" (python3 sqlite3), or null.
 * Result is cached for process lifetime.
 */
export function _detectBackend() {
  if (_sqliteBackendCache !== undefined) return _sqliteBackendCache;
  const cli = spawnSync("sqlite3", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (cli.status === 0) {
    _sqliteBackendCache = "cli";
    return _sqliteBackendCache;
  }
  const py = spawnSync("python3", ["-c", "import sqlite3; print('ok')"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (py.status === 0 && (py.stdout || "").trim() === "ok") {
    _sqliteBackendCache = "python";
    return _sqliteBackendCache;
  }
  _sqliteBackendCache = null;
  return _sqliteBackendCache;
}

/**
 * Returns the detected backend: "cli", "python", or null.
 */
export function sqliteBackend() {
  return _detectBackend();
}

/** Reset cached backend detection (for testing only). */
export function __resetBackendCacheForTests() {
  _sqliteBackendCache = undefined;
}

/**
 * Check if any sqlite backend is available. Result is cached for process lifetime.
 */
export function sqliteAvailable() {
  return _detectBackend() !== null;
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
  constructor(message, { dbPath, timeoutMs, graceMs } = {}) {
    super(message);
    this.name = "SqliteTimeoutError";
    this.code = "SQLITE_TIMEOUT";
    this.dbPath = dbPath ?? null;
    this.timeoutMs = timeoutMs ?? null;
    this.graceMs = graceMs ?? null;
  }
}

const KILL_GRACE_MS = 5000;

/**
 * Run SQL via Python's sqlite3 stdlib module (fallback when sqlite3 CLI is unavailable).
 */
function _runSqliteViaPython(dbPath, sql, { timeoutMs = 30000 } = {}) {
  const fullPyScript = `
import sys, sqlite3, io
db = sqlite3.connect(sys.argv[1])
sql = sys.stdin.read()
for stmt in sql.split(';'):
    stmt = stmt.strip()
    if not stmt:
        continue
    try:
        cur = db.execute(stmt)
        if cur.description:
            for row in cur.fetchall():
                print('|'.join(str(c) for c in row))
    except Exception as e:
        print(str(e), file=sys.stderr)
        db.close()
        sys.exit(1)
db.commit()
db.close()
`;
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", fullPyScript, dbPath], {
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
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
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
          new SqliteTimeoutError(
            `python3 sqlite3 timed out after ${timeoutMs}ms`,
            { dbPath, timeoutMs, graceMs: 5000 },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `python3 sqlite3 failed: ${(stderr || stdout || "").trim() || "unknown error"}`,
          ),
        );
        return;
      }
      resolve(stdout || "");
    });

    child.stdin.write(sql);
    child.stdin.end();
  });
}

/**
 * Run SQL asynchronously via the sqlite3 CLI (or Python fallback) with timeout.
 * @param {string} dbPath
 * @param {string} sql
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runSqliteAsync(dbPath, sql, { timeoutMs = 30000 } = {}) {
  const backend = _detectBackend();
  if (backend === "python") {
    return _runSqliteViaPython(dbPath, sql, { timeoutMs });
  }
  if (backend === null) {
    return Promise.reject(
      new Error(
        "No sqlite backend available (neither sqlite3 CLI nor python3 sqlite3)",
      ),
    );
  }
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
          new SqliteTimeoutError(`sqlite3 timed out after ${timeoutMs}ms`, {
            dbPath,
            timeoutMs,
            graceMs: KILL_GRACE_MS,
          }),
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
