import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.js";
import { TestConfigSchema } from "./schemas.js";
import { runShellSync } from "./systemd-run.js";

export function detectTestCommand(repoDir) {
  const has = (rel) => existsSync(path.join(repoDir, rel));

  if (has("pnpm-lock.yaml")) return ["pnpm", "test"];
  if (has("yarn.lock")) return ["yarn", "test"];
  if (has("package-lock.json")) return ["npm", "test"];
  if (has("package.json")) return ["npm", "test"];

  if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini"))
    return ["python3", "-m", "pytest"];

  if (has("go.mod")) return ["go", "test", "./..."];
  if (has("Cargo.toml")) return ["cargo", "test"];
  if (has("Package.swift")) return ["swift", "test"];

  return null;
}

export function runTestCommand(repoDir, argv) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = res.stderr || "";
  return {
    exitCode: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout || "",
    stderr: res.error ? `${stderr}\n${res.error.message}`.trim() : stderr,
  };
}

function validateHealthCheckUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid health check URL: ${rawUrl}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported health check protocol: ${parsed.protocol}`);
  }

  if (process.env.CODER_ALLOW_EXTERNAL_HEALTHCHECK === "1") return;

  const host = parsed.hostname.toLowerCase();
  const localhostHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localhostHosts.has(host)) {
    throw new Error(
      `Health check URL must target localhost by default: ${rawUrl}. ` +
        "Set CODER_ALLOW_EXTERNAL_HEALTHCHECK=1 to allow external endpoints.",
    );
  }
}

/**
 * Load and validate a test config from coder.json test section, or an explicit config path.
 * @param {string} repoDir
 * @param {string} [configPath]
 * @returns {object|null} Parsed TestConfig or null if not found/invalid
 */
export function loadTestConfig(repoDir, configPath) {
  // If explicit configPath given, parse that file directly.
  if (configPath) {
    const p = path.resolve(repoDir, configPath);
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return TestConfigSchema.parse(raw);
    } catch (err) {
      const details =
        err && typeof err === "object" && "issues" in err
          ? err.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")
          : err?.message || String(err);
      throw new Error(`Invalid test config at ${p}: ${details}`);
    }
  }

  // Check unified config first
  const config = loadConfig(repoDir);
  if (config.test.command) {
    return {
      setup: config.test.setup,
      healthCheck: config.test.healthCheck,
      test: config.test.command,
      teardown: config.test.teardown,
      timeoutMs: config.test.timeoutMs,
    };
  }
  return null;
}

/**
 * Poll a URL until it returns a successful response.
 * @param {string} url
 * @param {number} retries
 * @param {number} intervalMs
 */
export async function waitForHealthCheck(url, retries, intervalMs) {
  validateHealthCheckUrl(url);
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: "error",
        });
        if (res.ok) return;
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Health check failed after ${retries} retries: ${url}`);
}

/**
 * Run a full test config: setup → healthCheck → test → teardown (always).
 * @param {string} repoDir
 * @param {object} config - Parsed TestConfigSchema
 * @returns {Promise<{ cmd: string, exitCode: number, stdout: string, stderr: string, details: object }>}
 */
export async function runTestConfig(repoDir, config) {
  const details = { setup: [], healthCheck: null, teardown: [] };

  try {
    // Setup phase
    for (const cmd of config.setup) {
      const res = runShellSync(cmd, {
        cwd: repoDir,
        timeoutMs: config.timeoutMs,
      });
      details.setup.push({ cmd, exitCode: res.exitCode });
      if (res.exitCode !== 0) {
        return {
          cmd,
          exitCode: res.exitCode,
          stdout: res.stdout || "",
          stderr: res.stderr || `Setup command failed: ${cmd}`,
          details,
        };
      }
    }

    // Health check phase
    if (config.healthCheck) {
      const hc = config.healthCheck;
      try {
        await waitForHealthCheck(hc.url, hc.retries, hc.intervalMs);
        details.healthCheck = { url: hc.url, status: "passed" };
      } catch (err) {
        details.healthCheck = {
          url: hc.url,
          status: "failed",
          error: err.message,
        };
        return {
          cmd: `healthCheck: ${hc.url}`,
          exitCode: 1,
          stdout: "",
          stderr: err.message,
          details,
        };
      }
    }

    // Test phase
    const testRes = runShellSync(config.test, {
      cwd: repoDir,
      timeoutMs: config.timeoutMs,
    });

    return {
      cmd: config.test,
      exitCode: testRes.exitCode,
      stdout: testRes.stdout || "",
      stderr: testRes.stderr || "",
      details,
    };
  } finally {
    // Teardown always runs
    for (const cmd of config.teardown) {
      const res = runShellSync(cmd, {
        cwd: repoDir,
        timeoutMs: 120000,
      });
      details.teardown.push({ cmd, exitCode: res.exitCode });
    }
  }
}
