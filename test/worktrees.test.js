import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { sanitizeBranchForRef, worktreePath } from "../src/worktrees.js";

test("sanitizeBranchForRef strips traversal and unsafe ref suffixes", () => {
  const branch = sanitizeBranchForRef(" feature/../evil:topic.lock ");
  assert.equal(branch.includes(".."), false);
  assert.equal(branch.includes(":"), false);
  assert.equal(branch.endsWith(".lock"), false);
  assert.equal(branch.length > 0, true);
});

test("worktreePath always resolves under the worktrees root", () => {
  const root = path.join(os.tmpdir(), "coder-worktrees-root");
  const p = worktreePath(root, "../../etc/passwd");
  const absRoot = path.resolve(root);
  assert.equal(p === absRoot || p.startsWith(absRoot + path.sep), true);
});
