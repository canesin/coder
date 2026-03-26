import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildNodeTestRunnerArgv } from "../src/coder-test-runner-args.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = [
  path.join(root, "test", "a.test.js"),
  path.join(root, "test", "b.test.js"),
];

test("empty user args: all default test files", () => {
  const argv = buildNodeTestRunnerArgv([], root, defaults);
  assert.deepEqual(argv, [
    "--experimental-test-module-mocks",
    "--test",
    ...defaults,
  ]);
});

test("explicit test file only: no default append", () => {
  const argv = buildNodeTestRunnerArgv(
    ["test/ppcommit.test.js"],
    root,
    defaults,
  );
  assert.equal(argv[0], "--experimental-test-module-mocks");
  assert.equal(argv[1], "--test");
  assert.equal(argv[2], path.join(root, "test", "ppcommit.test.js"));
  assert.equal(argv.length, 3);
});

test("--test-name-pattern without files: append defaults", () => {
  const argv = buildNodeTestRunnerArgv(
    ["--test-name-pattern", "foo"],
    root,
    defaults,
  );
  assert.deepEqual(argv, [
    "--experimental-test-module-mocks",
    "--test",
    "--test-name-pattern",
    "foo",
    ...defaults,
  ]);
});

test("pattern plus explicit file: no duplicate defaults", () => {
  const argv = buildNodeTestRunnerArgv(
    ["--test-name-pattern", "skip", "test/helpers.test.js"],
    root,
    defaults,
  );
  assert.equal(argv[2], "--test-name-pattern");
  assert.equal(argv[3], "skip");
  assert.equal(argv[4], path.join(root, "test", "helpers.test.js"));
  assert.equal(argv.length, 5);
});
