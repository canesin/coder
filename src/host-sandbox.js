import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class CommandTimeoutError extends Error {
  constructor(command, timeoutMs) {
    super(`Command timeout after ${timeoutMs}ms: ${command.slice(0, 200)}`);
    this.name = "CommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

function mergeEnv(base, extra) {
  return { ...base, ...(extra || {}) };
}

export class HostSandboxProvider {
  /**
   * @param {{ defaultCwd?: string, baseEnv?: Record<string,string> }} [config]
   */
  constructor(config = {}) {
    this.defaultCwd = config.defaultCwd || process.cwd();
    this.baseEnv = config.baseEnv || {};
  }

  async create(envs = {}, agentType = "default", workingDirectory) {
    const sandboxId = `host-${agentType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new HostSandboxInstance({
      sandboxId,
      cwd: workingDirectory || this.defaultCwd,
      env: mergeEnv(mergeEnv(process.env, this.baseEnv), envs),
    });
  }

  async resume(sandboxId) {
    // "Resume" is best-effort for host execution: return a fresh instance using current env/cwd.
    return new HostSandboxInstance({
      sandboxId,
      cwd: this.defaultCwd,
      env: mergeEnv(process.env, this.baseEnv),
    });
  }
}

class HostSandboxInstance extends EventEmitter {
  /**
   * @param {{ sandboxId: string, cwd: string, env: Record<string,string> }} opts
   */
  constructor(opts) {
    super();
    this.sandboxId = opts.sandboxId;
    this.cwd = opts.cwd;
    this.env = opts.env;

    // Activity tracking (Feature 7)
    this.lastActivityTs = null;
    this.currentCommand = null;
    this.currentChild = null;

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

    this.currentCommand = command;

    if (background) {
      const child = spawn("bash", ["-lc", command], {
        cwd: this.cwd,
        env: this.env,
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      this.currentCommand = null;
      return {
        exitCode: 0,
        stdout: `Background process started: ${command}`,
        stderr: "",
      };
    }

    return await new Promise((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: this.cwd,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.currentChild = child;
      this.lastActivityTs = Date.now();

      let stdout = "";
      let stderr = "";

      let settled = false;
      let killTimer = null;
      let hangTimer = null;
      const settle = (err, result) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hangTimer) clearTimeout(hangTimer);
        this.currentChild = null;
        this.currentCommand = null;
        if (err) reject(err);
        else resolve(result);
      };

      killTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              child.kill("SIGTERM");
              settle(new CommandTimeoutError(command, timeoutMs));
            }, timeoutMs)
          : null;

      // Hang detection: kill if no output for hangTimeoutMs
      const resetHangTimer = () => {
        if (hangTimeoutMs > 0) {
          if (hangTimer) clearTimeout(hangTimer);
          hangTimer = setTimeout(() => {
            child.kill("SIGTERM");
            settle(new CommandTimeoutError(command, hangTimeoutMs));
          }, hangTimeoutMs);
        }
      };
      resetHangTimer();

      child.stdout.on("data", (buf) => {
        const chunk = buf.toString();
        stdout += chunk;
        this.lastActivityTs = Date.now();
        resetHangTimer();
        options.onStdout?.(chunk);
        this.emit("stdout", chunk);
      });
      child.stderr.on("data", (buf) => {
        const chunk = buf.toString();
        stderr += chunk;
        this.lastActivityTs = Date.now();
        resetHangTimer();
        options.onStderr?.(chunk);
        this.emit("stderr", chunk);
      });

      child.on("error", (err) => {
        settle(err);
      });

      child.on("close", (code) => {
        const exitCode = code ?? 0;
        if (throwOnNonZero && exitCode !== 0) {
          const err = new Error(`Command exited with code ${exitCode}: ${command.slice(0, 200)}`);
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
    if (this.currentChild) {
      this.currentChild.kill("SIGTERM");
      this.currentChild = null;
      this.currentCommand = null;
    }
  }
  async pause() {}
  async getHost(_port) {
    return "localhost";
  }
}
