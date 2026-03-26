import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  clearAllSessionIdsAndDisable,
  saveState,
} from "../state/workflow-state.js";

/** Default recoveries after an auth-category failure (fresh session id each time). */
const DEFAULT_MAX_SESSION_AUTH_RECOVERIES = 5;

/**
 * Build a Claude session id. Claude Code requires a strict RFC-4122 UUID for
 * `--session-id` / resume; prefixed or composite strings are rejected
 * ("Invalid session ID. Must be a valid UUID.").
 *
 * Run isolation uses the develop pipeline lock and fresh UUIDs on auth recovery,
 * not embedding the workflow run id in the session string.
 *
 * @param {string} [_workflowRunId] - Ignored; kept for call-site compatibility.
 */
export function makeClaudeSessionId(_workflowRunId) {
  return randomUUID();
}

function isSessionAuthCommandError(err) {
  return (
    err.name === "CommandFatalStderrError" ||
    err.name === "CommandFatalStdoutError"
  );
}

function isSessionCollisionError(err) {
  if (err.pattern === "is already in use") return true;
  const msg = String(err.message ?? "");
  return msg.includes("is already in use");
}

async function backoffAfterSessionCollision(recoveryCount) {
  const ms = Math.min(2000, 250 * recoveryCount);
  if (ms > 0) await delay(ms);
}

/**
 * Run an agent execute with explicit sessionId/resumeId; on auth-category fatal errors,
 * rotate state[sessionKey] to a new UUID and retry with a fresh sessionId.
 *
 * Use for machines that choose session create vs resume themselves (e.g. planning:
 * first call must be --session-id even though the id is already in state) instead of
 * {@link withSessionResume}, which infers create vs resume from whether the key existed.
 *
 * @param {(sessionOpts: object, meta: { recoveryAttempt: number }) => Promise<object>} executeFn -
 *   `recoveryAttempt` is 0 on the first try, 1+ after each auth failure (fresh session id).
 */
export async function executeWithSessionAuthRetry({
  state,
  sessionKey,
  workspaceDir,
  log,
  executeFn,
  initialSessionOpts,
  maxSessionAuthRecoveries = DEFAULT_MAX_SESSION_AUTH_RECOVERIES,
  workflowRunId = "",
}) {
  let sessionOpts = initialSessionOpts;
  let recoveryCount = 0;

  while (true) {
    try {
      return await executeFn(sessionOpts, { recoveryAttempt: recoveryCount });
    } catch (err) {
      const isAuthError =
        isSessionAuthCommandError(err) && err.category === "auth";
      const hadSessionOpts = sessionOpts.resumeId || sessionOpts.sessionId;
      const canRetry =
        isAuthError &&
        hadSessionOpts &&
        recoveryCount < maxSessionAuthRecoveries;
      if (!isAuthError) throw err;

      const msg = String(err.message ?? "");
      const messageCollision =
        hadSessionOpts &&
        msg.includes("is already in use") &&
        err.pattern !== "is already in use";

      if (messageCollision) {
        log({
          event: "session_auth_failed",
          sessionId: state[sessionKey],
          wasCreating: !!sessionOpts.sessionId,
          recoveryAttempt: recoveryCount + 1,
          maxRecoveries: maxSessionAuthRecoveries,
        });
        clearAllSessionIdsAndDisable(state);
        await saveState(workspaceDir, state);
        recoveryCount++;
        sessionOpts = {};
        continue;
      }

      if (!canRetry) throw err;

      log({
        event: "session_auth_failed",
        sessionId: state[sessionKey],
        wasCreating: !!sessionOpts.sessionId,
        recoveryAttempt: recoveryCount + 1,
        maxRecoveries: maxSessionAuthRecoveries,
      });
      recoveryCount++;
      state[sessionKey] = makeClaudeSessionId(workflowRunId);
      await saveState(workspaceDir, state);
      sessionOpts = { sessionId: state[sessionKey] };
      if (isSessionCollisionError(err)) {
        await backoffAfterSessionCollision(recoveryCount);
      }
    }
  }
}

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
 *   maxSessionAuthRecoveries?: number,
 *   workflowRunId?: string,
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
  maxSessionAuthRecoveries = DEFAULT_MAX_SESSION_AUTH_RECOVERIES,
  workflowRunId = "",
}) {
  const isSupported = supportsSession(agentName, agent);

  // Sessions disabled for this issue (e.g. after prior auth/collision)
  if (state.sessionsDisabled) {
    return await executeFn({});
  }

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
      state[sessionKey] = makeClaudeSessionId(workflowRunId);
      state[agentNameKey] = agentName;
      await saveState(workspaceDir, state);
    }
    sessionOpts = hadSession
      ? { resumeId: state[sessionKey] }
      : { sessionId: state[sessionKey] };
    log({
      event: "session_opts",
      sessionKey,
      hadSessionBefore: hadSession,
      usingCreate: !!sessionOpts.sessionId,
      usingResume: !!sessionOpts.resumeId,
    });
  }

  let recoveryCount = 0;

  while (true) {
    try {
      return await executeFn(sessionOpts);
    } catch (err) {
      const isAuthError =
        isSupported &&
        isSessionAuthCommandError(err) &&
        err.category === "auth";
      const hadSessionOpts = sessionOpts.resumeId || sessionOpts.sessionId;
      if (!isAuthError || !hadSessionOpts) throw err;

      if (sessionOpts.resumeId) {
        log({
          event: "session_auth_failed",
          sessionId: state[sessionKey],
          wasCreating: !!sessionOpts.sessionId,
        });
        clearAllSessionIdsAndDisable(state);
        await saveState(workspaceDir, state);
        log({ event: "session_retry_no_session", sessionKey });
        return await executeFn({});
      }

      // Message-level collision (not matched by pattern) — disable sessions entirely
      const msg = String(err.message ?? "");
      if (
        msg.includes("is already in use") &&
        err.pattern !== "is already in use"
      ) {
        log({
          event: "session_auth_failed",
          sessionId: state[sessionKey],
          wasCreating: !!sessionOpts.sessionId,
        });
        clearAllSessionIdsAndDisable(state);
        await saveState(workspaceDir, state);
        log({ event: "session_retry_no_session", sessionKey });
        return await executeFn({});
      }

      // Retry with fresh session ID (pattern collision gets backoff)
      if (recoveryCount >= maxSessionAuthRecoveries) throw err;
      const isCollision = isSessionCollisionError(err);
      log({
        event: "session_auth_failed",
        sessionId: state[sessionKey],
        wasCreating: !!sessionOpts.sessionId,
        recoveryAttempt: recoveryCount + 1,
        maxRecoveries: maxSessionAuthRecoveries,
      });
      recoveryCount++;
      state[sessionKey] = makeClaudeSessionId(workflowRunId);
      await saveState(workspaceDir, state);
      sessionOpts = { sessionId: state[sessionKey] };
      if (isCollision) {
        await backoffAfterSessionCollision(recoveryCount);
      }
    }
  }
}
