import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression: runDevelopLoop must acquire the develop pipeline lock before
 * ensureCleanLoopStart and before persisting loopState for the run. Otherwise
 * two concurrent starts can race on workspace cleanup and loop-state.json.
 * A full integration test would require heavy workflow mocks; this asserts
 * the ordering invariant on the source structure.
 */
test("runDevelopLoop: loop path keeps ensureCleanLoopStart and saveLoopState inside withDevelopPipelineLock", () => {
  const path = fileURLToPath(
    new URL("../src/workflows/develop.workflow.js", import.meta.url),
  );
  const src = readFileSync(path, "utf8");

  const loopLockOpen = src.indexOf(
    "return await withDevelopPipelineLock(ctx.workspaceDir, async () => {",
  );
  assert.notEqual(
    loopLockOpen,
    -1,
    "expected runDevelopLoop to wrap the loop body in withDevelopPipelineLock",
  );

  const ensureCall = src.indexOf("ensureCleanLoopStart(", loopLockOpen);
  assert.notEqual(
    ensureCall,
    -1,
    "expected ensureCleanLoopStart in the loop lock callback",
  );
  assert.ok(
    ensureCall > loopLockOpen,
    "ensureCleanLoopStart must run after withDevelopPipelineLock (same callback)",
  );

  const saveLoopStateAfterEnsure = src.indexOf(
    "await saveLoopState(ctx.workspaceDir, loopState,",
    ensureCall,
  );
  assert.notEqual(
    saveLoopStateAfterEnsure,
    -1,
    "expected saveLoopState(loopState) after ensureCleanLoopStart",
  );
  assert.ok(
    saveLoopStateAfterEnsure > ensureCall,
    "saveLoopState(loopState) must follow ensureCleanLoopStart inside the lock",
  );

  const secondLoopLockReturn = src.indexOf(
    "return await withDevelopPipelineLock(ctx.workspaceDir, async () => {",
    loopLockOpen + 1,
  );
  assert.equal(
    secondLoopLockReturn,
    -1,
    "only one `return await withDevelopPipelineLock(..., async () =>` pattern expected",
  );
});
