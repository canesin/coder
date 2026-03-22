import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  buildSystemdRunArgs,
  canUseSystemdRun,
  killSystemdUnit,
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

export class CommandFatalStderrError extends Error {
  constructor(pattern, category) {
    super(`Command aborted after fatal stderr match [${category}]: ${pattern}`);
    this.name = "CommandFatalStderrError";
    this.pattern = pattern;
    this.category = category;
  }
}

export class CommandFatalStdoutError extends Error {
  constructor(pattern, category) {
    super(`Command aborted after fatal stdout match [${category}]: ${pattern}`);
    this.name = "CommandFatalStdoutError";
    this.pattern = pattern;
    this.category = category;
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

function stripNestedClaudeEnv(env) {
  const clean = { ...(env || {}) };
  delete clean.CLAUDECODE;
  delete clean.CLAUDE_CODE_ENTRYPOINT;
  return clean;
}

function filterEnv(env) {
  const out = {};
  for (const key of SAFE_ENV_KEYS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

/**
 * Compute the effective env that agent subprocesses receive.
 * Used for debugging (coder debug env).
 * @param {NodeJS.ProcessEnv} processEnv
 * @param {Record<string, string>} [baseEnv]
 * @param {Record<string, string>} [extraEnv]
 * @returns {Record<string, string>}
 */
export function computeSandboxEnv(processEnv, baseEnv = {}, extraEnv = {}) {
  return stripNestedClaudeEnv(
    mergeEnv(mergeEnv(filterEnv(processEnv), baseEnv), extraEnv),
  );
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
    const mergedEnv = stripNestedClaudeEnv(
      mergeEnv(mergeEnv(filterEnv(process.env), this.baseEnv), envs),
    );
    return new HostSandboxInstance({
      sandboxId,
      cwd: workingDirectory || this.defaultCwd,
      env: mergedEnv,
      useSystemdRun: this.useSystemdRun,
    });
  }

  async resume(sandboxId) {
    // "Resume" is best-effort for host execution: return a fresh instance using current env/cwd.
    const mergedEnv = stripNestedClaudeEnv(
      mergeEnv(filterEnv(process.env), this.baseEnv),
    );
    return new HostSandboxInstance({
      sandboxId,
      cwd: this.defaultCwd,
      env: mergedEnv,
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
          (p) =>
            typeof p?.pattern === "string" &&
            p.pattern.trim() !== "" &&
            typeof p?.category === "string",
        )
      : [];
    const killOnStdoutPatterns = Array.isArray(options.killOnStdoutPatterns)
      ? options.killOnStdoutPatterns.filter(
          (p) =>
            typeof p?.pattern === "string" &&
            p.pattern.trim() !== "" &&
            typeof p?.category === "string",
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

      const FATAL_ESCALATION_MS = 2000;
      const FORCE_SETTLE_AFTER_KILL_MS = 15_000;
      const log = typeof options.log === "function" ? options.log : null;

      let settled = false;
      let killTimer = null;
      let hangTimer = null;
      let escalationTimer = null;
      let forceSettleTimer = null;
      /** When set, defer settle until child exits (avoids retry starting while process still alive). */
      let pendingFatalError = null;
      /** Timestamp when fatal pattern first matched (for elapsed-ms in close log). */
      let fatalMatchTs = null;
      const terminateChild = (signal = "SIGTERM", reason = "unknown") => {
        if (log && child.pid) {
          log({
            event: "sandbox_terminate_signal",
            pid: child.pid,
            signal: this.currentUnit
              ? signal === "SIGKILL"
                ? "systemd_kill"
                : "systemd_stop"
              : signal,
            reason,
          });
        }
        if (this.currentUnit) {
          if (signal === "SIGKILL") {
            killSystemdUnit(this.currentUnit, "SIGKILL");
          } else {
            stopSystemdUnit(this.currentUnit);
          }
          return;
        }
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* ESRCH expected after process exit */
          }
        }
      };
      /** If SIGKILL/stopSystemdUnit does not yield `close`, avoid hanging forever. */
      const scheduleForceSettle = (err) => {
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        forceSettleTimer = setTimeout(() => {
          forceSettleTimer = null;
          if (settled) return;
          if (log) {
            log({
              event: "sandbox_force_settle",
              reason: "no_close_after_kill",
              pid: child.pid ?? null,
            });
          }
          settle(err);
        }, FORCE_SETTLE_AFTER_KILL_MS);
      };
      const settle = (err, result) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hangTimer) clearTimeout(hangTimer);
        if (escalationTimer) clearTimeout(escalationTimer);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        this.currentChild = null;
        this.currentCommand = null;
        this.currentUnit = null;
        if (err) reject(err);
        else resolve(result);
      };

      killTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (pendingFatalError) {
                terminateChild("SIGKILL", "timeout_escalate");
                scheduleForceSettle(pendingFatalError);
                return;
              }
              terminateChild("SIGTERM", "timeout");
              settle(new CommandTimeoutError(command, timeoutMs));
            }, timeoutMs)
          : null;

      // Hang detection: kill if no output for hangTimeoutMs
      const resetHangTimer = () => {
        if (hangTimeoutMs > 0) {
          if (hangTimer) clearTimeout(hangTimer);
          hangTimer = setTimeout(() => {
            if (pendingFatalError) {
              terminateChild("SIGKILL", "hang_escalate");
              scheduleForceSettle(pendingFatalError);
              return;
            }
            terminateChild("SIGTERM", "hang");
            settle(new CommandTimeoutError(command, hangTimeoutMs));
          }, hangTimeoutMs);
        }
      };
      resetHangTimer();

      const handleFatalMatch = (
        stream,
        patterns,
        accumulatedOutput,
        ErrorClass,
      ) => {
        if (patterns.length === 0) return;
        const lower = accumulatedOutput.toLowerCase();
        const hit = patterns.find((p) =>
          lower.includes(p.pattern.toLowerCase()),
        );
        if (!hit || pendingFatalError) return;
        fatalMatchTs = Date.now();
        if (log) {
          log({
            event: "sandbox_fatal_match",
            stream,
            pattern: hit.pattern,
            category: hit.category,
            pid: child.pid,
          });
        }
        terminateChild("SIGTERM", "fatal");
        const err = new ErrorClass(hit.pattern, hit.category);
        err.stdout = stdout;
        err.stderr = stderr;
        pendingFatalError = err;
        if (escalationTimer) clearTimeout(escalationTimer);
        escalationTimer = setTimeout(() => {
          if (pendingFatalError) {
            if (log) {
              log({
                event: "sandbox_fatal_escalate_sigkill",
                pattern: pendingFatalError.pattern,
                category: pendingFatalError.category,
                pid: child.pid,
              });
            }
            terminateChild("SIGKILL", "fatal_escalate");
            scheduleForceSettle(pendingFatalError);
          }
        }, FATAL_ESCALATION_MS);
      };

      child.stdout.on("data", (buf) => {
        const chunk = buf.toString();
        stdout = appendCapped(stdout, chunk);
        this.lastActivityTs = Date.now();
        resetHangTimer();
        options.onStdout?.(chunk);
        this.emit("stdout", chunk);
        // Check accumulated stdout so split messages (e.g. across stream chunks) are caught
        handleFatalMatch(
          "stdout",
          killOnStdoutPatterns,
          stdout,
          CommandFatalStdoutError,
        );
      });
      child.stderr.on("data", (buf) => {
        const chunk = buf.toString();
        stderr = appendCapped(stderr, chunk);
        this.lastActivityTs = Date.now();
        if (hangResetOnStderr) resetHangTimer();
        options.onStderr?.(chunk);
        this.emit("stderr", chunk);
        handleFatalMatch(
          "stderr",
          killOnStderrPatterns,
          stderr,
          CommandFatalStderrError,
        );
      });

      child.on("error", (err) => {
        settle(err);
      });

      const hadKillPatterns =
        killOnStderrPatterns.length > 0 || killOnStdoutPatterns.length > 0;
      child.on("close", (code, signal) => {
        if (log && child.pid && hadKillPatterns) {
          const elapsedMs = fatalMatchTs ? Date.now() - fatalMatchTs : null;
          log({
            event: "sandbox_process_close",
            pid: child.pid,
            exitCode: code ?? null,
            signal: signal ?? null,
            pattern: pendingFatalError?.pattern ?? null,
            category: pendingFatalError?.category ?? null,
            elapsedMs,
          });
        }
        if (pendingFatalError) {
          settle(pendingFatalError);
          return;
        }
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
    const child = this.currentChild;
    if (!child) {
      this.currentCommand = null;
      return;
    }
    this.currentChild = null;
    this.currentCommand = null;

    // Always SIGTERM the process group — descendants may outlive the leader
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    // Leader already exited: close/exit won't fire again.
    // Grace period for SIGTERM, then SIGKILL the group.
    if (child.exitCode !== null) {
      await new Promise((resolve) => {
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {}
          resolve();
        }, 500);
      });
      return;
    }

    // Wait for exit with SIGKILL escalation
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once("close", finish);
      child.once("exit", finish);
      child.once("error", finish);
      setTimeout(() => {
        if (done) return;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
        setTimeout(finish, 2000);
      }, 5000);
    });
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
