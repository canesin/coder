import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

test("restoreFromSqlite restores when target file does not exist", async () => {
  const workspace = makeTmp("coder-persist-restore-");
  const scratchpadDir = path.join(workspace, ".coder", "scratchpad");
  const sqlitePath = path.join(workspace, ".coder", "scratchpad.db");
  const targetPath = path.join(scratchpadDir, "github-123.md");

  const sp = new ScratchpadPersistence({
    workspaceDir: workspace,
    scratchpadDir,
    sqlitePath,
    sqliteSync: true,
  });

  try {
    const enabled = await sp._sqliteReady;
    if (!enabled) {
      return; // skip if sqlite unavailable
    }
    mkdirSync(scratchpadDir, { recursive: true });
    writeFileSync(targetPath, "restore-me", "utf8");
    await sp.appendSection(targetPath, "Input", ["test"]);
    unlinkSync(targetPath);
    const restored = await sp.restoreFromSqlite(targetPath);
    assert.equal(restored, true, "restore should succeed");
    assert.ok(
      readFileSync(targetPath, "utf8").includes("restore-me"),
      "file content should be restored",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("_relPathForRestore rejects path that escapes via symlink", () => {
  const workspace = makeTmp("coder-persist-ws-");
  const outside = makeTmp("coder-persist-out-");
  const escapeLink = path.join(workspace, "escape");
  symlinkSync(outside, escapeLink);
  const targetPath = path.join(escapeLink, "file.md");

  const sp = new ScratchpadPersistence({
    workspaceDir: workspace,
    scratchpadDir: path.join(workspace, ".coder", "scratchpad"),
    sqlitePath: path.join(workspace, ".coder", "scratchpad.db"),
    sqliteSync: false,
  });

  try {
    assert.equal(
      sp._relPathForRestore(targetPath),
      null,
      "path escaping via symlink should return null",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
