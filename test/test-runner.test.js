import assert from "node:assert/strict";
import test from "node:test";
import { waitForHealthCheck } from "../src/test-runner.js";

test("waitForHealthCheck rejects non-local URLs by default", async () => {
  await assert.rejects(
    async () => waitForHealthCheck("https://example.com/health", 1, 1),
    /must target localhost by default/i,
  );
});
