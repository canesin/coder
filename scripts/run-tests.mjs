#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCoderTestEnvDefaults } from "../src/coder-test-env.js";
import { buildNodeTestRunnerArgv } from "../src/coder-test-runner-args.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = applyCoderTestEnvDefaults({ ...process.env, NODE_ENV: "test" });

const defaultTestFiles = readdirSync(path.join(root, "test"))
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(root, "test", f))
  .sort();

const userArgs = process.argv.slice(2);
const args = buildNodeTestRunnerArgv(userArgs, root, defaultTestFiles);

const r = spawnSync(process.execPath, args, {
  env,
  stdio: "inherit",
  cwd: root,
});

process.exit(r.status === null ? 1 : r.status);
