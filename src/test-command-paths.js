import { existsSync } from "node:fs";
import path from "node:path";

const SCRIPT_EXT = /\.(sh|bash|js|cjs|mjs)$/i;

/**
 * Thrown when a test setup/test/teardown command references a repo-relative path
 * that does not exist under the declared repo root (test cwd).
 */
export class TestCommandPathError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "TestCommandPathError";
    this.code = "TEST_COMMAND_PATH";
    this.details = details;
  }
}

/** Strip one pair of surrounding ' or " from a shell token. */
export function stripOuterShellQuotes(s) {
  const t = String(s).trim();
  if (t.length < 2) return t;
  const a = t[0];
  const b = t[t.length - 1];
  if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Drop shell redirections at the end of a segment so `cd .. >/dev/null && …`
 * is parsed as `cd ..` for cwd simulation.
 */
export function stripTrailingRedirects(segment) {
  const t = segment.trim();
  const cut = t.search(/\s+[0-9]*>>?|\s+2>&1/);
  if (cut >= 0) return t.slice(0, cut).trim();
  return t;
}

/**
 * Index of closing `"` for an opening `"` at `openIdx`, respecting backslash escapes (`\\`, `\"`).
 * @returns {number} closing index, or -1
 */
export function findClosingDoubleQuote(str, openIdx) {
  if (str[openIdx] !== '"') return -1;
  let i = openIdx + 1;
  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      i += 2;
      continue;
    }
    if (str[i] === '"') return i;
    i++;
  }
  return -1;
}

/**
 * Unescape a double-quoted bash string body (e.g. `-c` argument) for validation.
 * Handles `\\`, `\"`, `\$`, `` \` ``, and `\` before newline (line continuation).
 */
export function unescapeDoubleQuotedBashBody(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "\\" || n === '"' || n === "$" || n === "`") {
        out += n;
        i++;
        continue;
      }
      if (n === "\n") {
        i++;
        continue;
      }
      out += n;
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}

/**
 * Extract inner script strings passed to `bash`/`sh`/`dash` when `-c` is used, including
 * clustered short options ending in `c` (`-c`, `-ec`, `-lc`, `-xec`, `-uec`, …) and
 * chains like `bash -n -c "…"`.
 */
export function extractBashCInnerStrings(segment) {
  if (typeof segment !== "string" || !segment.trim()) return [];
  const out = [];
  const seen = new Set();
  // Match `-c` and clustered forms ending in `c` (`-ec`, `-lc`, `-xec`, …) plus `-flag … -c` chains.
  const re = /\b(?:bash|sh|dash)\s+(?:-[a-zA-Z\d#]+\s+)*-[a-zA-Z]*c\s+/g;
  let m;
  for (;;) {
    m = re.exec(segment);
    if (!m) break;
    const after = segment.slice(m.index + m[0].length).trimStart();
    let inner = null;
    if (after[0] === '"') {
      const close = findClosingDoubleQuote(after, 0);
      if (close === -1) continue;
      const rawInner = after.slice(1, close);
      inner = unescapeDoubleQuotedBashBody(rawInner);
    } else if (after[0] === "'") {
      const sq = after.match(/^'([^']*)'/);
      if (sq) inner = sq[1];
    }
    if (inner != null && !seen.has(inner)) {
      seen.add(inner);
      out.push(inner);
    }
  }
  return out;
}

/**
 * Tokens that look like repo-relative script paths (not bare shell builtins like `bash echo`).
 * @param {string} token - Raw capture from regex (may include quotes)
 */
function isLikelyScriptPath(token) {
  const inner = stripOuterShellQuotes(token);
  if (!inner || inner.startsWith("-") || inner.startsWith("/")) return false;
  if (/[$`\\]/.test(inner)) return false;
  if (/["']/.test(inner)) return false;
  if (!inner.includes("/") && !SCRIPT_EXT.test(inner)) {
    return false;
  }
  return true;
}

function normalizeRepoRel(p) {
  return stripOuterShellQuotes(p).replace(/^\.\//, "");
}

/**
 * If the whole segment is a lone `cd <dir>`, return { applied, cwd }.
 */
function applyCdSegment(segment, cwd) {
  const s = stripTrailingRedirects(segment.trim());
  if (!s) return { applied: false, cwd };
  const dq = s.match(/^\s*cd\s+"([^"]*)"\s*$/);
  if (dq) {
    return { applied: true, cwd: path.resolve(cwd, dq[1]) };
  }
  const sq = s.match(/^\s*cd\s+'([^']*)'\s*$/);
  if (sq) {
    return { applied: true, cwd: path.resolve(cwd, sq[1]) };
  }
  const unquoted = s.match(/^\s*cd\s+(\S+)\s*$/);
  if (unquoted) {
    return { applied: true, cwd: path.resolve(cwd, unquoted[1]) };
  }
  return { applied: false, cwd };
}

/**
 * Heuristic extraction of repo-relative file paths from shell command strings.
 * Conservative: avoids bare words (e.g. `bash echo`) and absolute paths.
 * @param {string} cmd
 * @returns {string[]} unique relative paths (no leading ./)
 */
export function collectRelativePathsFromShellCommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  const out = new Set();

  const reShell = /\b(?:bash|sh|dash)\s+([^\s;|&]+)/g;
  for (;;) {
    const m = reShell.exec(cmd);
    if (!m) break;
    const token = m[1];
    if (!isLikelyScriptPath(token)) continue;
    out.add(normalizeRepoRel(token));
  }

  const reDot = /(?:^|&&|\|\||[;|])\s*\.\/([^\s;|&]+)/g;
  for (;;) {
    const m = reDot.exec(cmd);
    if (!m) break;
    const t = stripOuterShellQuotes(m[1]);
    if (/[$`'"]/.test(t)) continue;
    out.add(t);
  }

  const reNode = /\bnode\s+([^\s;|&]+)/g;
  for (;;) {
    const m = reNode.exec(cmd);
    if (!m) break;
    const token = m[1];
    if (!isLikelyScriptPath(token)) continue;
    out.add(normalizeRepoRel(token));
  }

  return [...out];
}

/**
 * Split on `&&` only, but do not split `&&` inside single- or double-quoted regions
 * (so `bash -c "cd .. && bash scripts/x.sh"` stays one segment).
 */
export function splitAndChainSegmentsRespectingQuotes(cmd) {
  const segments = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote === '"') {
      if (ch === "\\" && i + 1 < cmd.length) {
        buf += ch + cmd[i + 1];
        i++;
        continue;
      }
      buf += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      buf += ch + cmd[i + 1];
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "&" && cmd[i + 1] === "&") {
      segments.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += ch;
  }
  segments.push(buf.trim());
  return segments.filter(Boolean);
}

/**
 * Collect script paths from a command, respecting `cd` segments so that
 * `cd .. && bash scripts/t.sh` yields `scripts/t.sh` resolved relative to the
 * directory *after* the `cd`, not the original cwd.
 *
 * Returns `{ rel, resolvedFrom }` pairs where `resolvedFrom` is the effective
 * cwd at the point the path was encountered.
 * @param {string} cmd
 * @param {string} startCwd - initial cwd for this command
 * @returns {{ rel: string, resolvedFrom: string }[]}
 */
function collectPathsWithCdContext(cmd, startCwd) {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  const results = [];
  const seen = new Set();

  const segments = splitAndChainSegmentsRespectingQuotes(cmd);
  let cwd = startCwd;
  for (const segment of segments) {
    const stripped = stripTrailingRedirects(segment);
    const { applied, cwd: nextCwd } = applyCdSegment(stripped, cwd);
    if (applied) {
      cwd = nextCwd;
      continue;
    }
    for (const rel of collectRelativePathsFromShellCommand(segment)) {
      if (!rel.includes("..")) {
        const key = `${cwd}\0${rel}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ rel, resolvedFrom: cwd });
        }
      }
    }
    // Recurse into bash -c bodies with current cwd
    for (const inner of extractBashCInnerStrings(segment)) {
      results.push(...collectPathsWithCdContext(inner, cwd));
    }
  }
  return results;
}

/**
 * When an issue's repo_path is a subdirectory of the workspace, test commands in
 * workspace-level coder.json often reference paths (e.g. scripts/test.sh) that
 * exist under the workspace root but not under the scoped repo root. If every
 * collected script path exists under the workspace but at least one is missing
 * under the repo root, run tests with cwd = workspace root.
 *
 * Respects `cd` segments: `cd .. && bash scripts/t.sh` resolves `scripts/t.sh`
 * relative to the directory after `cd ..`, not the original cwd.
 *
 * @param {string} repoDir - Scoped repo root (repo_path)
 * @param {string | undefined} workspaceDir - Workspace directory if known
 * @param {string[]} commands - setup / test / teardown command strings
 * @returns {string} Absolute directory to use as cwd for runShellSync
 */
export function resolveMonorepoTestCwd(repoDir, workspaceDir, commands) {
  const repoAbs = path.resolve(repoDir);
  if (!workspaceDir) return repoAbs;
  const wsAbs = path.resolve(workspaceDir);
  if (repoAbs === wsAbs) return repoAbs;
  const relToWs = path.relative(wsAbs, repoAbs);
  if (relToWs.startsWith("..") || relToWs === "") return repoAbs;

  // Collect paths with their effective cwd (after cd segments)
  const allPaths = [];
  for (const cmd of commands) {
    allPaths.push(...collectPathsWithCdContext(cmd, repoAbs));
  }
  if (allPaths.length === 0) return repoAbs;

  let needsWorkspace = false;
  for (const { rel, resolvedFrom } of allPaths) {
    const inResolved = existsSync(path.join(resolvedFrom, rel));
    // Re-check against both roots to decide repo vs workspace
    const inRepo = existsSync(path.join(repoAbs, rel));
    const inWs = existsSync(path.join(wsAbs, rel));
    // If the path exists at its effective cwd, the command is fine as-is
    if (inResolved) continue;
    if (inRepo && !inWs) return repoAbs;
    if (!inRepo && inWs) needsWorkspace = true;
  }
  return needsWorkspace ? wsAbs : repoAbs;
}

function throwMissingPath(fullCmd, rel, abs, root, effectiveCwd, meta) {
  const hint = [
    "Fix: set issue repo_path (or workflow state.repo_path) to the directory that contains these files,",
    "or change test.setup / test.command / test.teardown (or testCmd) so paths exist under that repo root,",
    "or prefix with cd (e.g. cd .. && bash scripts/test.sh).",
  ].join(" ");

  const lines = [
    "Test command references a path that does not exist under the effective directory for this command.",
    `  command: ${fullCmd.length > 500 ? `${fullCmd.slice(0, 500)}…` : fullCmd}`,
    `  missing path (relative to effective cwd): ${rel}`,
    `  expected absolute path: ${abs}`,
    `  repo root (repo_root, initial cwd): ${root}`,
  ];
  if (path.resolve(effectiveCwd) !== path.resolve(root)) {
    lines.push(
      `  effective cwd (after cd in command): ${path.resolve(effectiveCwd)}`,
    );
  }
  if (meta.testConfigPath) {
    lines.push(`  testConfigPath: ${meta.testConfigPath}`);
  }
  if (meta.repoPath != null && meta.repoPath !== "") {
    lines.push(`  repo_path: ${meta.repoPath}`);
  }

  throw new TestCommandPathError(`${lines.join("\n")}\n${hint}`, {
    repoRoot: root,
    command: fullCmd,
    missingRelative: rel,
    missingAbsolute: abs,
    effectiveCwd: path.resolve(effectiveCwd),
    testConfigPath: meta.testConfigPath,
    repoPath: meta.repoPath,
  });
}

/**
 * Validate paths for one logical command line (may recurse into bash -c bodies).
 */
function validateCommandString(root, cwd, cmd, meta, fullCmdForError) {
  const s = typeof cmd === "string" ? cmd.trim() : String(cmd).trim();
  if (!s) return;

  for (const inner of extractBashCInnerStrings(s)) {
    validateCommandString(root, cwd, inner, meta, fullCmdForError);
  }

  const segments = splitAndChainSegmentsRespectingQuotes(s);
  let c = cwd;
  for (const segment of segments) {
    const stripped = stripTrailingRedirects(segment);
    const { applied, cwd: nextCwd } = applyCdSegment(stripped, c);
    if (applied) {
      c = nextCwd;
      continue;
    }

    for (const inner of extractBashCInnerStrings(segment)) {
      validateCommandString(root, c, inner, meta, fullCmdForError);
    }

    for (const rel of collectRelativePathsFromShellCommand(segment)) {
      const abs = path.resolve(c, rel);
      if (!existsSync(abs)) {
        throwMissingPath(fullCmdForError, rel, abs, root, c, meta);
      }
    }
  }
}

/**
 * @param {string} repoDir - Absolute repo root (test cwd)
 * @param {string[]} commands - Shell command strings (setup / test / teardown / testCmd)
 * @param {object} [meta]
 * @param {string} [meta.testConfigPath]
 * @param {string} [meta.repoPath]
 * @param {string} [meta.workspaceDir] - When repo_path is a subdir, paths may exist under workspace root
 */
export function assertTestCommandPathsExist(repoDir, commands, meta = {}) {
  const root = path.resolve(repoDir);
  if (!path.isAbsolute(root)) {
    throw new TestCommandPathError(
      `repoDir must resolve to an absolute path, got: ${repoDir}`,
      { repoRoot: repoDir, ...meta },
    );
  }

  const validationRoot = resolveMonorepoTestCwd(
    repoDir,
    meta.workspaceDir,
    commands,
  );

  for (const cmd of commands) {
    const s = typeof cmd === "string" ? cmd.trim() : String(cmd).trim();
    if (!s) continue;
    validateCommandString(validationRoot, validationRoot, s, meta, s);
  }
}
