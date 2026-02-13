import assert from "node:assert/strict";
import test from "node:test";
import { sqlEscape, sqliteAvailable } from "../src/sqlite.js";

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
