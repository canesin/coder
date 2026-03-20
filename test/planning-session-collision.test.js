import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planningMachine from "../src/machines/develop/planning.machine.js";
import { loadState, saveState } from "../src/state/workflow-state.js";

function makeCommandFatalStderrError(message) {
  const err = new Error(message);
  err.name = "CommandFatalStderrError";
  err.category = "auth";
  return err;
}

test("planning: retries with fresh session when session ID is already in use (create path)", async () => {
  const tmp = mkdtempSync(
    path.join(os.tmpdir(), "planning-session-collision-"),
  );
  try {
    const repoRoot = path.join(tmp, "repo");
    mkdirSync(repoRoot, { recursive: true });
    execSync("git init -b main", { cwd: repoRoot, stdio: "ignore" });
    execSync("git config user.email t@t.com", {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execSync("git config user.name T", { cwd: repoRoot, stdio: "ignore" });
    writeFileSync(path.join(repoRoot, "README.md"), "# repo\n");
    execSync("git add README.md && git commit -m init", {
      cwd: repoRoot,
      stdio: "ignore",
    });

    const artifactsDir = path.join(tmp, ".coder", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(path.join(artifactsDir, "ISSUE.md"), "# Issue\n\nFix it.");

    await saveState(tmp, {
      selected: { source: "local", id: "1", title: "Issue 1" },
      repoPath: path.relative(tmp, repoRoot) || ".",
      steps: { wroteIssue: true },
      branch: "main",
    });

    let callCount = 0;
    const logEvents = [];
    const mockAgent = {
      async execute(_prompt, _opts) {
        callCount++;
        if (callCount === 1) {
          throw makeCommandFatalStderrError(
            "Error: Session ID 9b211b3e-9d0b-4f76-b5dd-2262c20b95e6 is already in use.",
          );
        }
        writeFileSync(path.join(artifactsDir, "PLAN.md"), "# Plan\n\nDo it.");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const ctx = {
      workspaceDir: tmp,
      artifactsDir,
      agentPool: {
        getAgent: () => ({ agentName: "claude", agent: mockAgent }),
      },
      log: (e) => logEvents.push(e),
      config: { workflow: { timeouts: { planning: 60000 } } },
    };

    const result = await planningMachine.run({}, ctx);

    assert.equal(result.status, "ok");
    assert.equal(callCount, 2, "should retry once after session collision");
    assert.ok(
      logEvents.some(
        (e) => e.event === "session_auth_failed" && e.wasCreating === true,
      ),
      "should log session_auth_failed with wasCreating",
    );
    assert.ok(existsSync(path.join(artifactsDir, "PLAN.md")));

    const state = await loadState(tmp);
    assert.ok(state.planningSessionId, "should have new planning session ID");
    assert.equal(state.steps.wrotePlan, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
