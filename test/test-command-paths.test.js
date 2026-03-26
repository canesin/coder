import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertTestCommandPathsExist,
  collectRelativePathsFromShellCommand,
  extractBashCInnerStrings,
  findClosingDoubleQuote,
  resolveMonorepoTestCwd,
  splitAndChainSegmentsRespectingQuotes,
  stripOuterShellQuotes,
  stripTrailingRedirects,
  TestCommandPathError,
  unescapeDoubleQuotedBashBody,
} from "../src/test-command-paths.js";

test("collectRelativePathsFromShellCommand finds bash script path", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand("bash scripts/test.sh"),
    ["scripts/test.sh"],
  );
});

test("collectRelativePathsFromShellCommand normalizes ./ prefix", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand("bash ./scripts/test.sh"),
    ["scripts/test.sh"],
  );
});

test("collectRelativePathsFromShellCommand finds standalone ./path", () => {
  assert.deepEqual(collectRelativePathsFromShellCommand("cd x && ./run.sh"), [
    "run.sh",
  ]);
});

test("collectRelativePathsFromShellCommand ignores bare bash word", () => {
  assert.deepEqual(collectRelativePathsFromShellCommand("bash echo hi"), []);
});

test("collectRelativePathsFromShellCommand finds node relative script", () => {
  assert.deepEqual(collectRelativePathsFromShellCommand("node tools/run.cjs"), [
    "tools/run.cjs",
  ]);
});

test("collectRelativePathsFromShellCommand handles double-quoted bash operand", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand('bash "scripts/test.sh"'),
    ["scripts/test.sh"],
  );
});

test("collectRelativePathsFromShellCommand handles double-quoted node operand", () => {
  assert.deepEqual(
    collectRelativePathsFromShellCommand('node "tools/run.cjs"'),
    ["tools/run.cjs"],
  );
});

test("stripOuterShellQuotes removes one pair of quotes", () => {
  assert.equal(stripOuterShellQuotes('"scripts/a.sh"'), "scripts/a.sh");
  assert.equal(stripOuterShellQuotes("'x.sh'"), "x.sh");
  assert.equal(stripOuterShellQuotes("nope"), "nope");
});

test("stripTrailingRedirects trims >/dev/null after cd", () => {
  assert.equal(stripTrailingRedirects("cd .. >/dev/null"), "cd ..");
});

test("splitAndChainSegmentsRespectingQuotes does not split && inside quotes", () => {
  assert.deepEqual(
    splitAndChainSegmentsRespectingQuotes(
      'bash -c "cd .. && bash scripts/t.sh" && echo done',
    ),
    ['bash -c "cd .. && bash scripts/t.sh"', "echo done"],
  );
});

test("splitAndChainSegmentsRespectingQuotes handles backslash-escaped quotes outside quotes", () => {
  assert.deepEqual(
    splitAndChainSegmentsRespectingQuotes('echo \\"hi\\" && bash scripts/a.sh'),
    ['echo \\"hi\\"', "bash scripts/a.sh"],
  );
});

test("extractBashCInnerStrings finds bash -c and bash -lc bodies", () => {
  assert.deepEqual(
    extractBashCInnerStrings('bash -c "bash scripts/missing.sh"'),
    ["bash scripts/missing.sh"],
  );
  assert.deepEqual(
    extractBashCInnerStrings('bash -lc "cd .. && bash scripts/x.sh"'),
    ["cd .. && bash scripts/x.sh"],
  );
});

test("extractBashCInnerStrings finds clustered -ec / -xec style wrappers", () => {
  assert.deepEqual(
    extractBashCInnerStrings('bash -ec "bash scripts/missing.sh"'),
    ["bash scripts/missing.sh"],
  );
  assert.deepEqual(extractBashCInnerStrings('sh -ec "sh scripts/missing.sh"'), [
    "sh scripts/missing.sh",
  ]);
  assert.deepEqual(extractBashCInnerStrings('bash -uec "true"'), ["true"]);
});

test("assertTestCommandPathsExist rejects bash -ec when inner script missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-ec-"));
  assert.throws(
    () =>
      assertTestCommandPathsExist(dir, ['bash -ec "bash scripts/missing.sh"']),
    (e) => e instanceof TestCommandPathError,
  );
});

test("findClosingDoubleQuote skips escaped quotes", () => {
  const s = '"echo \\"hi\\" && bash scripts/x.sh"';
  assert.equal(findClosingDoubleQuote(s, 0), s.length - 1);
});

test("unescapeDoubleQuotedBashBody handles backslash escapes", () => {
  assert.equal(unescapeDoubleQuotedBashBody('echo \\"hi\\"'), 'echo "hi"');
  assert.equal(unescapeDoubleQuotedBashBody("a\\\\b"), "a\\b");
});

test("extractBashCInnerStrings decodes escaped quotes in -c body", () => {
  const cmd = 'bash -c "echo \\"hi\\" && bash scripts/missing.sh"';
  const inners = extractBashCInnerStrings(cmd);
  assert.equal(inners.length, 1);
  assert.equal(inners[0], 'echo "hi" && bash scripts/missing.sh');
});

test("assertTestCommandPathsExist rejects bash -c with escaped quotes when script missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-escq-"));
  const cmd = 'bash -c "echo \\"hi\\" && bash scripts/missing.sh"';
  assert.throws(
    () => assertTestCommandPathsExist(dir, [cmd]),
    (e) => e instanceof TestCommandPathError,
  );
});

test("collectRelativePathsFromShellCommand collects multiple bash scripts", () => {
  const paths = collectRelativePathsFromShellCommand(
    "bash scripts/a.sh && bash scripts/b.sh",
  );
  assert.equal(paths.includes("scripts/a.sh"), true);
  assert.equal(paths.includes("scripts/b.sh"), true);
});

test("assertTestCommandPathsExist throws when script missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-miss-"));
  assert.throws(
    () =>
      assertTestCommandPathsExist(dir, ["bash scripts/nope.sh"], {
        repoPath: "api",
      }),
    (err) => {
      assert.equal(err instanceof TestCommandPathError, true);
      assert.match(err.message, /does not exist under the effective directory/);
      assert.match(err.message, /repo_path: api/);
      return true;
    },
  );
});

test("assertTestCommandPathsExist passes when script exists", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-ok-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(dir, ["bash scripts/t.sh"], {}),
  );
  assert.equal(existsSync(path.join(dir, "scripts", "t.sh")), true);
});

test("assertTestCommandPathsExist passes for quoted bash path when file exists", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-quote-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(dir, ['bash "scripts/t.sh"'], {}),
  );
});

test("assertTestCommandPathsExist respects cd .. before bash script", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "tcp-cdup-"));
  const sub = path.join(parent, "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(parent, "scripts"), { recursive: true });
  writeFileSync(path.join(parent, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(sub, ["cd .. && bash scripts/t.sh"], {}),
  );
});

test("assertTestCommandPathsExist respects quoted cd target", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "tcp-cdqt-"));
  const sub = path.join(parent, "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(parent, "scripts"), { recursive: true });
  writeFileSync(path.join(parent, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(sub, ['cd ".." && bash scripts/t.sh'], {}),
  );
});

test("assertTestCommandPathsExist rejects bash -c inner script when missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tcp-bashc-"));
  assert.throws(
    () =>
      assertTestCommandPathsExist(dir, ['bash -c "bash scripts/missing.sh"']),
    (e) => e instanceof TestCommandPathError,
  );
});

test("assertTestCommandPathsExist validates bash -lc inner cd && bash chain", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "tcp-lc-"));
  const sub = path.join(parent, "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(parent, "scripts"), { recursive: true });
  writeFileSync(path.join(parent, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(sub, ['bash -lc "cd .. && bash scripts/t.sh"']),
  );
});

test("assertTestCommandPathsExist allows cd with redirect before &&", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "tcp-redir-"));
  const sub = path.join(parent, "api");
  mkdirSync(sub, { recursive: true });
  mkdirSync(path.join(parent, "scripts"), { recursive: true });
  writeFileSync(path.join(parent, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(sub, ["cd .. >/dev/null && bash scripts/t.sh"]),
  );
});

test("resolveMonorepoTestCwd uses workspace when scripts live at workspace root only", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "tcp-mono-"));
  const api = path.join(ws, "api");
  mkdirSync(api, { recursive: true });
  mkdirSync(path.join(ws, "scripts"), { recursive: true });
  writeFileSync(path.join(ws, "scripts", "t.sh"), "#\n");
  assert.equal(
    resolveMonorepoTestCwd(api, ws, ["bash scripts/t.sh"]),
    path.resolve(ws),
  );
});

test("assertTestCommandPathsExist passes for workspace scripts when repo_path is subdir", () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "tcp-wsmeta-"));
  const api = path.join(ws, "api");
  mkdirSync(api, { recursive: true });
  mkdirSync(path.join(ws, "scripts"), { recursive: true });
  writeFileSync(path.join(ws, "scripts", "t.sh"), "#\n");
  assert.doesNotThrow(() =>
    assertTestCommandPathsExist(api, ["bash scripts/t.sh"], {
      workspaceDir: ws,
      repoPath: "api",
    }),
  );
});
