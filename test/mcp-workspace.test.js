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
    withEnv("CODER_ALLOW_ANY_WORKSPACE", undefined, () => {
      assert.throws(() => resolveWorkspaceForMcp(outside, root), {
        message: /Workspace must be within server root/,
      });
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
    withEnv("CODER_ALLOW_ANY_WORKSPACE", undefined, () => {
      assert.throws(() => resolveWorkspaceForMcp(escapeLink, root), {
        message: /Workspace must be within server root/,
      });
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
    withEnv("CODER_ALLOW_ANY_WORKSPACE", undefined, () => {
      assert.throws(() => resolveWorkspaceForMcp(target, root), {
        message: /Workspace must be within server root/,
      });
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

test("resolveWorkspaceForMcp returns resolved realpath for symlink inside root", () => {
  const root = makeDir("coder-mcp-root-");
  const realSub = path.join(root, "real-sub");
  mkdirSync(realSub, { recursive: true });
  const link = path.join(root, "link-to-sub");
  symlinkSync(realSub, link, "dir");
  try {
    withEnv("CODER_ALLOW_ANY_WORKSPACE", undefined, () => {
      const resolved = resolveWorkspaceForMcp(link, root);
      assert.equal(resolved, realpathSync(realSub));
    });
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

// --- HTTP mode: workspace required & must be absolute ---

test("httpMode throws when workspace is missing", () => {
  const root = makeDir("coder-mcp-root-");
  try {
    assert.throws(
      () => resolveWorkspaceForMcp(undefined, root, { httpMode: true }),
      { code: "WORKSPACE_REQUIRED" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("httpMode throws when workspace is empty string", () => {
  const root = makeDir("coder-mcp-root-");
  try {
    assert.throws(() => resolveWorkspaceForMcp("", root, { httpMode: true }), {
      code: "WORKSPACE_REQUIRED",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("httpMode throws when workspace is relative path", () => {
  const root = makeDir("coder-mcp-root-");
  try {
    assert.throws(() => resolveWorkspaceForMcp(".", root, { httpMode: true }), {
      code: "WORKSPACE_NOT_ABSOLUTE",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("httpMode throws when workspace is relative subdir", () => {
  const root = makeDir("coder-mcp-root-");
  try {
    assert.throws(
      () => resolveWorkspaceForMcp("repo/subdir", root, { httpMode: true }),
      { code: "WORKSPACE_NOT_ABSOLUTE" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("httpMode accepts absolute workspace path", () => {
  const root = makeDir("coder-mcp-root-");
  const workspace = path.join(root, "project");
  mkdirSync(workspace, { recursive: true });
  try {
    const resolved = resolveWorkspaceForMcp(workspace, root, {
      httpMode: true,
    });
    assert.equal(resolved, path.resolve(workspace));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdio mode allows missing workspace (httpMode=false)", () => {
  const root = makeDir("coder-mcp-root-");
  try {
    const resolved = resolveWorkspaceForMcp(undefined, root, {
      httpMode: false,
    });
    assert.equal(resolved, path.resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("httpMode defaults to false when options omitted", () => {
  const root = makeDir("coder-mcp-root-");
  try {
    const resolved = resolveWorkspaceForMcp(undefined, root);
    assert.equal(resolved, path.resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
