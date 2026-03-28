const DEFAULT_MAX = 500;

/**
 * Truncate a value for safe inclusion in log payloads.
 * @param {unknown} s
 * @param {number} [max]
 * @returns {string}
 */
export function truncateForLog(s, max = DEFAULT_MAX) {
  return String(s ?? "").slice(0, max);
}

/**
 * Build a standardized error log payload for agent execution failures.
 * @param {string} event - Log event name
 * @param {Error | null} err
 * @param {{ exitCode?: number, stdout?: string, stderr?: string } | null} res
 * @param {Record<string, unknown>} [extras]
 * @returns {Record<string, unknown>}
 */
export function buildErrorLogPayload(event, err, res, extras = {}) {
  const payload = {
    event,
    errorName: err?.name ?? "Error",
    errorMessage: truncateForLog(err?.message ?? err),
    isCommandTimeout: err?.name === "CommandTimeoutError",
    ...extras,
  };
  if (res && typeof res.exitCode === "number") {
    payload.exitCode = res.exitCode;
    payload.stdoutLen = (res.stdout || "").length;
    payload.stderrLen = (res.stderr || "").length;
  } else if (err) {
    if (typeof err.stdout === "string") payload.stdoutLen = err.stdout.length;
    if (typeof err.stderr === "string") payload.stderrLen = err.stderr.length;
  }
  return payload;
}
