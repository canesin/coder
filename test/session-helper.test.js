import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  supportsSession,
  withSessionResume,
} from "../src/machines/develop/_session.js";
import { loadState, saveState } from "../src/state/workflow-state.js";

describe("supportsSession", () => {
  it("returns true for claude", () => {
    assert.equal(supportsSession("claude", {}), true);
  });

  it("returns true for codex with session support", () => {
    assert.equal(
      supportsSession("codex", { codexSessionSupported: () => true }),
      true,
    );
  });

  it("returns false for codex without session support", () => {
    assert.equal(
      supportsSession("codex", { codexSessionSupported: () => false }),
      false,
    );
  });

  it("returns false for codex with no codexSessionSupported method", () => {
    assert.equal(supportsSession("codex", {}), false);
  });

  it("returns false for gemini", () => {
    assert.equal(supportsSession("gemini", {}), false);
  });
});

describe("withSessionResume", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "session-helper-"));
    mkdirSync(path.join(tmp, ".coder"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a new session ID on first call for claude", async () => {
    await saveState(tmp, {});
    const state = await loadState(tmp);

    const execResult = { stdout: "ok", exitCode: 0 };
    let capturedOpts;
    const res = await withSessionResume({
      agentName: "claude",
      agent: {},
      state,
      sessionKey: "testSessionId",
      agentNameKey: "testAgentName",
      workspaceDir: tmp,
      log: () => {},
      executeFn: (opts) => {
        capturedOpts = opts;
        return Promise.resolve(execResult);
      },
    });

    assert.equal(res, execResult);
    assert.ok(capturedOpts.sessionId, "should pass sessionId on first call");
    assert.equal(capturedOpts.resumeId, undefined);
    assert.equal(state.testSessionId, capturedOpts.sessionId);
    assert.equal(state.testAgentName, "claude");
  });

  it("resumes existing session on subsequent call", async () => {
    await saveState(tmp, {
      testSessionId: "existing-id",
      testAgentName: "claude",
    });
    const state = await loadState(tmp);

    let capturedOpts;
    await withSessionResume({
      agentName: "claude",
      agent: {},
      state,
      sessionKey: "testSessionId",
      agentNameKey: "testAgentName",
      workspaceDir: tmp,
      log: () => {},
      executeFn: (opts) => {
        capturedOpts = opts;
        return Promise.resolve({ stdout: "ok" });
      },
    });

    assert.equal(capturedOpts.resumeId, "existing-id");
    assert.equal(capturedOpts.sessionId, undefined);
  });

  it("passes empty opts for unsupported agents", async () => {
    await saveState(tmp, {});
    const state = await loadState(tmp);

    let capturedOpts;
    await withSessionResume({
      agentName: "gemini",
      agent: {},
      state,
      sessionKey: "testSessionId",
      agentNameKey: "testAgentName",
      workspaceDir: tmp,
      log: () => {},
      executeFn: (opts) => {
        capturedOpts = opts;
        return Promise.resolve({ stdout: "ok" });
      },
    });

    assert.deepEqual(capturedOpts, {});
    assert.equal(state.testSessionId, undefined);
  });

  it("invalidates session when agent changes", async () => {
    await saveState(tmp, {
      testSessionId: "old-session",
      testAgentName: "codex",
    });
    const state = await loadState(tmp);

    let capturedOpts;
    await withSessionResume({
      agentName: "claude",
      agent: {},
      state,
      sessionKey: "testSessionId",
      agentNameKey: "testAgentName",
      workspaceDir: tmp,
      log: () => {},
      executeFn: (opts) => {
        capturedOpts = opts;
        return Promise.resolve({ stdout: "ok" });
      },
    });

    assert.ok(
      capturedOpts.sessionId,
      "should create new session after agent change",
    );
    assert.notEqual(capturedOpts.sessionId, "old-session");
    assert.equal(state.testAgentName, "claude");
  });

  it("retries with fresh session on auth error during resume", async () => {
    await saveState(tmp, {
      testSessionId: "existing-id",
      testAgentName: "claude",
    });
    const state = await loadState(tmp);

    const authErr = new Error("auth failed");
    authErr.name = "CommandFatalStderrError";
    authErr.category = "auth";

    let callCount = 0;
    const capturedOpts = [];
    const logs = [];

    await withSessionResume({
      agentName: "claude",
      agent: {},
      state,
      sessionKey: "testSessionId",
      agentNameKey: "testAgentName",
      workspaceDir: tmp,
      log: (e) => logs.push(e),
      executeFn: (opts) => {
        capturedOpts.push(opts);
        callCount++;
        if (callCount === 1) throw authErr;
        return Promise.resolve({ stdout: "ok" });
      },
    });

    assert.equal(callCount, 2);
    assert.ok(capturedOpts[0].resumeId, "first call should resume");
    assert.ok(capturedOpts[1].sessionId, "retry should create fresh session");
    assert.notEqual(capturedOpts[1].sessionId, "existing-id");
    assert.ok(
      logs.some((l) => l.event === "session_auth_failed"),
      "should log session_auth_failed",
    );
  });

  it("retries auth error on fresh session (sessionId) with rotated session", async () => {
    await saveState(tmp, {});
    const state = await loadState(tmp);

    const authErr = new Error("Session ID x is already in use");
    authErr.name = "CommandFatalStderrError";
    authErr.category = "auth";

    let callCount = 0;
    const result = await withSessionResume({
      agentName: "claude",
      agent: {},
      state,
      sessionKey: "testSessionId",
      agentNameKey: "testAgentName",
      workspaceDir: tmp,
      log: () => {},
      executeFn: (opts) => {
        callCount++;
        if (callCount === 1) throw authErr;
        return Promise.resolve({ stdout: "ok" });
      },
    });

    assert.equal(callCount, 2);
    assert.equal(result.stdout, "ok");
    assert.notEqual(state.testSessionId, undefined);
  });

  it("propagates non-auth errors without retry", async () => {
    await saveState(tmp, {
      testSessionId: "existing-id",
      testAgentName: "claude",
    });
    const state = await loadState(tmp);

    const otherErr = new Error("timeout");
    let callCount = 0;

    await assert.rejects(
      () =>
        withSessionResume({
          agentName: "claude",
          agent: {},
          state,
          sessionKey: "testSessionId",
          agentNameKey: "testAgentName",
          workspaceDir: tmp,
          log: () => {},
          executeFn: () => {
            callCount++;
            throw otherErr;
          },
        }),
      (err) => err === otherErr,
    );

    assert.equal(callCount, 1, "should not retry non-auth errors");
  });
});
