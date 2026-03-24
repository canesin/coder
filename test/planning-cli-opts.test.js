import assert from "node:assert/strict";
import test from "node:test";
import { buildStepCliOpts } from "../src/machines/develop/_shared.js";
import { buildPlanReviewExecuteOpts } from "../src/machines/develop/plan-review.machine.js";
import { buildPlannerExecuteOpts } from "../src/machines/develop/planning.machine.js";

test("buildStepCliOpts disables hang; uses given timeout", () => {
  assert.deepEqual(buildStepCliOpts(123_000), {
    timeoutMs: 123_000,
    hangTimeoutMs: 0,
  });
});

test("buildPlannerExecuteOpts uses workflow.timeouts.planning", () => {
  const ctx = { config: { workflow: { timeouts: { planning: 99_000 } } } };
  assert.deepEqual(buildPlannerExecuteOpts(ctx), {
    timeoutMs: 99_000,
    hangTimeoutMs: 0,
  });
});

test("buildPlanReviewExecuteOpts uses workflow.timeouts.planReview", () => {
  const ctx = { config: { workflow: { timeouts: { planReview: 88_000 } } } };
  assert.deepEqual(buildPlanReviewExecuteOpts(ctx), {
    timeoutMs: 88_000,
    hangTimeoutMs: 0,
  });
});
