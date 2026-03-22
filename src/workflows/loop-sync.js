import { loadLoopState, saveLoopState } from "../state/workflow-state.js";

/**
 * Update loop-state stage/agent when processing an issue in the develop loop.
 * No-op if on-disk runId does not match guardRunId (avoids cross-run corruption).
 *
 * @param {string} workspaceDir
 * @param {{
 *   guardRunId: string,
 *   currentStage?: string,
 *   activeAgent?: string | null,
 * }} patch - Omit activeAgent key to leave activeAgent unchanged; pass null to clear.
 * @param {(() => void | Promise<void>) | undefined} [afterPersist] - Best-effort hook after a successful save (e.g. lifecycle SYNC).
 */
export async function syncDevelopLoopStage(workspaceDir, patch, afterPersist) {
  const { guardRunId, currentStage, activeAgent } = patch;
  try {
    const ls = await loadLoopState(workspaceDir);
    if (ls.runId !== guardRunId) return;
    if (currentStage !== undefined) ls.currentStage = currentStage;
    if (activeAgent !== undefined) ls.activeAgent = activeAgent;
    ls.lastHeartbeatAt = new Date().toISOString();
    await saveLoopState(workspaceDir, ls, { guardRunId });
    if (typeof afterPersist === "function") {
      try {
        await afterPersist();
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}
