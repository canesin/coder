import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { waitForHealthCheck } from "./test-runner.js";

/**
 * Run a single preflight check. Throws on failure.
 * @param {object} check - { type: "tcp"|"command"|"url", ... }
 * @param {string} [cwd] - Working directory for command checks
 */
export async function runPreflightCheck(check, cwd = process.cwd()) {
  if (check.type === "tcp") {
    const { host, port } = check;
    return new Promise((resolve, reject) => {
      const socket = createConnection(
        { host: host || "127.0.0.1", port },
        () => {
          socket.destroy();
          resolve();
        },
      );
      socket.on("error", (err) => {
        reject(
          new Error(
            `TCP ${host || "127.0.0.1"}:${port} refused. ${err.message}. Ensure required services are running before starting the pipeline.`,
          ),
        );
      });
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error(`TCP ${host}:${port} timed out.`));
      });
    });
  }

  if (check.type === "command") {
    const { cmd } = check;
    const res = spawnSync(cmd, {
      shell: true,
      cwd,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (res.status !== 0) {
      throw new Error(
        `Pre-flight command failed: ${cmd}\n${(res.stderr || res.stdout || "").trim().slice(0, 500)}`,
      );
    }
    return;
  }

  if (check.type === "url") {
    const { url, retries = 5, intervalMs = 2000 } = check;
    await waitForHealthCheck(url, retries, intervalMs);
    return;
  }

  throw new Error(`Unknown preflight check type: ${check.type}`);
}

/**
 * Run all preflight checks. Throws on first failure.
 * @param {object[]} checks - Array of check objects
 * @param {string} [cwd] - Working directory
 */
export async function runPreflight(checks, cwd = process.cwd()) {
  if (!checks || !Array.isArray(checks) || checks.length === 0) return;

  for (const check of checks) {
    await runPreflightCheck(check, cwd);
  }
}
