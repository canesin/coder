/**
 * Environment defaults for `npm test` (see scripts/run-tests.mjs).
 * Preserves an explicitly set `CODER_PPCOMMIT_NO_AST` (including `0`) so
 * `CODER_PPCOMMIT_NO_AST=0 npm test` can enable tree-sitter AST checks.
 */
export function applyCoderTestEnvDefaults(env) {
  const e = { ...env };
  if (e.CODER_PPCOMMIT_NO_AST === undefined || e.CODER_PPCOMMIT_NO_AST === "") {
    e.CODER_PPCOMMIT_NO_AST = "1";
  }
  return e;
}
