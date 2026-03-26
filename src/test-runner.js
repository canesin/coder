import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  CoderConfigSchema,
  loadConfig,
  loadConfigForScopedRepo,
  migrateConfig,
  TestSectionSchema,
} from "./config.js";
import { TestConfigSchema } from "./schemas.js";
import { runShellSync } from "./systemd-run.js";
import {
  assertTestCommandPathsExist,
  resolveMonorepoTestCwd,
} from "./test-command-paths.js";

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

/** Map unified `test` section (coder.json) to the standalone TestConfig shape. */
function testSectionToTestConfig(t) {
  return {
    setup: t.setup,
    healthCheck: t.healthCheck ?? undefined,
    test: t.command,
    teardown: t.teardown,
    timeoutMs: t.timeoutMs,
    allowNoTests: t.allowNoTests ?? false,
  };
}

/** True when repoDir is the workspace root or a strict subdirectory (monorepo scope). */
export function isWorkspaceScopedRepo(repoDir, workspaceDir) {
  if (!workspaceDir) return false;
  const ra = path.resolve(repoDir);
  const wa = path.resolve(workspaceDir);
  if (ra === wa) return true;
  const rel = path.relative(wa, ra);
  return !rel.startsWith("..") && rel !== "";
}

/**
 * True only for the explicit relative path `"coder.json"` (merged workspace config).
 * Nested paths like `configs/coder.json` must load that file, not the merge.
 */
export function isUnifiedCoderJsonTestConfigPath(configPath) {
  return configPath === "coder.json";
}

/**
 * Parse a JSON file referenced by testConfigPath: either standalone TestConfigSchema
 * or unified coder.json where `test` is `{ command, setup, ... }`.
 */
function parseExplicitTestConfigFile(raw, filePath) {
  const standalone = TestConfigSchema.safeParse(raw);
  if (standalone.success) return standalone.data;

  if (
    raw &&
    typeof raw === "object" &&
    raw.test &&
    typeof raw.test === "object"
  ) {
    const section = TestSectionSchema.safeParse(raw.test);
    if (section.success && section.data.command) {
      return testSectionToTestConfig(section.data);
    }
  }

  const migrated = migrateConfig(raw);
  const full = CoderConfigSchema.safeParse(migrated);
  if (full.success && full.data.test?.command) {
    return testSectionToTestConfig(full.data.test);
  }

  const first = standalone.success
    ? "expected standalone or unified coder.json shape"
    : standalone.error?.issues
        ?.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ") || standalone.error?.message;
  throw new Error(
    `Invalid test config at ${filePath}: ${first || "unknown parse failure"}`,
  );
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
 * @param {string} [workspaceDir] - When set and repoDir is a subtree, load coder.json from workspace
 * @returns {object|null} Parsed TestConfig or null if not found/invalid
 */
export function loadTestConfig(repoDir, configPath, workspaceDir) {
  if (configPath) {
    const useMergedCoderJson =
      workspaceDir &&
      isUnifiedCoderJsonTestConfigPath(configPath) &&
      isWorkspaceScopedRepo(repoDir, workspaceDir);

    if (useMergedCoderJson) {
      const config = loadConfigForScopedRepo(workspaceDir, repoDir);
      if (config.test.command) {
        return testSectionToTestConfig(config.test);
      }
    }

    const p = path.resolve(repoDir, configPath);
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return parseExplicitTestConfigFile(raw, p);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Invalid test config at ${p}: ${err.message}`);
      }
      throw err;
    }
  }

  // Unified config: workspace + scoped package coder.json merge when repo_path is a subdir
  const config = workspaceDir
    ? loadConfigForScopedRepo(workspaceDir, repoDir)
    : loadConfig(repoDir);
  if (config.test.command) {
    return testSectionToTestConfig(config.test);
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
 * @param {boolean} [allowNoTests=false] - If true, pytest exit 5 (no tests) is treated as success
 * @param {object} [pathMeta] - Passed to path validation (testConfigPath, repoPath, workspaceDir for errors)
 * @returns {Promise<{ cmd: string, exitCode: number, stdout: string, stderr: string, details: object }>}
 */
export async function runTestConfig(
  repoDir,
  config,
  allowNoTests = false,
  pathMeta = {},
) {
  const commands = [...config.setup, config.test, ...config.teardown].filter(
    Boolean,
  );
  assertTestCommandPathsExist(repoDir, commands, pathMeta);

  const testCwd = resolveMonorepoTestCwd(
    repoDir,
    pathMeta.workspaceDir,
    commands,
  );

  const details = { setup: [], healthCheck: null, teardown: [] };

  try {
    // Setup phase
    for (const cmd of config.setup) {
      const res = runShellSync(cmd, {
        cwd: testCwd,
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
      cwd: testCwd,
      timeoutMs: config.timeoutMs,
    });
    const exitCode =
      allowNoTests && testRes.exitCode === 5 ? 0 : testRes.exitCode;

    return {
      cmd: config.test,
      exitCode,
      stdout: testRes.stdout || "",
      stderr: testRes.stderr || "",
      details,
    };
  } finally {
    // Teardown always runs
    for (const cmd of config.teardown) {
      const res = runShellSync(cmd, {
        cwd: testCwd,
        timeoutMs: 120000,
      });
      details.teardown.push({ cmd, exitCode: res.exitCode });
    }
  }
}
