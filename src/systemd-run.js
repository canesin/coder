import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

const LARGE_COMMAND_THRESHOLD = 80000; // 80KB — well under Linux MAX_ARG_STRLEN (128KB)

/**
 * Write a large command to a temp file and return a bash command that
 * executes it then cleans up. Avoids kernel E2BIG on execve().
 * Uses tmpDir to control where the file lands (important for PrivateTmp=yes).
 * Preserves the command's exit code across the cleanup rm.
 */
function maybeTmpFile(command, tmpDir = "/tmp") {
  // Compare UTF-8 byte length — Linux MAX_ARG_STRLEN is byte-based,
  // not UTF-16 code-unit-based, so CJK/emoji-heavy prompts need this.
  if (Buffer.byteLength(command, "utf8") <= LARGE_COMMAND_THRESHOLD)
    return command;
  const tmpPath = `${tmpDir}/coder-prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sh`;
  writeFileSync(tmpPath, command, { mode: 0o600 });
  return `. "${tmpPath}"; __coder_rc=$?; rm -f "${tmpPath}"; exit $__coder_rc`;
}

const SYSTEMD_PROBE_TIMEOUT_MS = 2000;
let cachedSystemdAvailability = null;

function safeStatus(result) {
  return typeof result.status === "number" ? result.status : 1;
}

function withSpawnErrorText(result) {
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (!result.error) return { stdout, stderr };
  const extra = result.error.message ? `\n${result.error.message}` : "";
  return { stdout, stderr: `${stderr}${extra}` };
}

export function canUseSystemdRun() {
  if (process.env.CODER_FORCE_SYSTEMD_RUN === "1") return true;
  if (process.env.CODER_DISABLE_SYSTEMD_RUN === "1") return false;
  if (process.platform !== "linux") return false;
  if (cachedSystemdAvailability !== null) return cachedSystemdAvailability;

  try {
    const probe = spawnSync(
      "systemd-run",
      ["--user", "--scope", "--quiet", "true"],
      {
        encoding: "utf8",
        timeout: SYSTEMD_PROBE_TIMEOUT_MS,
      },
    );
    cachedSystemdAvailability = probe.status === 0;
  } catch {
    cachedSystemdAvailability = false;
  }
  return cachedSystemdAvailability;
}

export function makeSystemdUnitName(prefix = "coder") {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}.service`;
}

export function buildSystemdRunArgs(
  command,
  {
    unitName,
    cwd,
    env,
    timeoutMs = 0,
    wait = true,
    pipe = true,
    privateNetwork = false,
  } = {},
) {
  const args = [
    "--user",
    "--quiet",
    "--collect",
    "--property=KillMode=control-group",
    "--property=NoNewPrivileges=yes",
    "--property=PrivateTmp=yes",
  ];

  // Transient service units do NOT inherit the caller's environment.
  // Forward env vars via --setenv so the unit has the same PATH, API keys, etc.
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (value != null) args.push(`--setenv=${key}=${value}`);
    }
  }

  if (privateNetwork) args.push("--property=PrivateNetwork=yes");
  if (wait) args.push("--wait");
  if (pipe) args.push("--pipe");
  if (unitName) args.push("--unit", unitName);
  if (cwd) args.push(`--working-directory=${cwd}`);

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    args.push(
      `--property=RuntimeMaxSec=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    );
  }

  // PrivateTmp=yes hides /tmp from the unit. Use XDG_RUNTIME_DIR (/run/user/<uid>)
  // which is visible to both the caller and --user units, and avoids polluting the
  // repo working tree (unlike cwd).
  const tmpDir = process.env.XDG_RUNTIME_DIR || cwd || "/tmp";
  args.push("bash", "-lc", maybeTmpFile(command, tmpDir));
  return args;
}

export function stopSystemdUnit(unitName) {
  if (!unitName) return;
  try {
    spawnSync("systemctl", ["--user", "stop", unitName], {
      encoding: "utf8",
      timeout: 3000,
    });
  } catch {
    // best-effort
  }
}

export function runShellSync(
  command,
  {
    cwd,
    env,
    timeoutMs = 0,
    preferSystemd = true,
    privateNetwork = false,
    unitPrefix = "coder-sync",
  } = {},
) {
  if (preferSystemd && canUseSystemdRun()) {
    const unitName = makeSystemdUnitName(unitPrefix);
    const resolvedEnv = { ...(env || process.env) };
    delete resolvedEnv.CLAUDECODE;
    const args = buildSystemdRunArgs(command, {
      unitName,
      cwd,
      env: resolvedEnv,
      timeoutMs,
      wait: true,
      pipe: true,
      privateNetwork,
    });
    const res = spawnSync("systemd-run", args, {
      cwd,
      env: resolvedEnv,
      encoding: "utf8",
    });
    const io = withSpawnErrorText(res);
    return {
      cmd: ["systemd-run", ...args],
      exitCode: safeStatus(res),
      stdout: io.stdout,
      stderr: io.stderr,
      usedSystemd: true,
      unitName,
    };
  }

  const fallbackEnv = { ...(env || process.env) };
  delete fallbackEnv.CLAUDECODE;
  const res = spawnSync("bash", ["-lc", maybeTmpFile(command)], {
    cwd,
    env: fallbackEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  });
  const io = withSpawnErrorText(res);
  return {
    cmd: ["bash", "-lc", command],
    exitCode: safeStatus(res),
    stdout: io.stdout,
    stderr: io.stderr,
    usedSystemd: false,
    unitName: null,
  };
}
