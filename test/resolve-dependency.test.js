import assert from "node:assert/strict";
import test from "node:test";
import { resolveDependencyBranch } from "../src/workflows/develop.workflow.js";

test("returns neutral result when issue has no dependencies", () => {
  const result = resolveDependencyBranch({}, new Map());
  assert.equal(result.baseBranch, null);
  assert.equal(result.anyDepsFailed, false);
  assert.equal(result.multipleBranches, false);
});

test("detects any failed dependency (EARS-1)", () => {
  const outcomeMap = new Map([
    ["A", { status: "completed", branch: "branch-a" }],
    ["B", { status: "failed" }],
  ]);
  const result = resolveDependencyBranch({ dependsOn: ["A", "B"] }, outcomeMap);
  assert.equal(result.anyDepsFailed, true);
});

test("detects multiple distinct branches (EARS-3)", () => {
  const outcomeMap = new Map([
    ["A", { status: "completed", branch: "branch-a" }],
    ["B", { status: "completed", branch: "branch-b" }],
  ]);
  const result = resolveDependencyBranch({ dependsOn: ["A", "B"] }, outcomeMap);
  assert.equal(result.multipleBranches, true);
  assert.equal(result.baseBranch, "branch-a");
});

test("single branch from multiple completed deps is not flagged as multiple", () => {
  const outcomeMap = new Map([
    ["A", { status: "completed", branch: "branch-a" }],
    ["B", { status: "completed", branch: "branch-a" }],
  ]);
  const result = resolveDependencyBranch({ dependsOn: ["A", "B"] }, outcomeMap);
  assert.equal(result.multipleBranches, false);
  assert.equal(result.baseBranch, "branch-a");
});

test("pending deps not counted toward failure", () => {
  const outcomeMap = new Map([["B", { status: "failed" }]]);
  const result = resolveDependencyBranch({ dependsOn: ["A", "B"] }, outcomeMap);
  assert.equal(result.anyDepsFailed, true);
  assert.equal(result.depOutcomes.A, "pending");
});

test("deferred dep appears in depOutcomes", () => {
  const outcomeMap = new Map([["A", { status: "deferred" }]]);
  const result = resolveDependencyBranch({ dependsOn: ["A"] }, outcomeMap);
  assert.equal(result.depOutcomes.A, "deferred");
});
