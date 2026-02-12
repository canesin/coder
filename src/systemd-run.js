import { spawnSync } from "node:child_process";
import process from "node:process";

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

  args.push("bash", "-lc", command);
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
    const args = buildSystemdRunArgs(command, {
      unitName,
      cwd,
      timeoutMs,
      wait: true,
      pipe: true,
      privateNetwork,
    });
    const res = spawnSync("systemd-run", args, {
      cwd,
      env,
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

  const res = spawnSync("bash", ["-lc", command], {
    cwd,
    env,
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
