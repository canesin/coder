import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TestConfigSchema } from "./schemas.js";

export function detectTestCommand(repoDir) {
  const has = (rel) => existsSync(path.join(repoDir, rel));

  if (has("pnpm-lock.yaml")) return ["pnpm", "test"];
  if (has("yarn.lock")) return ["yarn", "test"];
  if (has("package-lock.json")) return ["npm", "test"];
  if (has("package.json")) return ["npm", "test"];

  if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini")) return ["python3", "-m", "pytest"];

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
  return {
    exitCode: res.status ?? 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

/**
 * Load and validate a test config from .coder/test.json (or custom path).
 * @param {string} repoDir
 * @param {string} [configPath]
 * @returns {object|null} Parsed TestConfig or null if not found/invalid
 */
export function loadTestConfig(repoDir, configPath) {
  const p = configPath
    ? path.resolve(repoDir, configPath)
    : path.join(repoDir, ".coder", "test.json");

  if (!existsSync(p)) return null;

  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return TestConfigSchema.parse(raw);
  } catch (err) {
    const details =
      err && typeof err === "object" && "issues" in err
        ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : err?.message || String(err);
    throw new Error(`Invalid test config at ${p}: ${details}`);
  }
}

/**
 * Poll a URL until it returns a successful response.
 * @param {string} url
 * @param {number} retries
 * @param {number} intervalMs
 */
export async function waitForHealthCheck(url, retries, intervalMs) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
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
      const res = spawnSync("bash", ["-lc", cmd], {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: config.timeoutMs,
      });
      details.setup.push({ cmd, exitCode: res.status ?? 0 });
      if ((res.status ?? 0) !== 0) {
        return {
          cmd,
          exitCode: res.status ?? 1,
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
        details.healthCheck = { url: hc.url, status: "failed", error: err.message };
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
    const testRes = spawnSync("bash", ["-lc", config.test], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.timeoutMs,
    });

    return {
      cmd: config.test,
      exitCode: testRes.status ?? 0,
      stdout: testRes.stdout || "",
      stderr: testRes.stderr || "",
      details,
    };
  } finally {
    // Teardown always runs
    for (const cmd of config.teardown) {
      const res = spawnSync("bash", ["-lc", cmd], {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      });
      details.teardown.push({ cmd, exitCode: res.status ?? 0 });
    }
  }
}
