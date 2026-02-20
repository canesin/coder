/**
 * Native ppcommit implementation for coder.
 *
 * Replaces the external Python `ppcommit --uncommitted` dependency by performing
 * regex checks, AST checks (tree-sitter), and optional LLM checks (Gemini OpenAI-compatible API).
 *
 * Output format (compat with coder workflow):
 *   ERROR|WARNING: <message> at <file>:<line>
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { jsonrepair } from "jsonrepair";
import {
  loadConfig,
  PPCOMMIT_PRESETS,
  PpcommitConfigSchema,
  resolvePpcommitLlm,
} from "./config.js";

const require = createRequire(import.meta.url);

function tryRequire(spec) {
  try {
    return require(spec);
  } catch {
    return null;
  }
}

/**
 * @typedef {"ERROR"|"WARNING"} IssueLevel
 * @typedef {{ level: IssueLevel, message: string, file: string, line: number }} Issue
 */

// File extensions to check for code-specific patterns
const CODE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
]);

// Directories to skip when checking files
const SKIP_DIRS = new Set([
  "node_modules",
  "venv",
  ".venv",
  "__pycache__",
  ".git",
  "dist",
  "build",
  ".coder",
  ".gemini",
]);

const MARKDOWN_ALLOWED_DIRS = new Set(["docs", "doc", ".github"]);
const MARKDOWN_ALLOWED_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "LICENSE.md",
  "CONTRIBUTING.md",
]);

// --- Pattern Definitions ---

// Emoji detection pattern (covers most common emoji ranges)
const EMOJI_PATTERN =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}]/u;

const TODO_PATTERN = /\bTODO\b/i;
const FIXME_PATTERN = /\bFIXME\b/i;

// Patterns for LLM-generated code markers (checked only within comment lines)
const LLM_MARKERS = [
  /\bgenerated\s+by\s+(gpt|claude|copilot|ai|llm|chatgpt|gemini|bard)\b/i,
  /\bwritten\s+by\s+(ai|gpt|claude|copilot|llm)\b/i,
];

// Narration comment patterns (tutorial-style comments)
const NARRATION_PATTERNS = [
  /^\s*(?:#|\/\/|\/\*|\*)\s*step\s*\d+\b/i,
  /^\s*(?:#|\/\/|\/\*|\*)\s*first,?\s*(we|let'?s|i)\b/i,
  /^\s*(?:#|\/\/|\/\*|\*)\s*now\s*(we|let'?s|i)\s*(will|can|should|need)\b/i,
  /^\s*(?:#|\/\/|\/\*|\*)\s*next,?\s*(we|let'?s|i)\b/i,
  /^\s*(?:#|\/\/|\/\*|\*)\s*finally,?\s*(we|let'?s|i)\b/i,
  /^\s*(?:#|\/\/|\/\*|\*)\s*here\s+(we|i)\s+(are|will|define|create|implement)\b/i,
];

// Placeholder patterns
const PLACEHOLDER_PATTERNS = [
  /^\s*#\s*placeholder\b(?:\s*[:.-].*)?\s*$/i,
  /^\s*\/\/\s*placeholder\b(?:\s*[:.-].*)?\s*$/i,
  /^\s*#\s*your\s+code\s+here\b(?:\s*[:.-].*)?\s*$/i,
  /^\s*\/\/\s*your\s+code\s+here\b(?:\s*[:.-].*)?\s*$/i,
  /^\s*#\s*implement\s+me\b(?:\s*[:.-].*)?\s*$/i,
  /^\s*\/\/\s*implement\s+me\b(?:\s*[:.-].*)?\s*$/i,
  /^\s*pass\s*$/i,
  /raise\s+NotImplementedError\s*\(\s*\)/,
  /throw\s+new\s+Error\s*\(\s*["']not implemented/i,
  /\btodo!\s*\(\s*\)/,
  /\bunimplemented!\s*\(\s*\)/,
  /panic!\s*\(\s*["']not implemented/i,
];

// Backwards-compatibility hack patterns
const COMPAT_HACK_PATTERNS = [
  {
    // Only flag _vars that have an explicit "unused/compat/legacy" comment annotation.
    // Bare `let _cache = null` is a legitimate private-by-convention pattern.
    pattern:
      /^\s*(?:const|let|var)\s+_[a-zA-Z]\w*\s*=\s*\w+.*;?\s*\/\/.*(?:unused|compat|legacy)/i,
    name: "Unused variable with underscore prefix",
  },
  {
    pattern: /^\s*export\s*\{[^}]*\}.*\/[/*].*(?:compat|legacy|deprecated)/i,
    name: "Compatibility re-export",
  },
  {
    // Only match actual JS/TS comments, not text inside strings.
    // Requires the line to start with optional whitespace then //.
    pattern: /^\s*\/\/\s*(?:removed|deprecated|legacy|for backwards? compat)/i,
    name: "Deprecated/removed comment marker",
    lineOnly: true,
  },
  { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, name: "Empty catch block" },
];

// Over-engineering patterns (line-based detection)
const OVER_ENGINEERING_PATTERNS = [
  {
    pattern: /function\s+create[A-Z]\w*Factory\s*\(/i,
    name: "Factory function for potentially simple object",
  },
  { pattern: /class\s+\w+Factory\s*[{<]/i, name: "Factory class" },
  {
    pattern: /class\s+Abstract\w+\s*[{<]/i,
    name: "Abstract base class (verify single impl)",
  },
  {
    pattern: /try\s*\{[^}]*try\s*\{[^}]*try\s*\{/s,
    name: "Excessive try-catch nesting (3+ levels)",
  },
];

// --- Gitleaks integration (secret detection) ---

let _gitleaksChecked = false;

/**
 * Verify gitleaks is installed. Throws if not found.
 */
function assertGitleaksInstalled() {
  if (_gitleaksChecked) return;
  const res = spawnSync("gitleaks", ["version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.status !== 0) {
    throw new Error(
      "gitleaks is required for secret detection but was not found in PATH. " +
        "Install it: https://github.com/gitleaks/gitleaks#installing",
    );
  }
  _gitleaksChecked = true;
}

/**
 * Run gitleaks on the repository and return ppcommit-style issues,
 * filtered to only the given file list.
 *
 * @param {string} repoDir
 * @param {string[]} fileFilter - Only report findings in these files
 * @returns {Issue[]}
 */
function runGitleaksDetect(repoDir, fileFilter) {
  assertGitleaksInstalled();

  const tmpReport = path.join(
    os.tmpdir(),
    `gitleaks-${process.pid}-${Date.now()}.json`,
  );
  const args = [
    "detect",
    "--no-git",
    "-s",
    repoDir,
    "-r",
    tmpReport,
    "-f",
    "json",
  ];

  // Use repo-local gitleaks.toml if present
  const configPath = path.join(repoDir, "gitleaks.toml");
  if (existsSync(configPath)) {
    args.push("-c", configPath);
  }

  const res = spawnSync("gitleaks", args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 120000,
  });

  // Exit code 0 = no leaks, 1 = leaks found, other = gitleaks error
  if (res.status !== 0 && res.status !== 1) {
    try {
      unlinkSync(tmpReport);
    } catch {}
    return [
      {
        level: "ERROR",
        message: `gitleaks failed (exit ${res.status}): ${(res.stderr || "").trim().slice(0, 200)}`,
        file: ".",
        line: 0,
      },
    ];
  }

  let findings;
  try {
    const report = readFileSync(tmpReport, "utf8");
    findings = JSON.parse(report);
  } catch {
    return [];
  } finally {
    try {
      unlinkSync(tmpReport);
    } catch {}
  }

  if (!Array.isArray(findings) || findings.length === 0) return [];

  const filterSet = new Set(fileFilter);
  /** @type {Issue[]} */
  const issues = [];
  for (const f of findings) {
    const file = f.File || "";
    const relFile = path.relative(repoDir, path.resolve(repoDir, file));
    if (!filterSet.has(relFile)) continue;
    issues.push({
      level: "ERROR",
      message: `Secret detected by gitleaks (${f.RuleID || "unknown"}): ${f.Description || "potential secret"}. Use env vars or secret management.`,
      file: relFile,
      line: f.StartLine || 1,
    });
  }

  return issues;
}

const MAGIC_NUMBER_THRESHOLD = 10;
const MAGIC_NUMBER_ALLOWLIST = new Set([100, 1000, 60, 24, 365, 360, 180, 90]);

function applyPreset(ppcommitObj) {
  const preset = ppcommitObj.preset || "strict";
  const presetDefaults = PPCOMMIT_PRESETS[preset] || {};
  // Preset defaults apply first, then explicit user overrides win.
  // Only override keys that the user hasn't explicitly set in their config.
  return { ...presetDefaults, ...ppcommitObj };
}

function resolvePpcommitConfig(repoDir, ppcommitConfig) {
  if (ppcommitConfig)
    return PpcommitConfigSchema.parse(applyPreset(ppcommitConfig));
  const disableLlm =
    process.env.PPCOMMIT_DISABLE_LLM === "1" || process.env.NODE_ENV === "test";
  const fullConfig = loadConfig(repoDir);
  const llmFields = resolvePpcommitLlm(fullConfig);
  const config = { ...applyPreset(fullConfig.ppcommit), ...llmFields };
  if (disableLlm) return { ...config, enableLlm: false };
  return config;
}

// --- File discovery ---

function splitLines(s) {
  return s.replace(/\r\n/g, "\n").split("\n");
}

function listUncommittedFiles(repoDir) {
  const stagedAdded = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=A"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );
  const staged = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );
  const unstaged = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );

  /** @type {Set<string>} */
  const newFiles = new Set();
  /** @type {string[]} */
  const ordered = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const f of splitLines(stagedAdded.stdout || "")
    .map((l) => l.trim())
    .filter(Boolean)) {
    newFiles.add(f);
  }
  for (const f of splitLines(untracked.stdout || "")
    .map((l) => l.trim())
    .filter(Boolean)) {
    newFiles.add(f);
  }

  for (const f of splitLines(staged.stdout || "")
    .concat(splitLines(unstaged.stdout || ""))
    .concat(splitLines(untracked.stdout || ""))
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (!seen.has(f)) {
      ordered.push(f);
      seen.add(f);
    }
  }

  return { ordered, newFiles };
}

function shouldSkipPath(filePath) {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.some((p) => SKIP_DIRS.has(p));
}

function readUtf8File(repoDir, filePath) {
  const repoRoot = path.resolve(repoDir);
  const fullPath = path.resolve(repoRoot, filePath);
  const withinRepo = (candidate) => {
    const rel = path.relative(repoRoot, candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  try {
    if (!withinRepo(fullPath)) return "";
    const st = lstatSync(fullPath);
    if (st.isSymbolicLink()) return "";
    const real = realpathSync(fullPath);
    if (!withinRepo(real)) return "";
    return readFileSync(real, "utf8");
  } catch {
    return "";
  }
}

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// --- Checks ---

function isCommentLine(line) {
  return /^\s*(#|\/\/|\/\*|\*)/.test(line);
}

/**
 * @param {Issue[]} issues
 * @param {Issue} issue
 */
function pushIssue(issues, issue) {
  issues.push(issue);
}

function checkNewMarkdown(filePath, isNew, config, issues) {
  if (!config.blockNewMarkdown) return;
  if (!isNew) return;
  if (path.extname(filePath).toLowerCase() !== ".md") return;

  const filename = path.basename(filePath);
  if (MARKDOWN_ALLOWED_FILES.has(filename)) return;
  const parts = filePath.split(/[\\/]/);
  if (parts.some((p) => MARKDOWN_ALLOWED_DIRS.has(p))) return;

  pushIssue(issues, {
    level: "ERROR",
    message: "New markdown file detected outside allowed docs directories",
    file: filePath,
    line: 1,
  });
}

function checkWorkflowArtifacts(filePath, config, issues) {
  if (!config.blockWorkflowArtifacts) return;

  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return;

  const isDirOrWithin = (prefix) =>
    normalized === prefix || normalized.startsWith(prefix + "/");

  // Directories that should never be committed. If a repo genuinely uses these,
  // it can opt out via `git config ppcommit.blockWorkflowArtifacts false`.
  if (isDirOrWithin(".coder")) {
    pushIssue(issues, {
      level: "ERROR",
      message:
        "Workflow artifact detected (.coder/) — do not commit tool internals",
      file: filePath,
      line: 1,
    });
    return;
  }
  if (isDirOrWithin(".gemini")) {
    pushIssue(issues, {
      level: "ERROR",
      message:
        "Workflow artifact detected (.gemini/) — do not commit tool internals",
      file: filePath,
      line: 1,
    });
    return;
  }
  if (normalized === ".geminiignore") {
    pushIssue(issues, {
      level: "ERROR",
      message:
        "Workflow artifact detected (.geminiignore) — do not commit tool internals",
      file: filePath,
      line: 1,
    });
    return;
  }
}

function checkEmojis(content, filePath, config, issues, classify) {
  if (!config.blockEmojisInCode) return;
  if (!isCodeFile(filePath)) return;
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (classify?.stringOnlyRows.has(i)) continue;
    if (EMOJI_PATTERN.test(lines[i])) {
      pushIssue(issues, {
        level: "WARNING",
        message: "Emoji character in code",
        file: filePath,
        line: i + 1,
      });
    }
  }
}

function checkTodosFixmes(content, filePath, config, issues, classify) {
  if (!isCodeFile(filePath)) return;

  if (classify) {
    for (const c of classify.comments) {
      const cLines = splitLines(c.text);
      for (let j = 0; j < cLines.length; j++) {
        const line = cLines[j];
        if (config.blockTodos && TODO_PATTERN.test(line)) {
          pushIssue(issues, {
            level: "ERROR",
            message:
              "TODO comment found. Finish the task or create a tracked issue.",
            file: filePath,
            line: c.startRow + j + 1,
          });
        }
        if (config.blockFixmes && FIXME_PATTERN.test(line)) {
          pushIssue(issues, {
            level: "ERROR",
            message:
              "FIXME comment found. Finish the task or create a tracked issue.",
            file: filePath,
            line: c.startRow + j + 1,
          });
        }
      }
    }
    return;
  }

  // Regex fallback for languages without a tree-sitter grammar
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isCommentLine(line)) continue;
    if (config.blockTodos && TODO_PATTERN.test(line)) {
      pushIssue(issues, {
        level: "ERROR",
        message:
          "TODO comment found. Finish the task or create a tracked issue.",
        file: filePath,
        line: i + 1,
      });
    }
    if (config.blockFixmes && FIXME_PATTERN.test(line)) {
      pushIssue(issues, {
        level: "ERROR",
        message:
          "FIXME comment found. Finish the task or create a tracked issue.",
        file: filePath,
        line: i + 1,
      });
    }
  }
}

function checkLlmMarkers(content, filePath, config, issues, classify) {
  if (!config.blockLlmMarkers) return;
  if (!isCodeFile(filePath)) return;

  if (classify) {
    for (const c of classify.comments) {
      const cLines = splitLines(c.text);
      for (let j = 0; j < cLines.length; j++) {
        const line = cLines[j];
        for (const pattern of LLM_MARKERS) {
          if (pattern.test(line)) {
            pushIssue(issues, {
              level: "ERROR",
              message: "LLM generation marker detected",
              file: filePath,
              line: c.startRow + j + 1,
            });
            break;
          }
        }
      }
    }
    return;
  }

  // Regex fallback for languages without a tree-sitter grammar
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isCommentLine(line)) continue;
    for (const pattern of LLM_MARKERS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "ERROR",
          message: "LLM generation marker detected",
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

function checkNarrationComments(content, filePath, config, issues, classify) {
  if (!config.blockNarrationComments) return;
  if (!isCodeFile(filePath)) return;

  if (classify) {
    for (const c of classify.comments) {
      const cLines = splitLines(c.text);
      for (let j = 0; j < cLines.length; j++) {
        const line = cLines[j];
        for (const pattern of NARRATION_PATTERNS) {
          if (pattern.test(line)) {
            pushIssue(issues, {
              level: "WARNING",
              message: "Tutorial-style narration comment detected",
              file: filePath,
              line: c.startRow + j + 1,
            });
            break;
          }
        }
      }
    }
    return;
  }

  // Regex fallback for languages without a tree-sitter grammar
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isCommentLine(line)) continue;
    for (const pattern of NARRATION_PATTERNS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "WARNING",
          message: "Tutorial-style narration comment detected",
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

function checkPlaceholderCode(content, filePath, config, issues, classify) {
  if (!config.blockPlaceholderCode) return;
  if (!isCodeFile(filePath)) return;

  const isTestFile =
    /(^|\/|\\)(test|tests)(\/|\\)/i.test(filePath) || /test/i.test(filePath);
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (classify?.stringOnlyRows.has(i)) continue;
    const line = lines[i];
    if (isTestFile && /NotImplementedError/.test(line)) continue;
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "ERROR",
          message:
            "Placeholder code detected. Complete the implementation before committing.",
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

function checkCompatHacks(content, filePath, config, issues, classify) {
  if (!config.blockCompatHacks) return;
  if (!isCodeFile(filePath)) return;

  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (classify?.stringOnlyRows.has(i)) continue;
    const line = lines[i];
    for (const { pattern, name } of COMPAT_HACK_PATTERNS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "WARNING",
          message: `Backwards-compat hack detected: ${name}. Remove unused code entirely.`,
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

function checkOverEngineering(content, filePath, config, issues, classify) {
  if (!config.blockOverEngineering) return;
  if (!isCodeFile(filePath)) return;

  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (classify?.stringOnlyRows.has(i)) continue;
    const line = lines[i];
    for (const { pattern, name } of OVER_ENGINEERING_PATTERNS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "WARNING",
          message: `Potential over-engineering: ${name}. Prefer simpler constructs.`,
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

// --- AST checks (tree-sitter) ---

/** @type {Map<string, Parser>} */
const PARSERS = new Map();

function setupParsers() {
  if (PARSERS.size > 0) return;

  const ParserMod = require("tree-sitter");
  const ParserCtor = ParserMod?.default ?? ParserMod;

  const jsLang = tryRequire("tree-sitter-javascript");
  if (jsLang) {
    const jsParser = new ParserCtor();
    jsParser.setLanguage(jsLang);
    PARSERS.set(".js", jsParser);
    PARSERS.set(".jsx", jsParser);
  }

  const tsLang = tryRequire("tree-sitter-typescript");
  if (tsLang?.typescript && tsLang?.tsx) {
    const tsParser = new ParserCtor();
    tsParser.setLanguage(tsLang.typescript);
    PARSERS.set(".ts", tsParser);
    const tsxParser = new ParserCtor();
    tsxParser.setLanguage(tsLang.tsx);
    PARSERS.set(".tsx", tsxParser);
  }

  const pyLang = tryRequire("tree-sitter-python");
  if (pyLang) {
    const pyParser = new ParserCtor();
    pyParser.setLanguage(pyLang);
    PARSERS.set(".py", pyParser);
  }

  const goLang = tryRequire("tree-sitter-go");
  if (goLang) {
    const goParser = new ParserCtor();
    goParser.setLanguage(goLang);
    PARSERS.set(".go", goParser);
  }

  const rustLang = tryRequire("tree-sitter-rust");
  if (rustLang) {
    const rustParser = new ParserCtor();
    rustParser.setLanguage(rustLang);
    PARSERS.set(".rs", rustParser);
  }

  const javaLang = tryRequire("tree-sitter-java");
  if (javaLang) {
    const javaParser = new ParserCtor();
    javaParser.setLanguage(javaLang);
    PARSERS.set(".java", javaParser);
  }

  const bashLang = tryRequire("tree-sitter-bash");
  if (bashLang) {
    const bashParser = new ParserCtor();
    bashParser.setLanguage(bashLang);
    PARSERS.set(".sh", bashParser);
    PARSERS.set(".bash", bashParser);
    PARSERS.set(".zsh", bashParser);
  }
}

function getParserForFile(filePath) {
  setupParsers();
  const ext = path.extname(filePath).toLowerCase();
  return PARSERS.get(ext) || null;
}

function safeSliceByIndex(s, startIndex, endIndex) {
  // tree-sitter indices are byte offsets; for ASCII code this matches JS indices.
  return s.slice(startIndex, endIndex);
}

function parseNumericLiteral(text) {
  const t = text.replace(/_/g, "").trim();
  if (!t) return null;

  // Strip common suffixes (Java, Rust) and imaginary marker (Go).
  const stripped = t.replace(/[lLdDfF]$/, "").replace(/i$/, "");
  if (/^0x/i.test(stripped)) {
    const v = Number.parseInt(stripped, 16);
    return Number.isFinite(v) ? v : null;
  }
  if (/^0b/i.test(stripped)) {
    const v = Number.parseInt(stripped.slice(2), 2);
    return Number.isFinite(v) ? v : null;
  }
  if (/^0o/i.test(stripped)) {
    const v = Number.parseInt(stripped.slice(2), 8);
    return Number.isFinite(v) ? v : null;
  }
  const v = Number.parseFloat(stripped);
  return Number.isFinite(v) ? v : null;
}

function walkTree(node, fn) {
  fn(node);
  for (const child of node.namedChildren) walkTree(child, fn);
}

// --- AST-based line classification ---

/** Node types representing comments across supported tree-sitter grammars */
const COMMENT_NODE_TYPES = new Set([
  "comment", // JS, TS, Python, Go, Bash
  "line_comment", // Rust, Java
  "block_comment", // Rust, Java
]);

/** Node types representing string literals across supported tree-sitter grammars */
const STRING_NODE_TYPES = new Set([
  "string", // JS, TS, Python, Bash
  "template_string", // JS, TS
  "string_literal", // Rust, Java
  "raw_string_literal", // Rust, Go
  "interpreted_string_literal", // Go
  "char_literal", // Rust
  "byte_string_literal", // Rust
  "text_block", // Java
  "character_literal", // Java
  "raw_string", // Bash
  "concatenated_string", // Python
]);

/**
 * Parse file with tree-sitter and classify comment/string regions.
 * Returns null when no parser is available for the file type.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{ comments: Array<{text: string, startRow: number, endRow: number}>, stringOnlyRows: Set<number> } | null}
 */
function classifyFile(content, filePath) {
  const parser = getParserForFile(filePath);
  if (!parser) return null;

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return null;
  }

  const comments = [];
  const stringOnlyRows = new Set();

  walkTree(tree.rootNode, (node) => {
    if (COMMENT_NODE_TYPES.has(node.type)) {
      comments.push({
        text: safeSliceByIndex(content, node.startIndex, node.endIndex),
        startRow: node.startPosition.row,
        endRow: node.endPosition.row,
      });
    }
    if (STRING_NODE_TYPES.has(node.type)) {
      // Multi-line string: interior rows are string-only content.
      // Skip first/last rows since they contain surrounding code (quotes, concatenation, etc).
      if (node.endPosition.row > node.startPosition.row) {
        for (
          let r = node.startPosition.row + 1;
          r < node.endPosition.row;
          r++
        ) {
          stringOnlyRows.add(r);
        }
      }
    }
  });

  return { comments, stringOnlyRows };
}

function checkMagicNumbers(content, filePath, config, issues) {
  if (!config.blockMagicNumbers) return;
  if (!isCodeFile(filePath)) return;
  const parser = getParserForFile(filePath);
  if (!parser) return;

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return; // skip file if tree-sitter can't parse it
  }

  let count = 0;
  walkTree(tree.rootNode, (node) => {
    if (count >= 5) return;
    const t = node.type;
    if (
      t === "integer" ||
      t === "float" ||
      t === "number" ||
      t === "integer_literal" ||
      t === "float_literal" ||
      t === "floating_point_literal" ||
      t === "decimal_integer_literal" ||
      t === "hex_integer_literal" ||
      t === "octal_integer_literal" ||
      t === "binary_integer_literal" ||
      t === "int_literal"
    ) {
      const literal = safeSliceByIndex(content, node.startIndex, node.endIndex);
      const value = parseNumericLiteral(literal);
      if (value === null) return;
      if (Math.abs(value) <= MAGIC_NUMBER_THRESHOLD) return;
      if (MAGIC_NUMBER_ALLOWLIST.has(value)) return;

      pushIssue(issues, {
        level: "WARNING",
        message: `Magic number ${literal} found. Consider using a named constant.`,
        file: filePath,
        line: node.startPosition.row + 1,
      });
      count++;
    }
  });
}

// --- LLM check (Gemini OpenAI-compatible API) ---

function extractJsonArray(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];

  // Prefer parsing the full response first (often already valid JSON).
  try {
    const parsed = JSON.parse(jsonrepair(trimmed));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Fall through to bracket extraction.
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = trimmed.slice(firstBracket, lastBracket + 1);
    return JSON.parse(jsonrepair(candidate));
  }
  return [];
}

async function runLlmIssues(_repoDir, files, config) {
  // Best-effort: do not fail ppcommit if LLM analysis is unavailable.
  if (!config?.enableLlm) return /** @type {any[]} */ ([]);

  const explicitKey = String(config?.llmApiKey || "").trim();
  const keyEnvName = String(config?.llmApiKeyEnv || "").trim();
  const envKey = keyEnvName ? process.env[keyEnvName] : "";
  const apiKey =
    explicitKey ||
    envKey ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!apiKey) return /** @type {any[]} */ ([]);

  const snippets = files
    .map(
      ({ filePath, content }) =>
        `File: ${filePath}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``,
    )
    .join("\n\n");

  if (!snippets) return /** @type {any[]} */ ([]);

  const prompt = `Analyze this code for signs of AI/LLM-generated code that wasn't properly cleaned up.

## Definite Issues (ERROR level)
1. Tutorial-style narration comments ("First we...", "Now we...", "Step N:")
2. Comments that restate what code does ("// increment counter" above x++)
3. Placeholder code (pass, NotImplementedError, todo!(...), unimplemented!(...))
4. TODOs/FIXMEs left in the code

## Likely Issues (WARNING level)
1. Overly verbose comments explaining obvious code
2. Unnecessary abstraction layers (factories, wrappers, adapters) for simple operations
3. Code that looks copy-pasted from documentation with example variable names
4. Inconsistent naming within the same file (mixedCase vs snake_case)
5. Generic placeholder patterns (foo, bar, example, test123)
6. Excessive error handling for scenarios that can't happen
7. Unused imports or variables
8. Functions that just wrap a single other function call
9. Interfaces/abstract classes with only one implementation
10. Configuration objects for single use cases

## Code Being Analyzed
${snippets}

Respond with ONLY a JSON array. Each item:
{ "file": string, "line": number, "issue": string, "severity": "ERROR" | "WARNING" }

	If no issues found, respond with [].
	Only report clear issues, not speculation. Be specific about what's wrong.`;

  const serviceUrl =
    String(config?.llmServiceUrl || "").trim() ||
    "https://generativelanguage.googleapis.com/v1beta/openai";
  const baseUrl = serviceUrl.replace(/\/+$/, "");
  const endpoint = /\/chat\/completions$/i.test(baseUrl)
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const extractResponseText = (payload) => {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const first = choices[0] || {};
    const content = first?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
    }
    return "";
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutMs = 20000;
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config?.llmModel || "gemini-3.1-pro-preview",
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
            continue;
          }
          return [];
        }
        const payload = await response.json();
        const arr = extractJsonArray(extractResponseText(payload));
        return Array.isArray(arr) ? arr : [];
      } finally {
        clearTimeout(t);
      }
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      return [];
    }
  }
  return [];
}

// --- Output ---

function formatIssues(issues, treatWarningsAsErrors) {
  if (issues.length === 0) return "ppcommit: All checks passed\n";
  return (
    issues
      .map((i) => {
        const level =
          treatWarningsAsErrors && i.level === "WARNING" ? "ERROR" : i.level;
        return `${level}: ${i.message} at ${i.file}:${i.line}`;
      })
      .join("\n") + "\n"
  );
}

/**
 * List all tracked files plus untracked files in the repo.
 * Every file is treated as "new" for check purposes.
 *
 * @param {string} repoDir - Path to the git repository
 * @returns {{ ordered: string[], newFiles: Set<string> }}
 */
function listAllFiles(repoDir) {
  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );

  /** @type {Set<string>} */
  const newFiles = new Set();
  /** @type {string[]} */
  const ordered = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const f of splitLines(tracked.stdout || "")
    .concat(splitLines(untracked.stdout || ""))
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (!seen.has(f)) {
      ordered.push(f);
      seen.add(f);
      newFiles.add(f);
    }
  }

  return { ordered, newFiles };
}

/**
 * Discover files changed since a base branch (for PR-scope checks).
 *
 * @param {string} repoDir - Path to the git repository
 * @param {string} baseBranch - Base branch to diff against (e.g. "main")
 * @returns {{ ordered: string[], newFiles: Set<string>, error?: string }}
 */
function listFilesSinceBase(repoDir, baseBranch) {
  const base = (baseBranch || "").trim();
  if (!base) {
    return {
      ordered: [],
      newFiles: new Set(),
      error: "ERROR: --base must be a non-empty git ref.\n",
    };
  }

  const diffRange = `${base}...HEAD`;
  const diffNewArgs = ["diff", "--name-only", "--diff-filter=A", diffRange];
  const diffAllArgs = ["diff", "--name-only", "--diff-filter=ACMR", diffRange];

  const diffNew = spawnSync("git", diffNewArgs, {
    cwd: repoDir,
    encoding: "utf8",
  });
  const diffAll = spawnSync("git", diffAllArgs, {
    cwd: repoDir,
    encoding: "utf8",
  });
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      cwd: repoDir,
      encoding: "utf8",
    },
  );

  // If the base ref is missing/invalid, git writes errors to stderr and exits non-zero.
  // Treat that as a hard error; otherwise `stdout` is empty and we'd incorrectly report "no changes".
  if (diffNew.status !== 0 || diffAll.status !== 0) {
    const failing = diffNew.status !== 0 ? diffNew : diffAll;
    const details = (
      (failing.stderr || "") +
      (failing.error ? "\n" + failing.error.message : "")
    ).trim();
    let error = `ERROR: Failed to diff against base '${base}'. Ensure the ref exists locally (try 'git fetch') and is spelled correctly.\n`;
    if (details) error += details + "\n";
    return { ordered: [], newFiles: new Set(), error };
  }

  /** @type {Set<string>} */
  const newFiles = new Set();
  /** @type {string[]} */
  const ordered = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const f of splitLines(diffNew.stdout || "")
    .map((l) => l.trim())
    .filter(Boolean)) {
    newFiles.add(f);
  }
  for (const f of splitLines(untracked.stdout || "")
    .map((l) => l.trim())
    .filter(Boolean)) {
    newFiles.add(f);
  }

  for (const f of splitLines(diffAll.stdout || "")
    .concat(splitLines(untracked.stdout || ""))
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (!seen.has(f)) {
      ordered.push(f);
      seen.add(f);
    }
  }

  return { ordered, newFiles };
}

/**
 * Shared check loop used by both runPpcommitNative and runPpcommitBranch.
 *
 * @param {string} repoDir
 * @param {string[]} ordered
 * @param {Set<string>} newFiles
 * @param {ReturnType<typeof getConfig>} config
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
async function _runChecks(repoDir, ordered, newFiles, config) {
  /** @type {Issue[]} */
  const issues = [];

  // Secret detection via gitleaks (runs once for all files)
  if (config.blockSecrets) {
    const secretIssues = runGitleaksDetect(repoDir, ordered);
    issues.push(...secretIssues);
  }

  /** @type {{ filePath: string, content: string }[]} */
  const llmFiles = [];

  for (const filePath of ordered) {
    checkWorkflowArtifacts(filePath, config, issues);
    if (shouldSkipPath(filePath)) continue;

    const isNew = newFiles.has(filePath);
    checkNewMarkdown(filePath, isNew, config, issues);

    const content = readUtf8File(repoDir, filePath);
    if (!content) continue;

    if (isCodeFile(filePath)) {
      const classify = classifyFile(content, filePath);
      checkEmojis(content, filePath, config, issues, classify);
      checkTodosFixmes(content, filePath, config, issues, classify);
      checkLlmMarkers(content, filePath, config, issues, classify);
      checkNarrationComments(content, filePath, config, issues, classify);
      checkPlaceholderCode(content, filePath, config, issues, classify);
      checkCompatHacks(content, filePath, config, issues, classify);
      checkOverEngineering(content, filePath, config, issues, classify);
      checkMagicNumbers(content, filePath, config, issues);
      llmFiles.push({ filePath, content });
    }
  }

  // LLM analysis is best-effort and configurable (see config.enableLlm).
  const llmResults = await runLlmIssues(repoDir, llmFiles, config);
  for (const r of llmResults) {
    if (!r || typeof r !== "object") continue;
    const file = typeof r.file === "string" ? r.file : "";
    const line = Number.isFinite(r.line) ? r.line : 1;
    const issue = typeof r.issue === "string" ? r.issue : "";
    const severity = r.severity === "ERROR" ? "ERROR" : "WARNING";
    if (!file || !issue) continue;
    pushIssue(issues, {
      level: severity,
      message: `LLM analysis: ${issue.slice(0, 200)}`,
      file,
      line,
    });
  }

  const stdout = formatIssues(issues, config.treatWarningsAsErrors);
  const hasErrors =
    issues.some((i) => i.level === "ERROR") ||
    (config.treatWarningsAsErrors && issues.some((i) => i.level === "WARNING"));
  return { exitCode: hasErrors ? 1 : 0, stdout, stderr: "" };
}

/**
 * Run ppcommit checks on uncommitted files in the given repository.
 *
 * @param {string} repoDir - Path to the git repository
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export async function runPpcommitNative(repoDir, ppcommitConfig) {
  const config = resolvePpcommitConfig(repoDir, ppcommitConfig);
  if (config.skip)
    return {
      exitCode: 0,
      stdout: "ppcommit checks skipped via config\n",
      stderr: "",
    };

  const { ordered, newFiles } = listUncommittedFiles(repoDir);
  if (ordered.length === 0)
    return {
      exitCode: 0,
      stdout: "No uncommitted files to check\n",
      stderr: "",
    };

  return await _runChecks(repoDir, ordered, newFiles, config);
}

/**
 * Run ppcommit checks on files changed since a base branch.
 * This is the natural scope for a PR review.
 *
 * @param {string} repoDir - Path to the git repository
 * @param {string} baseBranch - Base branch to diff against (e.g. "main")
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export async function runPpcommitBranch(repoDir, baseBranch, ppcommitConfig) {
  const config = resolvePpcommitConfig(repoDir, ppcommitConfig);
  if (config.skip)
    return {
      exitCode: 0,
      stdout: "ppcommit checks skipped via config\n",
      stderr: "",
    };

  const { ordered, newFiles, error } = listFilesSinceBase(repoDir, baseBranch);
  if (error) return { exitCode: 2, stdout: "", stderr: error };
  if (ordered.length === 0)
    return {
      exitCode: 0,
      stdout: "No files changed since " + baseBranch + "\n",
      stderr: "",
    };

  return await _runChecks(repoDir, ordered, newFiles, config);
}

/**
 * Run ppcommit checks on all files in the repository.
 * Useful for examining a repo that hasn't used ppcommit before.
 *
 * @param {string} repoDir - Path to the git repository
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export async function runPpcommitAll(repoDir, ppcommitConfig) {
  const config = resolvePpcommitConfig(repoDir, ppcommitConfig);
  if (config.skip)
    return {
      exitCode: 0,
      stdout: "ppcommit checks skipped via config\n",
      stderr: "",
    };

  const { ordered, newFiles } = listAllFiles(repoDir);
  if (ordered.length === 0)
    return { exitCode: 0, stdout: "No files to check\n", stderr: "" };

  return await _runChecks(repoDir, ordered, newFiles, config);
}
