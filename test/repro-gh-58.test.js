import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import test from "node:test";
import { shellEscape } from "../src/helpers.js";

test("shellEscape wraps plain string in single quotes", () => {
  assert.equal(shellEscape("hello"), "'hello'");
});

test("shellEscape escapes embedded single quotes", () => {
  assert.equal(shellEscape("it's"), "'it'\\''s'");
});

test("shellEscape handles shell metacharacters", () => {
  assert.equal(shellEscape("$VAR"), "'$VAR'");
  assert.equal(shellEscape("`cmd`"), "'`cmd`'");
  assert.equal(shellEscape("a&b"), "'a&b'");
  assert.equal(shellEscape("a|b"), "'a|b'");
});

test("shellEscape prevents $(…) subshell injection via bash -lc echo", () => {
  const marker = "/tmp/RCE_SUCCESS_gh58";
  if (existsSync(marker)) unlinkSync(marker);

  const payload = `$(touch ${marker})`;
  const escaped = shellEscape(payload);
  spawnSync("bash", ["-lc", `echo ${escaped}`], { stdio: "inherit" });

  assert.equal(
    existsSync(marker),
    false,
    "RCE marker file must not be created",
  );
});

test("shellEscape prevents semicolon-injected command via bash -lc echo", () => {
  const marker = "/tmp/RCE_SUCCESS2_gh58";
  if (existsSync(marker)) unlinkSync(marker);

  const payload = `x; touch ${marker}`;
  const escaped = shellEscape(payload);
  spawnSync("bash", ["-lc", `echo ${escaped}`], { stdio: "inherit" });

  assert.equal(
    existsSync(marker),
    false,
    "RCE marker file must not be created",
  );
});
