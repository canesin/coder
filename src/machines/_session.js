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
 * Whether a resolved (non-throwing) agent result with nonzero exitCode should trigger
 * a fresh session id + retry. We intentionally do NOT retry on arbitrary exitCode !== 0:
 * side-effectful runs (e.g. reviewer/programmer) may have edited the tree; replaying the
 * same prompt on a new session would duplicate work or mask the real error.
 *
 * Only session/token/usage-style failures are retried — the cases where a new session id
 * avoids "already in use" or a stuck cap without re-applying tool side effects meaningfully.
 *
 * @param {{ exitCode?: number, stdout?: string, stderr?: string }} result
 * @returns {boolean}
 */
export function shouldRetryAfterNonzeroSessionResult(result) {
  const combined = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (!combined.trim()) return false;
  const lower = combined.toLowerCase();
  if (lower.includes("session id") && lower.includes("is already in use")) {
    return true;
  }
  if (lower.includes("output token maximum")) return true;
  if (lower.includes("claude_code_max_output_tokens")) return true;
  if (lower.includes("max_output_tokens")) return true;
  if (
    lower.includes("exceeded") &&
    lower.includes("token") &&
    lower.includes("maximum")
  ) {
    return true;
  }
  if (
    lower.includes("conversation not found") ||
    lower.includes("session not found") ||
    lower.includes("no conversation found")
  ) {
    return true;
  }
  return false;
}

/**
 * Drop persisted session id after we rotated for nonzero-exit retries but still return failure,
 * so the next step does not resume a half-created session.
 * Uses the nonzero-exit recovery count only — not auth-recovery `recoveryCount`.
 */
async function clearSessionKeyAfterFailedNonzeroRetries(
  state,
  sessionKey,
  workspaceDir,
  log,
  nonzeroSessionRecoveryCount,
  result,
) {
  const exitCode = result?.exitCode;
  if (
    typeof exitCode !== "number" ||
    exitCode === 0 ||
    nonzeroSessionRecoveryCount <= 0
  ) {
    return;
  }
  delete state[sessionKey];
  await saveState(workspaceDir, state);
  log({
    event: "session_cleared_after_failed_nonzero_retry",
    sessionKey,
    exitCode,
    nonzeroSessionRecoveryCount,
  });
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
  /** Increments only when we retry after a resolved nonzero exit (token/session signature). */
  let nonzeroSessionRecoveryCount = 0;

  while (true) {
    try {
      const result = await executeFn(sessionOpts, {
        recoveryAttempt: recoveryCount + nonzeroSessionRecoveryCount,
      });
      // execute() resolves with exitCode even on failure (no throw). Narrow retries to
      // token/session signatures only — not every nonzero exit (see shouldRetryAfterNonzeroSessionResult).
      const hadSessionOpts = sessionOpts.resumeId || sessionOpts.sessionId;
      const exitCode = result?.exitCode;
      const canRetryNonzero =
        typeof exitCode === "number" &&
        exitCode !== 0 &&
        hadSessionOpts &&
        nonzeroSessionRecoveryCount < maxSessionAuthRecoveries &&
        shouldRetryAfterNonzeroSessionResult(result);
      if (canRetryNonzero) {
        log({
          event: "session_retry_after_nonzero_exit",
          sessionKey,
          sessionId: state[sessionKey],
          exitCode,
          recoveryAttempt: nonzeroSessionRecoveryCount + 1,
          maxRecoveries: maxSessionAuthRecoveries,
        });
        nonzeroSessionRecoveryCount++;
        state[sessionKey] = makeClaudeSessionId(workflowRunId);
        await saveState(workspaceDir, state);
        sessionOpts = { sessionId: state[sessionKey] };
        continue;
      }
      await clearSessionKeyAfterFailedNonzeroRetries(
        state,
        sessionKey,
        workspaceDir,
        log,
        nonzeroSessionRecoveryCount,
        result,
      );
      return result;
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
  let nonzeroSessionRecoveryCount = 0;

  while (true) {
    try {
      const result = await executeFn(sessionOpts);
      const hadSessionOpts = sessionOpts.resumeId || sessionOpts.sessionId;
      const exitCode = result?.exitCode;
      const canRetryNonzero =
        isSupported &&
        typeof exitCode === "number" &&
        exitCode !== 0 &&
        hadSessionOpts &&
        nonzeroSessionRecoveryCount < maxSessionAuthRecoveries &&
        shouldRetryAfterNonzeroSessionResult(result);
      if (canRetryNonzero) {
        log({
          event: "session_retry_after_nonzero_exit",
          sessionKey,
          sessionId: state[sessionKey],
          exitCode,
          recoveryAttempt: nonzeroSessionRecoveryCount + 1,
          maxRecoveries: maxSessionAuthRecoveries,
        });
        nonzeroSessionRecoveryCount++;
        state[sessionKey] = makeClaudeSessionId(workflowRunId);
        await saveState(workspaceDir, state);
        sessionOpts = { sessionId: state[sessionKey] };
        continue;
      }
      await clearSessionKeyAfterFailedNonzeroRetries(
        state,
        sessionKey,
        workspaceDir,
        log,
        nonzeroSessionRecoveryCount,
        result,
      );
      return result;
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
