/**
 * Native ppcommit implementation for coder.
 *
 * Replaces the external Python `ppcommit --uncommitted` dependency by performing
 * regex checks, AST checks (tree-sitter), and LLM checks (Gemini CLI).
 *
 * Output format (compat with coder workflow):
 *   ERROR|WARNING: <message> at <file>:<line>
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { jsonrepair } from "jsonrepair";

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
const SKIP_DIRS = new Set(["node_modules", "venv", ".venv", "__pycache__", ".git", "dist", "build", ".coder"]);

const MARKDOWN_ALLOWED_DIRS = new Set(["docs", "doc", ".github"]);
const MARKDOWN_ALLOWED_FILES = new Set(["README.md", "CHANGELOG.md", "LICENSE.md", "CONTRIBUTING.md"]);

// --- Pattern Definitions ---

// Emoji detection pattern (covers most common emoji ranges)
const EMOJI_PATTERN = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}]/u;

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
  { pattern: /^\s*(?:const|let|var)\s+_[a-zA-Z]\w*\s*=\s*\w+.*;?\s*(?:\/\/.*(?:unused|compat|legacy))?$/i, name: "Unused variable with underscore prefix" },
  { pattern: /^\s*export\s*\{[^}]*\}.*\/[/*].*(?:compat|legacy|deprecated)/i, name: "Compatibility re-export" },
  { pattern: /\/[/*]\s*(?:removed|deprecated|legacy|for backwards? compat)/i, name: "Deprecated/removed comment marker" },
  { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, name: "Empty catch block" },
];

// Over-engineering patterns (line-based detection)
const OVER_ENGINEERING_PATTERNS = [
  { pattern: /function\s+create[A-Z]\w*Factory\s*\(/i, name: "Factory function for potentially simple object" },
  { pattern: /class\s+\w+Factory\s*[{<]/i, name: "Factory class" },
  { pattern: /class\s+Abstract\w+\s*[{<]/i, name: "Abstract base class (verify single impl)" },
  { pattern: /try\s*\{[^}]*try\s*\{[^}]*try\s*\{/s, name: "Excessive try-catch nesting (3+ levels)" },
];

// Secret patterns
const SECRET_PATTERNS = [
  { pattern: /AKIA[0-9A-Z]{16}/, name: "AWS Access Key" },
  { pattern: /(api[_-]?key|apikey)\s*[=:]\s*['"][^'"]{20,}['"]/i, name: "API key" },
  { pattern: /(secret[_-]?key|secretkey)\s*[=:]\s*['"][^'"]{20,}['"]/i, name: "Secret key" },
  { pattern: /(password|passwd|pwd)\s*[=:]\s*['"][^'"]+['"]/i, name: "Password" },
  { pattern: /\btoken\b\s*[=:]\s*['"][^'"]{20,}['"]/i, name: "Token" },
  { pattern: /bearer\s+[a-zA-Z0-9_.\\-]{20,}/i, name: "Bearer token" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, name: "GitHub PAT" },
  { pattern: /gho_[a-zA-Z0-9]{36}/, name: "GitHub OAuth Token" },
  { pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/, name: "GitHub Fine-grained PAT" },
  { pattern: /sk-[a-zA-Z0-9]{48}/, name: "OpenAI API Key" },
  { pattern: /sk-proj-[a-zA-Z0-9_-]{80,}/, name: "OpenAI Project API Key" },
  { pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/, name: "Private key" },
];

const MAGIC_NUMBER_THRESHOLD = 10;
const MAGIC_NUMBER_ALLOWLIST = new Set([100, 1000, 60, 24, 365, 360, 180, 90]);

// --- Git config ---

function parseGitBool(value, defaultValue) {
  if (!value) return defaultValue;
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return defaultValue;
}

function gitConfigGet(repoDir, key) {
  const res = spawnSync("git", ["config", "--get", key], { cwd: repoDir, encoding: "utf8" });
  if (res.status !== 0) return "";
  return (res.stdout || "").trim();
}

function getGitBool(repoDir, keys, defaultValue) {
  for (const key of keys) {
    const val = gitConfigGet(repoDir, key);
    if (val) return parseGitBool(val, defaultValue);
  }
  return defaultValue;
}

function getConfig(repoDir) {
  // Support both `ppcommit.*` and the legacy `preprecommit.*` prefix.
  const prefixes = ["ppcommit", "preprecommit"];
  const k = (suffixes) => prefixes.flatMap((p) => suffixes.map((s) => `${p}.${s}`));

  const skip = getGitBool(repoDir, k(["skip"]), false);
  if (skip) return { skip: true };

  return {
    skip: false,
    blockNewMarkdown: getGitBool(repoDir, k(["blockNewMarkdown"]), true),
    blockEmojisInCode: getGitBool(repoDir, k(["blockEmojisInCode", "blockEmojis"]), true),
    blockTodos: getGitBool(repoDir, k(["blockTodos"]), true),
    blockFixmes: getGitBool(repoDir, k(["blockFixmes"]), true),
    blockMagicNumbers: getGitBool(repoDir, k(["blockMagicNumbers"]), true),
    blockNarrationComments: getGitBool(repoDir, k(["blockNarrationComments"]), true),
    blockLlmMarkers: getGitBool(repoDir, k(["blockLlmMarkers"]), true),
    blockPlaceholderCode: getGitBool(repoDir, k(["blockPlaceholderCode"]), true),
    blockSecrets: getGitBool(repoDir, k(["blockSecrets"]), true),
    blockCompatHacks: getGitBool(repoDir, k(["blockCompatHacks"]), true),
    blockOverEngineering: getGitBool(repoDir, k(["blockOverEngineering"]), true),
    treatWarningsAsErrors: getGitBool(repoDir, k(["treatWarningsAsErrors"]), false),
  };
}

// --- File discovery ---

function splitLines(s) {
  return s.replace(/\r\n/g, "\n").split("\n");
}

function listUncommittedFiles(repoDir) {
  const stagedAdded = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=A"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const staged = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const unstaged = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: repoDir,
    encoding: "utf8",
  });

  /** @type {Set<string>} */
  const newFiles = new Set();
  /** @type {string[]} */
  const ordered = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const f of splitLines(stagedAdded.stdout || "").map((l) => l.trim()).filter(Boolean)) {
    newFiles.add(f);
  }
  for (const f of splitLines(untracked.stdout || "").map((l) => l.trim()).filter(Boolean)) {
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
  const fullPath = path.join(repoDir, filePath);
  try {
    return readFileSync(fullPath, "utf8");
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

function checkEmojis(content, filePath, config, issues) {
  if (!config.blockEmojisInCode) return;
  if (!isCodeFile(filePath)) return;
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    if (EMOJI_PATTERN.test(lines[i])) {
      pushIssue(issues, { level: "WARNING", message: "Emoji character in code", file: filePath, line: i + 1 });
    }
  }
}

function checkTodosFixmes(content, filePath, config, issues) {
  if (!isCodeFile(filePath)) return;
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isCommentLine(line)) continue;
    if (config.blockTodos && TODO_PATTERN.test(line)) {
      pushIssue(issues, {
        level: "ERROR",
        message: "TODO comment found. Finish the task or create a tracked issue.",
        file: filePath,
        line: i + 1,
      });
    }
    if (config.blockFixmes && FIXME_PATTERN.test(line)) {
      pushIssue(issues, {
        level: "ERROR",
        message: "FIXME comment found. Finish the task or create a tracked issue.",
        file: filePath,
        line: i + 1,
      });
    }
  }
}

function checkLlmMarkers(content, filePath, config, issues) {
  if (!config.blockLlmMarkers) return;
  if (!isCodeFile(filePath)) return;
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

function checkNarrationComments(content, filePath, config, issues) {
  if (!config.blockNarrationComments) return;
  if (!isCodeFile(filePath)) return;
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

function checkPlaceholderCode(content, filePath, config, issues) {
  if (!config.blockPlaceholderCode) return;
  if (!isCodeFile(filePath)) return;

  const isTestFile = /(^|\/|\\)(test|tests)(\/|\\)/i.test(filePath) || /test/i.test(filePath);
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTestFile && /NotImplementedError/.test(line)) continue;
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "ERROR",
          message: "Placeholder code detected. Complete the implementation before committing.",
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

function checkSecrets(content, filePath, config, issues) {
  if (!config.blockSecrets) return;

  // Skip common false-positive files
  if (/\.(lock)$/.test(filePath) || /(^|\/|\\)package-lock\.json$/.test(filePath) || /(^|\/|\\)yarn\.lock$/.test(filePath)) {
    return;
  }

  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, name } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        pushIssue(issues, {
          level: "ERROR",
          message: `Potential secret detected (${name}). Use env vars or secret management.`,
          file: filePath,
          line: i + 1,
        });
        break;
      }
    }
  }
}

function checkCompatHacks(content, filePath, config, issues) {
  if (!config.blockCompatHacks) return;
  if (!isCodeFile(filePath)) return;

  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
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

function checkOverEngineering(content, filePath, config, issues) {
  if (!config.blockOverEngineering) return;
  if (!isCodeFile(filePath)) return;

  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
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

  const ParserMod = tryRequire("tree-sitter");
  const ParserCtor = ParserMod?.default ?? ParserMod;
  if (!ParserCtor) return;

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

function checkMagicNumbers(content, filePath, config, issues) {
  if (!config.blockMagicNumbers) return;
  if (!isCodeFile(filePath)) return;
  const parser = getParserForFile(filePath);
  if (!parser) return;

  let count = 0;
  try {
    const tree = parser.parse(content);
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
  } catch {
    // Best-effort; ignore parse errors.
  }
}

function checkUnusedVariables(content, filePath, config, issues) {
  if (!config.blockMagicNumbers) return;
  if (!isCodeFile(filePath)) return;
  const parser = getParserForFile(filePath);
  if (!parser) return;

  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Array<{ name: string, line: number }>} */
  const defined = [];

  const IDENT_TYPES = new Set(["identifier", "name", "variable_name"]);
  const DEF_CONTEXT_TYPES = new Set([
    "assignment",
    "variable_declarator",
    "parameter",
    "for_statement",
    "pattern_binding",
    "let_declaration",
    "local_variable_declaration",
    "variable_assignment",
    "variable_declaration",
  ]);

  try {
    const tree = parser.parse(content);
    /** @param {any} node @param {boolean} inDef */
    const collect = (node, inDef) => {
      if (IDENT_TYPES.has(node.type)) {
        const name = safeSliceByIndex(content, node.startIndex, node.endIndex);
        if (name && name !== "_" && !name.startsWith("_")) {
          if (inDef) defined.push({ name, line: node.startPosition.row + 1 });
          else used.add(name);
        }
      }
      const nextInDef = inDef || DEF_CONTEXT_TYPES.has(node.type);
      for (const child of node.namedChildren) collect(child, nextInDef);
    };
    collect(tree.rootNode, false);
  } catch {
    return;
  }

  let emitted = 0;
  for (const def of defined) {
    if (emitted >= 10) break;
    if (!used.has(def.name)) {
      pushIssue(issues, {
        level: "WARNING",
        message: `Potential unused variable '${def.name}'`,
        file: filePath,
        line: def.line,
      });
      emitted++;
    }
  }
}

// --- LLM check (Gemini CLI) ---

function filterGeminiNoise(output) {
  return splitLines(output)
    .filter((line) => {
      const l = line.trim();
      if (!l) return false;
      if (l.startsWith("Warning:")) return false;
      if (l.includes("YOLO mode")) return false;
      if (l.includes("Loading extension")) return false;
      if (l.includes("Hook registry")) return false;
      if (l.includes("Found stored OAuth")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function extractJsonArray(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = trimmed.slice(firstBracket, lastBracket + 1);
    return JSON.parse(jsonrepair(candidate));
  }
  return [];
}

function runGeminiIssues(repoDir, files) {
  // Best-effort: do not fail ppcommit if Gemini is unavailable.
  const maxFiles = 3;
  const snippets = files
    .slice(0, maxFiles)
    .map(({ filePath, content }) => `File: ${filePath}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``)
    .join("\n\n");

  if (!snippets) return /** @type {any[]} */ ([]);

  const prompt = `Analyze this code for signs of AI/LLM-generated code that wasn't properly cleaned up.

## Definite Issues (ERROR level)
1. Tutorial-style narration comments ("First we...", "Now we...", "Step N:")
2. Comments that restate what code does ("// increment counter" above x++)
3. Placeholder code (pass, NotImplementedError, todo!(), unimplemented!())
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

  const res = spawnSync("gemini", ["--yolo", "-m", "gemini-3-flash-preview", "-o", "json"], {
    cwd: repoDir,
    encoding: "utf8",
    input: prompt,
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.status !== 0) return [];

  const filtered = filterGeminiNoise((res.stdout || "") + (res.stderr || ""));
  try {
    const arr = extractJsonArray(filtered);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// --- Output ---

function formatIssues(issues, treatWarningsAsErrors) {
  if (issues.length === 0) return "ppcommit: All checks passed\n";
  return (
    issues
      .map((i) => {
        const level = treatWarningsAsErrors && i.level === "WARNING" ? "ERROR" : i.level;
        return `${level}: ${i.message} at ${i.file}:${i.line}`;
      })
      .join("\n") + "\n"
  );
}

/**
 * Run ppcommit checks on uncommitted files in the given repository.
 *
 * @param {string} repoDir - Path to the git repository
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export function runPpcommitNative(repoDir) {
  const config = getConfig(repoDir);
  if (config.skip) return { exitCode: 0, stdout: "ppcommit checks skipped via config\n", stderr: "" };

  const { ordered, newFiles } = listUncommittedFiles(repoDir);
  if (ordered.length === 0) return { exitCode: 0, stdout: "No uncommitted files to check\n", stderr: "" };

  /** @type {Issue[]} */
  const issues = [];

  /** @type {{ filePath: string, content: string }[]} */
  const llmFiles = [];

  for (const filePath of ordered) {
    if (shouldSkipPath(filePath)) continue;

    const isNew = newFiles.has(filePath);
    checkNewMarkdown(filePath, isNew, config, issues);

    const content = readUtf8File(repoDir, filePath);
    if (!content) continue;

    checkSecrets(content, filePath, config, issues);

    if (isCodeFile(filePath)) {
      checkEmojis(content, filePath, config, issues);
      checkTodosFixmes(content, filePath, config, issues);
      checkLlmMarkers(content, filePath, config, issues);
      checkNarrationComments(content, filePath, config, issues);
      checkPlaceholderCode(content, filePath, config, issues);
      checkCompatHacks(content, filePath, config, issues);
      checkOverEngineering(content, filePath, config, issues);
      checkMagicNumbers(content, filePath, config, issues);
      checkUnusedVariables(content, filePath, config, issues);
      llmFiles.push({ filePath, content });
    }
  }

  // LLM analysis is best-effort.
  const llmResults = runGeminiIssues(repoDir, llmFiles);
  for (const r of llmResults) {
    if (!r || typeof r !== "object") continue;
    const file = typeof r.file === "string" ? r.file : "";
    const line = Number.isFinite(r.line) ? r.line : 1;
    const issue = typeof r.issue === "string" ? r.issue : "";
    const severity = r.severity === "ERROR" ? "ERROR" : "WARNING";
    if (!file || !issue) continue;
    pushIssue(issues, { level: severity, message: `LLM analysis: ${issue.slice(0, 200)}`, file, line });
  }

  const stdout = formatIssues(issues, config.treatWarningsAsErrors);
  const hasErrors = issues.some((i) => i.level === "ERROR") || (config.treatWarningsAsErrors && issues.some((i) => i.level === "WARNING"));
  return { exitCode: hasErrors ? 1 : 0, stdout, stderr: "" };
}
