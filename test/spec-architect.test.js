import assert from "node:assert/strict";
import { mock, test } from "node:test";

let capturedPrompt = null;

mock.module("../src/machines/research/_shared.js", {
  namedExports: {
    runStructuredStep: async (opts) => {
      capturedPrompt = opts.prompt;
      return {
        payload: {
          domains: [],
          decisions: [],
          phases: [],
          issueSpecs: [],
        },
      };
    },
    loadPipeline: () => ({
      version: 1,
      current: "spec_architect",
      history: [],
      steps: {},
    }),
    appendScratchpad: () => {},
    requirePayloadFields: (payload) => payload,
  },
});

const { default: specArchitectMachine } = await import(
  "../src/machines/research/spec-architect.machine.js"
);

const baseInput = {
  runDir: "/tmp/test-run",
  stepsDir: "/tmp/test-run/steps",
  scratchpadPath: "/tmp/test-run/SCRATCHPAD.md",
  pipelinePath: "/tmp/test-run/pipeline.json",
  repoRoot: "/tmp/repo",
};

const stubCtx = {
  workspaceDir: "/tmp/test",
  log: () => {},
  cancelToken: { cancelled: false, paused: false },
};

test("spec_architect build mode prompt instructs on depends_on", async () => {
  capturedPrompt = null;
  await specArchitectMachine.run(
    {
      ...baseInput,
      mode: "build",
      researchManifest: { issues: [{ id: "R-01", title: "Fix auth" }] },
    },
    stubCtx,
  );
  assert.ok(capturedPrompt, "runStructuredStep should have been called");
  assert.match(capturedPrompt, /\d+\.\s+.*depends_on/i);
});

test("spec_architect ingest mode prompt instructs on depends_on", async () => {
  capturedPrompt = null;
  await specArchitectMachine.run(
    {
      ...baseInput,
      mode: "ingest",
      parsedDomains: [{ name: "auth" }],
      parsedDecisions: [{ id: "ADR-001", status: "accepted" }],
      parsedGaps: [{ description: "Needs work", domain: "AUTH" }],
    },
    stubCtx,
  );
  assert.ok(capturedPrompt, "runStructuredStep should have been called");
  assert.match(capturedPrompt, /\d+\.\s+.*depends_on/i);
});
