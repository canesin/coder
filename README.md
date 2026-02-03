# coder

Orchestrates a multi-agent workflow using the VibeKit SDK + `gemini` + `claude` + `codex`.

This tool is designed for a workspace folder that contains one or more git repositories as subfolders.

## Prerequisites

- Node.js >= 20
- `gemini`, `claude` (Claude Code), and `codex` CLIs installed and authenticated on your machine
- No external tool installs required — plan review and commit hygiene checks are built in

## Usage

Install from this repo:

```bash
cd coder
npm install
npm link
```

Then run from the workspace folder that contains your project repositories:

```bash
coder
```

Optional:

```bash
# Prompt for issue selection (instead of auto-picking Gemini's recommendation)
coder --interactive
```

You can also run from anywhere and point at a workspace:

```bash
coder --workspace /path/to/workspace
```

If the repo’s test command can’t be auto-detected, pass one explicitly:

```bash
coder --test-cmd "pnpm test"
```

By default, `coder` will:

1. Ask Gemini to list issues assigned to you (via MCPs) and recommend the easiest.
2. Ask you 3 questions to clarify the chosen issue.
3. Write `ISSUE.md` in the workspace root.
4. Ask Claude Code to write `PLAN.md` in the workspace root.
5. Run built-in plan review (Gemini) and save critique to `PLANREVIEW.md`.
6. Ask Claude Code to update the plan and implement the feature.
7. Ask Codex CLI to run built-in ppcommit checks, fix issues, and run tests (no bypasses).
8. Ask Claude Code to run tests again and update `ISSUE.md` with completion status.

## Notes

- `coder` uses a VibeKit SDK "host sandbox" provider: commands run on your machine (so MCP/config works), and changes land in a dedicated git worktree under `.coder/worktrees/`.
- Plan review uses Gemini CLI with search grounding to verify external API documentation.
- The workspace files `ISSUE.md`, `PLAN.md`, and `PLANREVIEW.md` live at the workspace root.
- Progress + logs are written under `.coder/` (see `.coder/state.json` and `.coder/logs/*.jsonl`).
