import { spawnSync } from "node:child_process";
import { spawnAsync, throwIfAborted } from "../helpers.js";

/**
 * Run a synchronous git command with standard options.
 * @param {string[]} args - git subcommand and arguments
 * @param {{ cwd?: string }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function spawnGitSync(args, { cwd, ...rest } = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", ...rest });
}

/**
 * Run an async git command and throw on abort.
 * @param {string[]} args - git subcommand and arguments
 * @param {{ cwd?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ status: number, stdout: string, stderr: string, exitCode?: number }>}
 */
export async function spawnGitAsync(args, { cwd, signal, ...rest } = {}) {
  const res = await spawnAsync("git", args, {
    cwd,
    encoding: "utf8",
    signal,
    ...rest,
  });
  throwIfAborted(res);
  return res;
}

/**
 * Run a synchronous git command and throw if exit code is non-zero.
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function requireGitZero(args, opts) {
  const res = spawnGitSync(args, opts);
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(`git ${args[0]} failed${msg ? `: ${msg}` : ""}`);
  }
  return res;
}
