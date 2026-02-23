import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  buildSystemdRunArgs,
  canUseSystemdRun,
  makeSystemdUnitName,
  stopSystemdUnit,
} from "./systemd-run.js";

// Keep only the tail of stdout/stderr to avoid OOM on long agent runs.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_TIME",
  "LC_NUMERIC",
  "LC_MONETARY",
  "LC_COLLATE",
  "XDG_RUNTIME_DIR",
];

export class CommandTimeoutError extends Error {
  constructor(command, timeoutMs) {
    super(`Command timeout after ${timeoutMs}ms: ${command.slice(0, 200)}`);
    this.name = "CommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export class McpStartupError extends Error {
  constructor(agentName, failedServers) {
    super(
      `MCP startup failure for ${agentName}: failed servers: ${failedServers}`,
    );
    this.name = "McpStartupError";
    this.agentName = agentName;
    this.failedServers = failedServers;
  }
}

function mergeEnv(base, extra) {
  return { ...base, ...(extra || {}) };
}

function filterEnv(env) {
  const out = {};
  for (const key of SAFE_ENV_KEYS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

export class HostSandboxProvider {
  /**
   * @param {{ defaultCwd?: string, baseEnv?: Record<string,string>, useSystemdRun?: boolean }} [config]
   */
  constructor(config = {}) {
    this.defaultCwd = config.defaultCwd || process.cwd();
    this.baseEnv = config.baseEnv || {};
    this.useSystemdRun = config.useSystemdRun ?? canUseSystemdRun();
  }

  async create(envs = {}, agentType = "default", workingDirectory) {
    const sandboxId = `host-${agentType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new HostSandboxInstance({
      sandboxId,
      cwd: workingDirectory || this.defaultCwd,
      env: mergeEnv(mergeEnv(filterEnv(process.env), this.baseEnv), envs),
      useSystemdRun: this.useSystemdRun,
    });
  }

  async resume(sandboxId) {
    // "Resume" is best-effort for host execution: return a fresh instance using current env/cwd.
    return new HostSandboxInstance({
      sandboxId,
      cwd: this.defaultCwd,
      env: mergeEnv(filterEnv(process.env), this.baseEnv),
      useSystemdRun: this.useSystemdRun,
    });
  }
}

class HostSandboxInstance extends EventEmitter {
  /**
   * @param {{ sandboxId: string, cwd: string, env: Record<string,string>, useSystemdRun?: boolean }} opts
   */
  constructor(opts) {
    super();
    this.sandboxId = opts.sandboxId;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.useSystemdRun = opts.useSystemdRun ?? false;

    // Activity tracking (Feature 7)
    this.lastActivityTs = null;
    this.currentCommand = null;
    this.currentChild = null;
    this.currentUnit = null;

    this.commands = {
      run: (command, options = {}) => this._run(command, options),
    };
  }

  /**
   * @returns {{ lastActivityTs: number|null, idleMs: number|null, currentCommand: string|null, isRunning: boolean }}
   */
  getActivity() {
    return {
      lastActivityTs: this.lastActivityTs,
      idleMs: this.lastActivityTs ? Date.now() - this.lastActivityTs : null,
      currentCommand: this.currentCommand,
      isRunning: this.currentChild !== null,
    };
  }

  async _run(command, options) {
    const timeoutMs = options.timeoutMs ?? 36e5;
    const background = options.background ?? false;
    const throwOnNonZero = options.throwOnNonZero ?? false;
    const hangTimeoutMs = options.hangTimeoutMs ?? 0;
    const hangResetOnStderr = options.hangResetOnStderr ?? true;
    const killOnStderrPatterns = Array.isArray(options.killOnStderrPatterns)
      ? options.killOnStderrPatterns.filter(
          (p) => typeof p === "string" && p.trim() !== "",
        )
      : [];

    this.currentCommand = command;

    if (background) {
      const launch = this._launch(command, { background, timeoutMs });
      const child = launch.child;
      if (!child.pid) {
        this.currentCommand = null;
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Failed to spawn background process",
        };
      }

      if (!launch.useSystemd) child.unref();
      this.currentUnit = launch.unitName || null;

      return await new Promise((resolve) => {
        let done = false;
        const settle = (result) => {
          if (done) return;
          done = true;
          this.currentCommand = null;
          this.currentUnit = null;
          resolve(result);
        };

        child.once("error", (err) => {
          settle({
            exitCode: 1,
            stdout: "",
            stderr: err.message || "Failed to spawn background process",
          });
        });

        // systemd-run exits quickly with start status in background mode.
        // raw bash background mode has already detached and can be treated as started.
        if (!launch.useSystemd) {
          settle({
            exitCode: 0,
            stdout: `Background process started: ${command}`,
            stderr: "",
          });
          return;
        }

        child.once("close", (code) => {
          const exitCode = code ?? 0;
          if (exitCode !== 0) {
            settle({
              exitCode,
              stdout: "",
              stderr: "Failed to start background process via systemd-run",
            });
            return;
          }
          settle({
            exitCode: 0,
            stdout: `Background process started: ${command}`,
            stderr: "",
          });
        });
      });
    }

    return await new Promise((resolve, reject) => {
      const launch = this._launch(command, { background, timeoutMs });
      const child = launch.child;

      this.currentChild = child;
      this.currentUnit = launch.unitName || null;
      this.lastActivityTs = Date.now();

      let stdout = "";
      let stderr = "";
      const appendCapped = (buf, chunk) => {
        buf += chunk;
        if (buf.length > MAX_OUTPUT_BYTES) buf = buf.slice(-MAX_OUTPUT_BYTES);
        return buf;
      };

      let settled = false;
      let killTimer = null;
      let hangTimer = null;
      const terminateChild = () => {
        if (this.currentUnit) {
          stopSystemdUnit(this.currentUnit);
          return;
        }
        // Kill the full process group to avoid orphaned grandchildren.
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      };
      const settle = (err, result) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hangTimer) clearTimeout(hangTimer);
        this.currentChild = null;
        this.currentCommand = null;
        this.currentUnit = null;
        if (err) reject(err);
        else resolve(result);
      };

      killTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              terminateChild();
              settle(new CommandTimeoutError(command, timeoutMs));
            }, timeoutMs)
          : null;

      // Hang detection: kill if no output for hangTimeoutMs
      const resetHangTimer = () => {
        if (hangTimeoutMs > 0) {
          if (hangTimer) clearTimeout(hangTimer);
          hangTimer = setTimeout(() => {
            terminateChild();
            settle(new CommandTimeoutError(command, hangTimeoutMs));
          }, hangTimeoutMs);
        }
      };
      resetHangTimer();

      child.stdout.on("data", (buf) => {
        const chunk = buf.toString();
        stdout = appendCapped(stdout, chunk);
        this.lastActivityTs = Date.now();
        resetHangTimer();
        options.onStdout?.(chunk);
        this.emit("stdout", chunk);
      });
      child.stderr.on("data", (buf) => {
        const chunk = buf.toString();
        stderr = appendCapped(stderr, chunk);
        this.lastActivityTs = Date.now();
        if (hangResetOnStderr) resetHangTimer();
        options.onStderr?.(chunk);
        this.emit("stderr", chunk);

        if (killOnStderrPatterns.length > 0) {
          const lower = chunk.toLowerCase();
          const hit = killOnStderrPatterns.find((p) =>
            lower.includes(String(p).toLowerCase()),
          );
          if (hit) {
            terminateChild();
            const err = new Error(
              `Command aborted after stderr auth failure: ${hit}`,
            );
            err.name = "CommandAuthError";
            err.stdout = stdout;
            err.stderr = stderr;
            settle(err);
          }
        }
      });

      child.on("error", (err) => {
        settle(err);
      });

      child.on("close", (code) => {
        const exitCode = code ?? 0;
        if (throwOnNonZero && exitCode !== 0) {
          const err = new Error(
            `Command exited with code ${exitCode}: ${command.slice(0, 200)}`,
          );
          err.exitCode = exitCode;
          err.stdout = stdout;
          err.stderr = stderr;
          settle(err);
          return;
        }
        settle(null, { exitCode, stdout, stderr });
      });
    });
  }

  async kill() {
    if (this.currentUnit) {
      stopSystemdUnit(this.currentUnit);
      this.currentUnit = null;
    }
    if (this.currentChild) {
      try {
        if (this.currentChild.pid)
          process.kill(-this.currentChild.pid, "SIGTERM");
      } catch {
        this.currentChild.kill("SIGTERM");
      }
      this.currentChild = null;
      this.currentCommand = null;
    }
  }
  _launch(command, { background, timeoutMs }) {
    if (this.useSystemdRun) {
      const unitName = makeSystemdUnitName("coder-agent");
      const args = buildSystemdRunArgs(command, {
        unitName,
        cwd: this.cwd,
        env: this.env,
        timeoutMs,
        wait: !background,
        pipe: !background,
      });
      const child = spawn("systemd-run", args, {
        cwd: this.cwd,
        env: this.env,
        stdio: background ? "ignore" : ["ignore", "pipe", "pipe"],
      });
      return { child, useSystemd: true, unitName };
    }

    const child = spawn("bash", ["-lc", command], {
      cwd: this.cwd,
      env: this.env,
      stdio: background ? "ignore" : ["ignore", "pipe", "pipe"],
      detached: true,
    });
    return { child, useSystemd: false, unitName: null };
  }
  async pause() {}
  async getHost(_port) {
    return "localhost";
  }
}
