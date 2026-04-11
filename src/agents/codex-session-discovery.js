import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROLLOUT_PATTERN = /^rollout-.*\.jsonl$/;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

/**
 * Find a Codex session ID for the given workspace, scoped to sessions created
 * during the current run (run-boundary filter). Iterates files by mtime asc
 * (oldest first) and returns the first cwd match — tie-breaker only.
 *
 * @param {string} workspaceDir - Absolute path to workspace (must match cwd in session file)
 * @param {number} runStartTimeMs - Timestamp (Date.now()) recorded before execute(); only accept files with mtime >= runStartTimeMs (strict; no slack)
 * @returns {Promise<string|null>} - sessionId or null if not found
 */
export async function discoverCodexSessionId(workspaceDir, runStartTimeMs) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  const workspaceResolved = path.resolve(workspaceDir);

  function collectFiles(dir, acc = []) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          collectFiles(full, acc);
        } else if (e.isFile() && ROLLOUT_PATTERN.test(e.name)) {
          acc.push(full);
        }
      }
    } catch {
      // ignore missing dirs or permission errors
    }
    return acc;
  }

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }

    const allFiles = collectFiles(sessionsDir);
    const filtered = allFiles.filter((f) => {
      try {
        const stat = statSync(f);
        return stat.mtimeMs >= runStartTimeMs;
      } catch {
        return false;
      }
    });

    const safeMtime = (f) => {
      try {
        return statSync(f).mtimeMs;
      } catch {
        return Infinity;
      }
    };
    filtered.sort((a, b) => safeMtime(a) - safeMtime(b));

    for (const filePath of filtered) {
      try {
        const content = readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            const sid = obj?.sessionId;
            const cwd = obj?.cwd;
            if (typeof sid === "string" && typeof cwd === "string") {
              const cwdResolved = path.resolve(cwd);
              if (cwdResolved === workspaceResolved) {
                return sid;
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return null;
}
