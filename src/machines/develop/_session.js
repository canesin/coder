import { randomUUID } from "node:crypto";
import { saveState } from "../../state/workflow-state.js";

/**
 * Check whether an agent supports session create/resume.
 * Claude always does; codex only when --session is available.
 *
 * @param {string} agentName
 * @param {{ codexSessionSupported?: () => boolean }} agent
 * @returns {boolean}
 */
export function supportsSession(agentName, agent) {
  return (
    agentName === "claude" ||
    (agentName === "codex" && agent.codexSessionSupported?.() === true)
  );
}

/**
 * Execute an agent call with session create/resume and auth-error retry.
 *
 * Handles:
 * - Agent-change invalidation (clear session when agent switches)
 * - Session ID creation (first call) vs resume (subsequent calls)
 * - Auth-error retry with fresh session
 *
 * @param {{
 *   agentName: string,
 *   agent: object,
 *   state: object,
 *   sessionKey: string,
 *   agentNameKey: string,
 *   workspaceDir: string,
 *   executeFn: (sessionOpts: object) => Promise<object>,
 *   log: (e: object) => void,
 * }} opts
 * @returns {Promise<object>} The agent execution result
 */
export async function withSessionResume({
  agentName,
  agent,
  state,
  sessionKey,
  agentNameKey,
  workspaceDir,
  executeFn,
  log,
}) {
  const isSupported = supportsSession(agentName, agent);

  // Agent-change invalidation
  if (state[agentNameKey] && state[agentNameKey] !== agentName) {
    delete state[sessionKey];
    state[agentNameKey] = agentName;
    await saveState(workspaceDir, state);
  }

  let sessionOpts = {};
  if (isSupported) {
    const hadSession = !!state[sessionKey];
    if (!state[sessionKey]) {
      state[sessionKey] = randomUUID();
      state[agentNameKey] = agentName;
      await saveState(workspaceDir, state);
    }
    sessionOpts = hadSession
      ? { resumeId: state[sessionKey] }
      : { sessionId: state[sessionKey] };
  }

  try {
    return await executeFn(sessionOpts);
  } catch (err) {
    const isAuthError =
      isSupported &&
      (err.name === "CommandFatalStderrError" ||
        err.name === "CommandFatalStdoutError") &&
      err.category === "auth";
    const canRetryWithFreshSession =
      isAuthError && (sessionOpts.resumeId || sessionOpts.sessionId);
    if (canRetryWithFreshSession) {
      log({
        event: "session_auth_failed",
        sessionId: state[sessionKey],
        wasCreating: !!sessionOpts.sessionId,
      });
      state[sessionKey] = randomUUID();
      await saveState(workspaceDir, state);
      return await executeFn({ sessionId: state[sessionKey] });
    }
    throw err;
  }
}
