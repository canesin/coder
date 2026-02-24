import assert from "node:assert/strict";
import test from "node:test";
import { HostSandboxProvider } from "../src/host-sandbox.js";
import { runShellSync } from "../src/systemd-run.js";

test("GH-60: strip CLAUDECODE from HostSandboxProvider", async () => {
  const orig = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  try {
    const provider = new HostSandboxProvider();
    const sandbox = await provider.create();
    const res = await sandbox.commands.run("env | grep CLAUDECODE || true");
    assert.equal(
      res.stdout.trim(),
      "",
      "CLAUDECODE should be stripped from sandbox",
    );
  } finally {
    if (orig === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = orig;
  }
});

test("GH-60: strip CLAUDECODE from runShellSync", async () => {
  const orig = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  try {
    const res = runShellSync("env | grep CLAUDECODE || true");
    assert.equal(
      res.stdout.trim(),
      "",
      "CLAUDECODE should be stripped from runShellSync",
    );
  } finally {
    if (orig === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = orig;
  }
});
