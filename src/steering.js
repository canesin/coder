import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const STEERING_DIR_NAME = "steering";

/**
 * Returns the path to the .coder/steering/ directory for a workspace.
 */
export function steeringDirFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", STEERING_DIR_NAME);
}

/**
 * Returns the path to the combined steering.md file (for backward compat).
 */
export function steeringFilePath(workspaceDir) {
  return path.join(workspaceDir, ".coder", "steering.md");
}

const STEERING_FILES = ["product.md", "structure.md", "tech.md"];

/**
 * Load all steering files from .coder/steering/ and return combined content.
 * Falls back to .coder/steering.md if the directory doesn't exist.
 * Returns undefined if no steering content exists.
 */
export function loadSteeringContext(workspaceDir) {
  const dir = steeringDirFor(workspaceDir);
  if (existsSync(dir)) {
    const parts = [];
    for (const file of STEERING_FILES) {
      const p = path.join(dir, file);
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, "utf8").trim();
          if (content) parts.push(content);
        } catch {
          // skip unreadable files
        }
      }
    }
    if (parts.length > 0) return parts.join("\n\n---\n\n");
  }

  // Fallback: single steering.md
  const singleFile = steeringFilePath(workspaceDir);
  if (existsSync(singleFile)) {
    try {
      const raw = readFileSync(singleFile, "utf8").trim();
      if (raw) return raw;
    } catch {
      // best-effort
    }
  }

  return undefined;
}

/**
 * Write steering files to .coder/steering/ directory.
 * @param {string} workspaceDir
 * @param {{ product?: string, structure?: string, tech?: string }} files
 */
export function writeSteeringFiles(workspaceDir, files) {
  const dir = steeringDirFor(workspaceDir);
  mkdirSync(dir, { recursive: true });

  const written = [];
  for (const [key, content] of Object.entries(files)) {
    if (!content) continue;
    const filename = `${key}.md`;
    if (!STEERING_FILES.includes(filename)) continue;
    writeFileSync(path.join(dir, filename), content, "utf8");
    written.push(filename);
  }

  // Also write combined steering.md for backward compat
  const combined = loadSteeringContext(workspaceDir);
  if (combined) {
    writeFileSync(steeringFilePath(workspaceDir), combined, "utf8");
  }

  return written;
}

/**
 * Build a prompt for an agent to generate steering files for a repository.
 * @param {string} repoRoot - Absolute path to the repo
 */
export function buildSteeringGenerationPrompt(repoRoot) {
  return `Analyze this repository and generate three steering documents that capture essential project knowledge for AI agents working on this codebase.

Repository root: ${repoRoot}

Generate EXACTLY three sections, each wrapped in the specified XML tags:

<product>
# Product Context

## Purpose
[What this project does and why it exists]

## Target Users
[Who uses this and how]

## Key Flows
[The 3-5 most important user/developer workflows]
</product>

<structure>
# Repository Structure

## Directory Layout
[Key directories and what they contain — focus on src/ structure]

## Module Map
[How the main modules connect — which modules depend on which]

## Entry Points
[Main entry points: CLI commands, servers, test runners]
</structure>

<tech>
# Tech Stack & Conventions

## Stack
[Languages, frameworks, key dependencies with versions]

## Conventions
[Coding patterns, naming conventions, file organization rules]

## Development
[How to build, test, lint, and run the project]
</tech>

IMPORTANT:
- Be concise. Each section should be 20-50 lines.
- Focus on information that helps AI agents write correct code.
- Reference actual file paths and function names from the repo.
- Do NOT include generic advice — only project-specific facts.`;
}

/**
 * Parse the agent's response into individual steering file contents.
 * @param {string} response - Agent response with XML-tagged sections
 * @returns {{ product?: string, structure?: string, tech?: string }}
 */
export function parseSteeringResponse(response) {
  const result = {};

  for (const section of ["product", "structure", "tech"]) {
    const regex = new RegExp(
      `<${section}>\\s*([\\s\\S]*?)\\s*</${section}>`,
      "i",
    );
    const match = response.match(regex);
    if (match?.[1]?.trim()) {
      result[section] = match[1].trim();
    }
  }

  return result;
}
