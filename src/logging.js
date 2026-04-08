import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   closing: boolean,
 *   stream: import("node:fs").WriteStream | null,
 *   writeChain: Promise<void>,
 * }} LoggerState
 */

/** @type {Map<string, LoggerState>} */
const openStreams = new Map();

const REDACTED = "[REDACTED]";

function sanitizeSensitiveText(input) {
  let text = String(input);

  // JSON/key-value style token fields.
  text = text.replace(
    /((?:"|')?(?:accessToken|refreshToken|idToken|clientSecret|oauthToken|api[_-]?key|authorization|token)(?:"|')?\s*[:=]\s*")([^"]+)(")/gi,
    `$1${REDACTED}$3`,
  );
  text = text.replace(
    /((?:"|')?(?:accessToken|refreshToken|idToken|clientSecret|oauthToken|api[_-]?key|authorization|token)(?:"|')?\s*[:=]\s*')([^']+)(')/gi,
    `$1${REDACTED}$3`,
  );
  text = text.replace(
    /((?:"|')?(?:accessToken|refreshToken|idToken|clientSecret|oauthToken|api[_-]?key|authorization|token)(?:"|')?\s*[:=]\s*)([^\s,;]+)/gi,
    `$1${REDACTED}`,
  );

  // Common token formats.
  text = text.replace(/\bgh[opurs]_[A-Za-z0-9]{20,}\b/g, REDACTED);
  text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    REDACTED,
  );
  text = text.replace(
    /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    `$1 ${REDACTED}`,
  );
  text = text.replace(
    /([?&](?:access_token|refresh_token|id_token|token)=)[^&\s]+/gi,
    `$1${REDACTED}`,
  );

  return text;
}

export function sanitizeLogEvent(value) {
  if (typeof value === "string") return sanitizeSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogEvent(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeLogEvent(v);
    }
    return out;
  }
  return value;
}

export function logsDir(workspaceDir) {
  return path.join(workspaceDir, ".coder", "logs");
}

export function ensureLogsDir(workspaceDir) {
  mkdirSync(logsDir(workspaceDir), { recursive: true });
}

function createLogStream(p, name) {
  const stream = createWriteStream(p, { flags: "a" });
  stream.on("error", (err) => {
    process.stderr.write(`Logger error (${name}): ${err.message}\n`);
  });
  return stream;
}

function endStream(stream) {
  if (!stream || stream.destroyed || stream.writableFinished) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      stream.end(resolve);
    } catch {
      resolve();
    }
  });
}

function writeLine(stream, line) {
  return new Promise((resolve, reject) => {
    stream.write(line + "\n", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function makeJsonlLogger(workspaceDir, name, { runId = "" } = {}) {
  ensureLogsDir(workspaceDir);
  const p = path.join(logsDir(workspaceDir), `${name}.jsonl`);

  let state = openStreams.get(p);
  if (state) {
    state.writeChain = state.writeChain
      .catch(() => {})
      .then(async () => {
        const previous = state.stream;
        state.stream = null;
        try {
          await endStream(previous);
        } catch {}
        if (openStreams.get(p) !== state) return;
        state.stream = createLogStream(p, name);
      });
  } else {
    state = {
      closing: false,
      stream: createLogStream(p, name),
      writeChain: Promise.resolve(),
    };
    openStreams.set(p, state);
  }

  return (event) => {
    const safeEvent = sanitizeLogEvent(event);
    const entry = { ts: new Date().toISOString(), ...safeEvent };
    if (runId) entry.runId = runId;
    const line = JSON.stringify(entry);

    const activeState = openStreams.get(p);
    if (!activeState || activeState.closing) return;

    activeState.writeChain = activeState.writeChain
      .catch(() => {})
      .then(async () => {
        if (openStreams.get(p) !== activeState) return;
        if (!activeState.stream) {
          activeState.stream = createLogStream(p, name);
        }
        await writeLine(activeState.stream, line);
      });
  };
}

export function __getOpenStreamStateForTests(filePath) {
  return openStreams.get(filePath) || null;
}

export function closeAllLoggers() {
  const promises = [];
  for (const [key, state] of openStreams) {
    state.closing = true;
    promises.push(
      state.writeChain
        .catch(() => {})
        .then(async () => {
          const stream = state.stream;
          state.stream = null;
          await endStream(stream);
          openStreams.delete(key);
        }),
    );
  }
  return Promise.all(promises);
}
