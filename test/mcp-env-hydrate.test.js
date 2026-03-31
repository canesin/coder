import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureLoginShellEnv,
  earlyWorkspaceDirForMcp,
  hydrateMcpEnvFromLoginShell,
} from "../src/mcp-env-hydrate.js";

test("earlyWorkspaceDirForMcp uses --workspace when present", () => {
  const prev = process.argv;
  try {
    process.argv = ["node", "coder-mcp", "--workspace", "/tmp/foo/bar"];
    assert.equal(earlyWorkspaceDirForMcp(), path.resolve("/tmp/foo/bar"));
  } finally {
    process.argv = prev;
  }
});

test("earlyWorkspaceDirForMcp accepts --workspace=/path (equals form)", () => {
  const prev = process.argv;
  try {
    process.argv = ["node", "coder-mcp", "--workspace=/tmp/x"];
    assert.equal(earlyWorkspaceDirForMcp(), path.resolve("/tmp/x"));
  } finally {
    process.argv = prev;
  }
});

test("earlyWorkspaceDirForMcp falls back to cwd without --workspace", () => {
  const prev = process.argv;
  try {
    process.argv = ["node", "coder-mcp"];
    assert.equal(earlyWorkspaceDirForMcp(), process.cwd());
  } finally {
    process.argv = prev;
  }
});

test("hydrateMcpEnvFromLoginShell does not throw when passEnvPatterns regex is invalid", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "coder-hydrate-"));
  writeFileSync(
    path.join(dir, "coder.json"),
    JSON.stringify({
      sandbox: { passEnv: ["FOO"], passEnvPatterns: ["("] },
    }),
  );
  assert.doesNotThrow(() => hydrateMcpEnvFromLoginShell(dir));
});

test("captureLoginShellEnv sees exports from login shell startup files", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "coder-bashrc-"));
  writeFileSync(
    path.join(home, ".profile"),
    "export CODER_TEST_FROM_PROFILE=hydrate-test\n",
  );
  const raw = captureLoginShellEnv({ ...process.env, HOME: home });
  assert.match(raw, /(^|\n)CODER_TEST_FROM_PROFILE=hydrate-test(\n|$$)/);
});

test("captureLoginShellEnv widens PATH from login shell profile (MCP / coder-mcp bootstrap)", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "coder-path-widen-"));
  const markerDir = path.join(home, "fake-path-marker");
  writeFileSync(
    path.join(home, ".profile"),
    `export PATH="${markerDir}:$PATH"\n`,
  );
  const raw = captureLoginShellEnv({ ...process.env, HOME: home });
  const pathLine = raw.split("\n").find((line) => line.startsWith("PATH="));
  assert.ok(pathLine, "expected PATH= in login-shell env");
  assert.ok(
    pathLine.includes(markerDir),
    "PATH must include dirs prepended by ~/.profile (login shell used for MCP hydration)",
  );
});
