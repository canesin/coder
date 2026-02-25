import { runTestCommand } from "./src/test-runner.js";
import path from "node:path";

const repoDir = process.cwd();
const argv = ["non-existent-binary", "test"];

const res = runTestCommand(repoDir, argv);
console.log(JSON.stringify(res, null, 2));

if (res.exitCode === 0) {
  console.error("FAIL: exitCode is 0 for missing binary!");
  process.exit(1);
} else {
  console.log("SUCCESS: exitCode is non-zero for missing binary.");
  process.exit(0);
}
