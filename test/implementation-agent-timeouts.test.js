import assert from "node:assert/strict";
import test from "node:test";
import { implementationAgentExecTimeouts } from "../src/machines/develop/implementation.machine.js";

test("implementation agent exec timeouts align hang with wall-clock budget", () => {
  const config = {
    workflow: {
      timeouts: { implementation: 3_600_000 },
    },
  };
  const opts = implementationAgentExecTimeouts(config);
  assert.equal(opts.timeoutMs, 3_600_000);
  assert.equal(opts.hangTimeoutMs, 3_600_000);
});
