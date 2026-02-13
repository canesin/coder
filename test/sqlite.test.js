import assert from "node:assert/strict";
import test from "node:test";
import { sqlEscape, sqliteAvailable } from "../src/sqlite.js";

test("sqlEscape escapes single quotes", () => {
  assert.equal(sqlEscape("it's"), "it''s");
  assert.equal(sqlEscape("a'b'c"), "a''b''c");
});

test("sqlEscape strips NUL bytes", () => {
  assert.equal(sqlEscape("hello\0world"), "helloworld");
  assert.equal(sqlEscape("\0start"), "start");
});

test("sqlEscape handles null, undefined, and empty string", () => {
  assert.equal(sqlEscape(null), "");
  assert.equal(sqlEscape(undefined), "");
  assert.equal(sqlEscape(""), "");
});

test("sqlEscape handles normal strings without modification", () => {
  assert.equal(sqlEscape("hello world"), "hello world");
  assert.equal(
    sqlEscape("2026-01-01T00:00:00.000Z"),
    "2026-01-01T00:00:00.000Z",
  );
});

test("sqliteAvailable returns a boolean and caches result", () => {
  const result1 = sqliteAvailable();
  const result2 = sqliteAvailable();
  assert.equal(typeof result1, "boolean");
  assert.equal(result1, result2);
});
