import assert from "node:assert/strict";
import test from "node:test";
import { resolveDependencyBranch } from "../src/workflows/develop.workflow.js";

function makeOutcomeMap(entries) {
  return new Map(Object.entries(entries));
}

test("resolveDependencyBranch: no deps returns nulls and false", () => {
  const r = resolveDependencyBranch({ dependsOn: [] }, new Map());
  assert.equal(r.baseBranch, null);
  assert.equal(r.allDepsFailed, false);
  assert.deepEqual(r.depOutcomes, {});
});

test("resolveDependencyBranch: all deps pending → allDepsFailed false", () => {
  const r = resolveDependencyBranch({ dependsOn: ["A", "B"] }, new Map());
  assert.equal(r.allDepsFailed, false);
  assert.equal(r.baseBranch, null);
  assert.equal(r.depOutcomes.A, "pending");
  assert.equal(r.depOutcomes.B, "pending");
});

test("resolveDependencyBranch: one dep completed with branch → baseBranch set", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B"] },
    makeOutcomeMap({ A: { status: "completed", branch: "feat/a" } }),
  );
  assert.equal(r.allDepsFailed, false);
  assert.equal(r.baseBranch, "feat/a");
  assert.equal(r.depOutcomes.A, "completed");
  assert.equal(r.depOutcomes.B, "pending");
});

test("resolveDependencyBranch: one dep failed, one pending → allDepsFailed true (all resolved deps failed)", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B"] },
    makeOutcomeMap({ A: { status: "failed", branch: null } }),
  );
  assert.equal(r.allDepsFailed, true);
  assert.equal(r.baseBranch, null);
  assert.equal(r.depOutcomes.A, "failed");
  assert.equal(r.depOutcomes.B, "pending");
});

test("resolveDependencyBranch: both deps completed → baseBranch is first", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B"] },
    makeOutcomeMap({
      A: { status: "completed", branch: "feat/a" },
      B: { status: "completed", branch: "feat/b" },
    }),
  );
  assert.equal(r.allDepsFailed, false);
  assert.equal(r.baseBranch, "feat/a");
});

test("resolveDependencyBranch: all deps failed → allDepsFailed true", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B"] },
    makeOutcomeMap({
      A: { status: "failed", branch: null },
      B: { status: "failed", branch: null },
    }),
  );
  assert.equal(r.allDepsFailed, true);
  assert.equal(r.baseBranch, null);
});

test("resolveDependencyBranch: all deps skipped → allDepsFailed true", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B"] },
    makeOutcomeMap({
      A: { status: "skipped", branch: null },
      B: { status: "skipped", branch: null },
    }),
  );
  assert.equal(r.allDepsFailed, true);
});

test("resolveDependencyBranch: mixed failed and skipped → allDepsFailed true", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B"] },
    makeOutcomeMap({
      A: { status: "failed", branch: null },
      B: { status: "skipped", branch: null },
    }),
  );
  assert.equal(r.allDepsFailed, true);
});

test("resolveDependencyBranch: completed + failed + skipped → allDepsFailed false", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A", "B", "C"] },
    makeOutcomeMap({
      A: { status: "completed", branch: "feat/a" },
      B: { status: "failed", branch: null },
      C: { status: "skipped", branch: null },
    }),
  );
  assert.equal(r.allDepsFailed, false);
  assert.equal(r.baseBranch, "feat/a");
});

test("resolveDependencyBranch: completed with no branch → baseBranch null", () => {
  const r = resolveDependencyBranch(
    { dependsOn: ["A"] },
    makeOutcomeMap({ A: { status: "completed", branch: null } }),
  );
  assert.equal(r.allDepsFailed, false);
  assert.equal(r.baseBranch, null);
});
