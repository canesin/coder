import path from "node:path";

/**
 * Build argv for `node … --test …` so `npm test -- …` can pass through file paths
 * and `--test-name-pattern` (and other flags) like the stock npm script.
 *
 * When there is no explicit `*.test.js` path in user args, all default test files are appended
 * (so `npm test -- --test-name-pattern foo` still runs the suite with that filter).
 */
export function buildNodeTestRunnerArgv(userArgs, root, defaultTestFiles) {
  const hasExplicitTestFile = userArgs.some(
    (a) =>
      !a.startsWith("-") &&
      (a.endsWith(".test.js") ||
        a.endsWith(".test.mjs") ||
        a.endsWith(".test.cjs")),
  );

  const resolved = userArgs.map((a) => {
    if (a.startsWith("-")) return a;
    if (
      a.endsWith(".test.js") ||
      a.endsWith(".test.mjs") ||
      a.endsWith(".test.cjs")
    ) {
      return path.resolve(root, a);
    }
    return a;
  });

  const tail = hasExplicitTestFile
    ? resolved
    : [...resolved, ...defaultTestFiles];

  return ["--experimental-test-module-mocks", "--test", ...tail];
}
