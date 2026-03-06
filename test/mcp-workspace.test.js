import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceForMcp } from "../src/mcp/workspace.js";

function makeDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("resolveWorkspaceForMcp allows workspace inside root", () => {
  const root = makeDir("coder-mcp-root-");
  const workspace = path.join(root, "sub");
  mkdirSync(workspace, { recursive: true });
  try {
    const resolved = resolveWorkspaceForMcp(workspace, root);
    assert.equal(resolved, path.resolve(workspace));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceForMcp rejects workspace outside root", () => {
  const root = makeDir("coder-mcp-root-");
  const outside = makeDir("coder-mcp-outside-");
  try {
    assert.throws(() => resolveWorkspaceForMcp(outside, root), {
      message: /Workspace must be within server root/,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveWorkspaceForMcp rejects symlink escape target", () => {
  const root = makeDir("coder-mcp-root-");
  const outside = makeDir("coder-mcp-outside-");
  const escapeLink = path.join(root, "escape");
  symlinkSync(outside, escapeLink, "dir");
  try {
    assert.throws(() => resolveWorkspaceForMcp(escapeLink, root), {
      message: /Workspace must be within server root/,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveWorkspaceForMcp rejects non-existent child under symlink escape", () => {
  const root = makeDir("coder-mcp-root-");
  const outside = makeDir("coder-mcp-outside-");
  const escapeLink = path.join(root, "escape");
  symlinkSync(outside, escapeLink, "dir");
  const target = path.join(escapeLink, "new-child");
  try {
    assert.throws(() => resolveWorkspaceForMcp(target, root), {
      message: /Workspace must be within server root/,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveWorkspaceForMcp allows non-existent child path inside root", () => {
  const root = makeDir("coder-mcp-root-");
  const target = path.join(root, "a", "b", "c");
  try {
    const resolved = resolveWorkspaceForMcp(target, root);
    assert.equal(resolved, path.resolve(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceForMcp bypasses boundary check when env override is set", () => {
  const root = makeDir("coder-mcp-root-");
  const outside = makeDir("coder-mcp-outside-");
  try {
    withEnv("CODER_ALLOW_ANY_WORKSPACE", "1", () => {
      const resolved = resolveWorkspaceForMcp(outside, root);
      assert.equal(resolved, path.resolve(outside));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveWorkspaceForMcp returns real path for symlink within root", () => {
  const root = makeDir("coder-mcp-root-");
  const realDir = path.join(root, "real-target");
  mkdirSync(realDir, { recursive: true });
  const symlinkPath = path.join(root, "symlink-to-real-target");
  symlinkSync(realDir, symlinkPath, "dir");
  try {
    const resolved = resolveWorkspaceForMcp(symlinkPath, root);
    assert.equal(resolved, realpathSync(realDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
