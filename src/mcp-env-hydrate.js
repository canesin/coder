import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";

import { resolveConfig } from "./config.js";
import { resolvePassEnv } from "./helpers.js";

/** Avoid OOM if login shell prints an enormous env (or garbage). */
const MAX_ENV_CAPTURE_BYTES = 2 * 1024 * 1024;

/**
 * Run `env` in a login, non-interactive bash (`-lc`).
 *
 * Interactive shells can engage job-control startup and touch the controlling TTY.
 * When Claude launches MCP servers in the background, that can lead to SIGTTIN and
 * stop the entire Claude process group. Keep MCP hydration on the login-shell path,
 * but avoid interactive shell startup entirely.
 *
 * @param {NodeJS.ProcessEnv} [childEnv] - Child environment (default `process.env`).
 *   Tests may set `HOME` to a temp dir with `.profile` / `.bash_profile`.
 * @returns {string} Raw `env` stdout
 */
export function captureLoginShellEnv(childEnv = process.env) {
  return execSync("bash -lc 'env'", {
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: MAX_ENV_CAPTURE_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    env: childEnv,
  });
}

/**
 * Workspace directory for config resolution: same rules as `coder-mcp` CLI
 * (`--workspace`, `--workspace=`), else cwd. Used before full CLI parsing so
 * env hydration loads the same merged coder.json as the rest of the server.
 */
export function earlyWorkspaceDirForMcp() {
  try {
    const { values } = nodeParseArgs({
      args: process.argv.slice(2),
      strict: false,
      options: {
        workspace: { type: "string", default: process.cwd() },
      },
    });
    return path.resolve(values.workspace || process.cwd());
  } catch {
    return process.cwd();
  }
}

/**
 * MCP hosts often start Node without ~/.bashrc exports. Merge PATH-adjacent: pull
 * values for the same env var names {@link resolvePassEnv} would forward (from
 * merged coder.json + login-shell `env`), so custom models.*.apiKeyEnv,
 * sandbox.passEnv, passEnvPatterns, and defaults stay aligned with the agent pipeline.
 */
export function hydrateMcpEnvFromLoginShell(workspaceDir) {
  let raw;
  try {
    raw = captureLoginShellEnv();
  } catch {
    return;
  }

  if (!raw || raw.length > MAX_ENV_CAPTURE_BYTES) return;

  try {
    const loginEnv = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      loginEnv[key] = line.slice(eq + 1);
    }

    const mergedScan = { ...process.env, ...loginEnv };

    let config;
    try {
      config = resolveConfig(workspaceDir);
    } catch {
      return;
    }

    const names = resolvePassEnv(config, mergedScan);
    for (const key of names) {
      if (process.env[key]) continue;
      const v = mergedScan[key];
      if (v) process.env[key] = v;
    }
  } catch {
    // resolvePassEnv can throw on invalid passEnvPatterns regex; never take down coder-mcp.
  }
}
