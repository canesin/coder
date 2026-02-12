import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

/** @type {Map<string, import("node:fs").WriteStream>} */
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

export function makeJsonlLogger(workspaceDir, name) {
  ensureLogsDir(workspaceDir);
  const p = path.join(logsDir(workspaceDir), `${name}.jsonl`);

  const stream = createWriteStream(p, { flags: "a" });
  stream.on("error", (err) => {
    process.stderr.write(`Logger error (${name}): ${err.message}\n`);
  });
  openStreams.set(p, stream);

  return (event) => {
    const safeEvent = sanitizeLogEvent(event);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safeEvent });
    stream.write(line + "\n");
  };
}

export function closeAllLoggers() {
  const promises = [];
  for (const [key, stream] of openStreams) {
    promises.push(
      new Promise((resolve) => {
        stream.end(resolve);
      }),
    );
    openStreams.delete(key);
  }
  return Promise.all(promises);
}
