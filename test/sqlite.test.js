import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runSqliteAsync,
  runSqliteAsyncIgnoreErrors,
  SqliteTimeoutError,
  sqlEscape,
  sqliteAvailable,
} from "../src/sqlite.js";

test("sqlEscape handles quoting, NUL bytes, and null/undefined coercion", () => {
  // single-quote escaping
  assert.equal(sqlEscape("it's"), "it''s");
  assert.equal(sqlEscape("a'b'c"), "a''b''c");
  // NUL byte stripping
  assert.equal(sqlEscape("hello\0world"), "helloworld");
  // null/undefined -> empty string
  assert.equal(sqlEscape(null), "");
  assert.equal(sqlEscape(undefined), "");
  assert.equal(sqlEscape(""), "");
  // pass-through for normal strings
  assert.equal(sqlEscape("hello world"), "hello world");
});

test("sqliteAvailable returns a boolean and caches result", () => {
  const result1 = sqliteAvailable();
  const result2 = sqliteAvailable();
  assert.equal(typeof result1, "boolean");
  assert.equal(result1, result2);
});

test("runSqliteAsync resolves valid SQL", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "coder-sqlite-"));
  const dbPath = path.join(tmpDir, "test.db");
  try {
    await runSqliteAsync(
      dbPath,
      "CREATE TABLE t(id INTEGER PRIMARY KEY, val TEXT);",
    );
    await runSqliteAsync(dbPath, "INSERT INTO t(val) VALUES ('hello');");
    const out = await runSqliteAsync(dbPath, "SELECT val FROM t;");
    assert.ok(out.includes("hello"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runSqliteAsync rejects on invalid SQL", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "coder-sqlite-"));
  const dbPath = path.join(tmpDir, "test.db");
  try {
    await assert.rejects(() => runSqliteAsync(dbPath, "INVALID SQL HERE;"), {
      message: /sqlite3 failed/,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runSqliteAsync times out and throws SqliteTimeoutError", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "coder-sqlite-"));
  const dbPath = path.join(tmpDir, "test.db");
  try {
    // Recursive CTE that runs long enough to trigger a short timeout
    const slowSql = `
      WITH RECURSIVE cnt(x) AS (
        VALUES(1) UNION ALL SELECT x+1 FROM cnt WHERE x < 999999999
      ) SELECT count(*) FROM cnt;
    `;
    await assert.rejects(
      () => runSqliteAsync(dbPath, slowSql, { timeoutMs: 200 }),
      (err) => {
        assert.ok(err instanceof SqliteTimeoutError);
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("timed out"));
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runSqliteAsyncIgnoreErrors swallows errors", async () => {
  // Should not throw for bad SQL
  await runSqliteAsyncIgnoreErrors("/nonexistent/path.db", "INVALID SQL;");
});

test("SqliteTimeoutError is an instance of Error", () => {
  const err = new SqliteTimeoutError("test");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof SqliteTimeoutError);
  assert.equal(err.name, "SqliteTimeoutError");
});
