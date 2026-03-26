import assert from "node:assert/strict";
import test from "node:test";

import { applyCoderTestEnvDefaults } from "../src/coder-test-env.js";

test("applyCoderTestEnvDefaults sets CODER_PPCOMMIT_NO_AST=1 when unset", () => {
  const r = applyCoderTestEnvDefaults({ NODE_ENV: "test" });
  assert.equal(r.CODER_PPCOMMIT_NO_AST, "1");
});

test("applyCoderTestEnvDefaults sets CODER_PPCOMMIT_NO_AST=1 when empty string", () => {
  const r = applyCoderTestEnvDefaults({
    NODE_ENV: "test",
    CODER_PPCOMMIT_NO_AST: "",
  });
  assert.equal(r.CODER_PPCOMMIT_NO_AST, "1");
});

test("applyCoderTestEnvDefaults preserves explicit CODER_PPCOMMIT_NO_AST=0", () => {
  const r = applyCoderTestEnvDefaults({
    CODER_PPCOMMIT_NO_AST: "0",
  });
  assert.equal(r.CODER_PPCOMMIT_NO_AST, "0");
});

test("applyCoderTestEnvDefaults preserves explicit CODER_PPCOMMIT_NO_AST=1", () => {
  const r = applyCoderTestEnvDefaults({
    CODER_PPCOMMIT_NO_AST: "1",
  });
  assert.equal(r.CODER_PPCOMMIT_NO_AST, "1");
});
