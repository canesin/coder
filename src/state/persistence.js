import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { sqlEscape, sqliteAvailable } from "../sqlite.js";

/**
 * Scratchpad persistence — file + optional SQLite sync.
 */
export class ScratchpadPersistence {
  /**
   * @param {{
   *   workspaceDir: string,
   *   scratchpadDir: string,
   *   sqlitePath: string,
   *   sqliteSync: boolean,
   * }} opts
   */
  constructor(opts) {
    this.workspaceDir = opts.workspaceDir;
    this.scratchpadDir = opts.scratchpadDir;
    this.sqlitePath = opts.sqlitePath;
    this._sqliteEnabled = opts.sqliteSync ? this._initSqlite() : false;
  }

  _initSqlite() {
    if (!sqliteAvailable()) return false;
    try {
      mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
      this._runSql(`
CREATE TABLE IF NOT EXISTS scratchpad_files (
  file_path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);
      return true;
    } catch {
      return false;
    }
  }

  _runSql(sql) {
    const res = spawnSync("sqlite3", [this.sqlitePath], {
      encoding: "utf8",
      input: `${sql}\n`,
    });
    if (res.status !== 0) {
      throw new Error(
        `sqlite3 failed: ${(res.stderr || res.stdout || "").trim() || "unknown error"}`,
      );
    }
    return res.stdout || "";
  }

  _relPath(absPath) {
    const rel = path.relative(this.workspaceDir, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel;
  }

  appendSection(filePath, heading, lines = []) {
    const body = Array.isArray(lines)
      ? lines.filter((line) => line !== null && line !== undefined)
      : [String(lines)];
    const block = [
      "",
      `## ${heading}`,
      `- timestamp: ${new Date().toISOString()}`,
      ...body,
      "",
    ].join("\n");
    appendFileSync(filePath, block, "utf8");
    this._syncToSqlite(filePath);
  }

  _syncToSqlite(filePath) {
    if (!this._sqliteEnabled) return;
    if (!existsSync(filePath)) return;
    const relPath = this._relPath(filePath);
    if (!relPath) return;
    try {
      const content = readFileSync(filePath, "utf8");
      const now = new Date().toISOString();
      this._runSql(`
INSERT INTO scratchpad_files (file_path, content, updated_at)
VALUES ('${sqlEscape(relPath)}', '${sqlEscape(content)}', '${sqlEscape(now)}')
ON CONFLICT(file_path) DO UPDATE SET
  content = excluded.content,
  updated_at = excluded.updated_at;`);
    } catch {
      // best-effort
    }
  }

  restoreFromSqlite(filePath) {
    if (!this._sqliteEnabled) return false;
    if (existsSync(filePath)) return false;
    const relPath = this._relPath(filePath);
    if (!relPath) return false;
    try {
      const out = this._runSql(
        `SELECT content FROM scratchpad_files WHERE file_path='${sqlEscape(relPath)}' LIMIT 1;`,
      );
      if (!out) return false;
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, out, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  issueScratchpadPath(issue) {
    if (!issue) return path.join(this.scratchpadDir, "scratchpad.md");
    const sanitize = (v, fallback = "item") => {
      const normalized = String(v || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return normalized || fallback;
    };
    const source = sanitize(issue.source, "issue");
    const id = sanitize(issue.id, "id");
    return path.join(this.scratchpadDir, `${source}-${id}.md`);
  }
}
