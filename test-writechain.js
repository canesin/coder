import { saveLoopState, mutateLoopState, loadLoopState } from "./src/state/workflow-state.js";
import fs from "fs";

async function main() {
  await saveLoopState("/home/fcc/Programming/AITOOLS/coder/tmp", { runId: "123", status: "running" });
  console.log(fs.readFileSync("/home/fcc/Programming/AITOOLS/coder/tmp/.coder/loop-state.json", "utf8"));
}
main();
