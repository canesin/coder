import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

/** @type {Map<string, import("node:fs").WriteStream>} */
const openStreams = new Map();

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
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
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
