import { spawn } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
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
    this._readyPromise = opts.sqliteSync
      ? this._initSqlite()
      : Promise.resolve(false);
  }

  async _initSqlite() {
    if (!sqliteAvailable()) return false;
    try {
      await mkdir(path.dirname(this.sqlitePath), { recursive: true });
      await this._runSql(`
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

  async _ensureReady() {
    if (this._sqliteEnabled === undefined) {
      this._sqliteEnabled = await this._readyPromise;
    }
    return this._sqliteEnabled;
  }

  async _runSql(sql, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const proc = spawn("sqlite3", [this.sqlitePath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 5000);
        reject(new Error(`sqlite3 query timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on("data", (d) => {
        stdout += d;
      });
      proc.stderr.on("data", (d) => {
        stderr += d;
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0)
          reject(
            new Error(
              `sqlite3 failed: ${(stderr || stdout || "").trim() || "unknown error"}`,
            ),
          );
        else resolve(stdout);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      });
      proc.stdin.write(`${sql}\n`);
      proc.stdin.end();
    });
  }

  _relPath(absPath) {
    const rel = path.relative(this.workspaceDir, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel;
  }

  async appendSection(filePath, heading, lines = []) {
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
    await appendFile(filePath, block, "utf8");
    await this._syncToSqlite(filePath);
  }

  async _syncToSqlite(filePath) {
    if (!(await this._ensureReady())) return;
    if (
      !(await access(filePath)
        .then(() => true)
        .catch(() => false))
    )
      return;
    const relPath = this._relPath(filePath);
    if (!relPath) return;
    try {
      const content = await readFile(filePath, "utf8");
      const now = new Date().toISOString();
      await this._runSql(`
INSERT INTO scratchpad_files (file_path, content, updated_at)
VALUES ('${sqlEscape(relPath)}', '${sqlEscape(content)}', '${sqlEscape(now)}')
ON CONFLICT(file_path) DO UPDATE SET
  content = excluded.content,
  updated_at = excluded.updated_at;`);
    } catch {
      // best-effort
    }
  }

  async restoreFromSqlite(filePath) {
    if (!(await this._ensureReady())) return false;
    if (
      await access(filePath)
        .then(() => true)
        .catch(() => false)
    )
      return false;
    const relPath = this._relPath(filePath);
    if (!relPath) return false;
    try {
      const out = (
        await this._runSql(
          `SELECT content FROM scratchpad_files WHERE file_path='${sqlEscape(relPath)}' LIMIT 1;`,
        )
      ).trimEnd();
      if (!out) return false;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, out, "utf8");
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
