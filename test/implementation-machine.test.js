import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import implementationMachine from "../src/machines/develop/implementation.machine.js";
import { loadState } from "../src/state/workflow-state.js";

function setupWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "impl-machine-"));
  execSync("git init -b main", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.email test@test", { cwd: tmp, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: tmp, stdio: "ignore" });
  writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n", "utf8");
  execSync("git add .gitignore && git commit -m init", {
    cwd: tmp,
    stdio: "ignore",
  });

  const artifactsDir = path.join(tmp, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n", "utf8");
  writeFileSync(
    path.join(artifactsDir, "PLANREVIEW.md"),
    "# Critique\n",
    "utf8",
  );
  mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  writeFileSync(
    path.join(tmp, ".coder", "state.json"),
    JSON.stringify({
      steps: { wrotePlan: true, wroteCritique: true },
      repoPath: "",
      branch: "main",
    }),
  );
  return { tmp, artifactsDir };
}

test("Codex without --session: persists __last__ on execute failure (exitCode !== 0)", async () => {
  const { tmp, artifactsDir } = setupWorkspace();
  const emptyCodexHome = mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  const origCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = emptyCodexHome;

  const mockAgent = {
    codexSessionSupported: () => false,
    async execute() {
      return { exitCode: 1, stdout: "", stderr: "some error" };
    },
  };

  const ctx = {
    workspaceDir: tmp,
    artifactsDir,
    log: () => {},
    config: {
      workflow: {
        timeouts: { implementation: 60000 },
        wip: {},
      },
    },
    agentPool: {
      getAgent: () => ({ agentName: "codex", agent: mockAgent }),
    },
  };

  const result = await implementationMachine.run({}, ctx);
  assert.equal(result.status, "error");
  const state = await loadState(tmp);
  assert.equal(state.programmerSessionId, "__last__");
  process.env.CODEX_HOME = origCodexHome;
});

test("Codex without --session: persists __last__ when execute throws", async () => {
  const { tmp, artifactsDir } = setupWorkspace();
  const emptyCodexHome = mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  const origCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = emptyCodexHome;

  const mockAgent = {
    codexSessionSupported: () => false,
    async execute() {
      const err = new Error("timeout");
      err.name = "CommandTimeoutError";
      throw err;
    },
  };

  const ctx = {
    workspaceDir: tmp,
    artifactsDir,
    log: () => {},
    config: {
      workflow: {
        timeouts: { implementation: 60000 },
        wip: {},
      },
    },
    agentPool: {
      getAgent: () => ({ agentName: "codex", agent: mockAgent }),
    },
  };

  const result = await implementationMachine.run({}, ctx);
  assert.equal(result.status, "error");
  const state = await loadState(tmp);
  assert.equal(state.programmerSessionId, "__last__");
  process.env.CODEX_HOME = origCodexHome;
});

test("Codex without --session: persists __last__ when auth retry execute throws", async () => {
  const { tmp, artifactsDir } = setupWorkspace();
  const emptyCodexHome = mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  const origCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = emptyCodexHome;

  let callCount = 0;
  const mockAgent = {
    codexSessionSupported: () => false,
    async execute() {
      callCount++;
      if (callCount === 1) {
        const err = new Error("session not found");
        err.name = "CommandFatalStderrError";
        err.category = "auth";
        throw err;
      }
      const err = new Error("timeout");
      err.name = "CommandTimeoutError";
      throw err;
    },
  };

  const ctx = {
    workspaceDir: tmp,
    artifactsDir,
    log: () => {},
    config: {
      workflow: {
        timeouts: { implementation: 60000 },
        wip: {},
      },
    },
    agentPool: {
      getAgent: () => ({ agentName: "codex", agent: mockAgent }),
    },
  };

  writeFileSync(
    path.join(tmp, ".coder", "state.json"),
    JSON.stringify({
      steps: { wrotePlan: true, wroteCritique: true },
      repoPath: "",
      branch: "main",
      programmerSessionId: "stale-session",
    }),
  );

  const result = await implementationMachine.run({}, ctx);
  assert.equal(result.status, "error");
  const state = await loadState(tmp);
  assert.equal(state.programmerSessionId, "__last__");
  process.env.CODEX_HOME = origCodexHome;
});
