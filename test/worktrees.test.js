import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIssueBranchName,
  buildSemanticBranchName,
  sanitizeBranchForRef,
  worktreePath,
} from "../src/worktrees.js";

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

test("buildIssueBranchName uses semantic format with source tag and issue id", () => {
  const branch = buildIssueBranchName({
    source: "github",
    id: "123",
    title: "Add health endpoint contract tests now",
  });
  assert.equal(branch, "feat/add-health-endpoint-contract_GH_123");
});

test("buildIssueBranchName infers bug branch type for fix-like titles", () => {
  const branch = buildIssueBranchName({
    source: "linear",
    id: "ENG-77",
    title: "Fix crash in startup flow",
  });
  assert.equal(branch, "bug/fix-crash-in-startup_LN_ENG-77");
});

test("buildSemanticBranchName uses explicit type and keeps issue tags", () => {
  const branch = buildSemanticBranchName({
    type: "bux",
    semanticName: "Optimize startup telemetry and health checks",
    issue: { source: "github", id: "42", title: "Ignored fallback title" },
  });
  assert.equal(branch, "bux/optimize-startup-telemetry-and_GH_42");
});

test("buildIssueBranchName uses GL shortcode for gitlab source", () => {
  const branch = buildIssueBranchName({
    source: "gitlab",
    id: "42",
    title: "Add gitlab support",
  });
  assert.equal(branch, "feat/add-gitlab-support_GL_42");
});
