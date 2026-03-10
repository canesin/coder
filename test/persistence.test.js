import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ScratchpadPersistence } from "../src/state/persistence.js";

function makeTmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("_relPath rejects symlink that escapes workspace", () => {
  const workspace = makeTmp("coder-persist-ws-");
  const outside = makeTmp("coder-persist-out-");
  const outsideFile = path.join(outside, "secret.txt");
  writeFileSync(outsideFile, "secret", "utf8");

  const link = path.join(workspace, "evil-link.txt");
  symlinkSync(outsideFile, link);

  const sp = new ScratchpadPersistence({
    workspaceDir: workspace,
    scratchpadDir: path.join(workspace, ".coder", "scratchpad"),
    sqlitePath: path.join(workspace, ".coder", "scratchpad.db"),
    sqliteSync: false,
  });

  try {
    assert.equal(sp._relPath(link), null, "symlink escape should return null");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("_relPath accepts file inside workspace", () => {
  const workspace = makeTmp("coder-persist-ws-");
  const innerFile = path.join(workspace, "notes.md");
  writeFileSync(innerFile, "ok", "utf8");

  const sp = new ScratchpadPersistence({
    workspaceDir: workspace,
    scratchpadDir: path.join(workspace, ".coder", "scratchpad"),
    sqlitePath: path.join(workspace, ".coder", "scratchpad.db"),
    sqliteSync: false,
  });

  try {
    assert.equal(sp._relPath(innerFile), "notes.md");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("_relPath returns null for non-existent file", () => {
  const workspace = makeTmp("coder-persist-ws-");

  const sp = new ScratchpadPersistence({
    workspaceDir: workspace,
    scratchpadDir: path.join(workspace, ".coder", "scratchpad"),
    sqlitePath: path.join(workspace, ".coder", "scratchpad.db"),
    sqliteSync: false,
  });

  try {
    assert.equal(sp._relPath(path.join(workspace, "does-not-exist.md")), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
