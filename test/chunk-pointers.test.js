import assert from "node:assert/strict";
import test from "node:test";
import { chunkPointers } from "../src/machines/research/_shared.js";

test("chunkPointers - prevents infinite loop when maxChars is 0", {
  timeout: 3000,
}, () => {
  const chunks = chunkPointers("a\nb\nc", { maxChars: 0 });
  assert.ok(Array.isArray(chunks), "should return an array");
  assert.deepEqual(chunks, ["a", "b", "c"]);
});

test("chunkPointers - chunks correctly on newlines with valid maxChars", () => {
  const chunks = chunkPointers("line1\nline2\nline3", { maxChars: 11 });
  assert.deepEqual(chunks, ["line1\nline2", "line3"]);
});

test("chunkPointers - coerces NaN maxChars to 1", {
  timeout: 3000,
}, () => {
  const chunks = chunkPointers("ab", { maxChars: NaN });
  assert.deepEqual(chunks, ["a", "b"]);
});

test("chunkPointers - coerces negative maxChars to 1", {
  timeout: 3000,
}, () => {
  const chunks = chunkPointers("ab", { maxChars: -5 });
  assert.deepEqual(chunks, ["a", "b"]);
});

test("chunkPointers - floors fractional maxChars", () => {
  const chunks = chunkPointers("abcde", { maxChars: 2.9 });
  assert.deepEqual(chunks, ["ab", "cd", "e"]);
});
