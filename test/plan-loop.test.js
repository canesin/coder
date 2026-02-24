import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePlanVerdict } from "../src/machines/develop/plan-review.machine.js";
import { WorkflowRunner } from "../src/workflows/_base.js";
import { runPlanLoop } from "../src/workflows/develop.workflow.js";

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plan-loop-test-"));
  mkdirSync(path.join(dir, ".coder", "artifacts"), { recursive: true });
  return dir;
}

function makeCtx(workspaceDir) {
  return {
    workspaceDir,
    artifactsDir: path.join(workspaceDir, ".coder", "artifacts"),
    cancelToken: { cancelled: false, paused: false },
    log: () => {},
    config: {},
    agentPool: null,
    secrets: {},
    scratchpadDir: path.join(workspaceDir, ".coder", "scratchpad"),
  };
}

function makeRunner(ctx) {
  return new WorkflowRunner({ name: "test", workflowContext: ctx });
}

// ---------------------------------------------------------------------------
// parsePlanVerdict
// ---------------------------------------------------------------------------

test("parsePlanVerdict: APPROVED from h2 numbered section", () => {
  assert.equal(parsePlanVerdict("## 5. Verdict\nAPPROVED"), "APPROVED");
});

test("parsePlanVerdict: REJECT from h2 section", () => {
  assert.equal(parsePlanVerdict("## Verdict\nREJECT"), "REJECT");
});

test("parsePlanVerdict: REVISE from h3 section", () => {
  assert.equal(parsePlanVerdict("### Verdict\nREVISE"), "REVISE");
});

test("parsePlanVerdict: PROCEED WITH CAUTION maps to PROCEED_WITH_CAUTION", () => {
  assert.equal(
    parsePlanVerdict("## Verdict\nPROCEED WITH CAUTION"),
    "PROCEED_WITH_CAUTION",
  );
});

test("parsePlanVerdict: bold markdown stripped before matching", () => {
  assert.equal(parsePlanVerdict("## Verdict\n**APPROVED**"), "APPROVED");
});

test("parsePlanVerdict: blank line between header and value", () => {
  assert.equal(parsePlanVerdict("## Verdict\n\nAPPROVED"), "APPROVED");
});

test("parsePlanVerdict: no verdict section returns UNKNOWN", () => {
  assert.equal(parsePlanVerdict("# Plan\n\nSome content here"), "UNKNOWN");
});

test("parsePlanVerdict: empty string returns UNKNOWN", () => {
  assert.equal(parsePlanVerdict(""), "UNKNOWN");
});

test("parsePlanVerdict: takes last verdict when multiple sections exist", () => {
  const md = "## Verdict\nREVISE\n\nsome text\n\n## Verdict\nAPPROVED";
  assert.equal(parsePlanVerdict(md), "APPROVED");
});

// ---------------------------------------------------------------------------
// runPlanLoop
// ---------------------------------------------------------------------------

test("runPlanLoop: APPROVED on round 1 runs each machine once", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx(tmp);
    const runner = makeRunner(ctx);
    let planCount = 0;
    let reviewCount = 0;
    let capturedCritique = null;

    const mockPlan = {
      name: "develop.planning",
      async run(input) {
        planCount++;
        capturedCritique = input.priorCritique;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        reviewCount++;
        return {
          status: "ok",
          data: { critiqueMd: "ok", verdict: "APPROVED" },
          durationMs: 0,
        };
      },
    };

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.equal(result.status, "completed");
    assert.equal(planCount, 1);
    assert.equal(reviewCount, 1);
    assert.equal(capturedCritique, "");
    assert.equal(result.results.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: REVISE then APPROVED runs machines twice and passes critique", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx(tmp);
    const runner = makeRunner(ctx);
    let planCount = 0;
    let reviewCount = 0;
    const capturedCritiques = [];

    const mockPlan = {
      name: "develop.planning",
      async run(input) {
        planCount++;
        capturedCritiques.push(input.priorCritique);
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        reviewCount++;
        const first = reviewCount === 1;
        return {
          status: "ok",
          data: {
            critiqueMd: first ? "bad plan" : "ok",
            verdict: first ? "REVISE" : "APPROVED",
          },
          durationMs: 0,
        };
      },
    };

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.equal(result.status, "completed");
    assert.equal(planCount, 2);
    assert.equal(reviewCount, 2);
    assert.equal(capturedCritiques[0], "");
    assert.equal(capturedCritiques[1], "bad plan");
    assert.equal(result.results.length, 4);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: REJECT also triggers revision", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx(tmp);
    const runner = makeRunner(ctx);
    let reviewCount = 0;

    const mockPlan = {
      name: "develop.planning",
      async run() {
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        reviewCount++;
        return {
          status: "ok",
          data: {
            critiqueMd: "reject",
            verdict: reviewCount === 1 ? "REJECT" : "APPROVED",
          },
          durationMs: 0,
        };
      },
    };

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.equal(result.status, "completed");
    assert.equal(reviewCount, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: stops at maxRounds even with repeated REVISE", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx(tmp);
    const runner = makeRunner(ctx);
    let planCount = 0;

    const mockPlan = {
      name: "develop.planning",
      async run() {
        planCount++;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "still bad", verdict: "REVISE" },
          durationMs: 0,
        };
      },
    };

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
      maxRounds: 3,
    });

    assert.equal(result.status, "completed");
    assert.equal(planCount, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: UNKNOWN verdict stops after 1 round", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx(tmp);
    const runner = makeRunner(ctx);
    let planCount = 0;

    const mockPlan = {
      name: "develop.planning",
      async run() {
        planCount++;
        return { status: "ok", data: { planMd: "written" }, durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "?", verdict: "UNKNOWN" },
          durationMs: 0,
        };
      },
    };

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.equal(result.status, "completed");
    assert.equal(planCount, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runPlanLoop: plan machine error aborts and returns failed", async () => {
  const tmp = makeTmp();
  try {
    const ctx = makeCtx(tmp);
    const runner = makeRunner(ctx);

    const mockPlan = {
      name: "develop.planning",
      async run() {
        return { status: "error", error: "plan failed", durationMs: 0 };
      },
    };
    const mockReview = {
      name: "develop.plan_review",
      async run() {
        return {
          status: "ok",
          data: { critiqueMd: "ok", verdict: "APPROVED" },
          durationMs: 0,
        };
      },
    };

    const result = await runPlanLoop(runner, ctx, {
      planningMachine: mockPlan,
      planReviewMachine: mockReview,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error, /plan failed/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
