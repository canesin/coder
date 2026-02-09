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
3. Write `.coder/artifacts/ISSUE.md` in the workspace.
4. Ask Claude Code to write `.coder/artifacts/PLAN.md` in the workspace.
5. Run built-in plan review (Gemini) and save critique to `.coder/artifacts/PLANREVIEW.md`.
6. Ask Claude Code to update the plan and implement the feature.
7. Ask Codex CLI to run built-in ppcommit checks, fix issues, and run tests (no bypasses). Then `coder` updates `.coder/artifacts/ISSUE.md` with completion status (no redundant final agent pass).

## Notes

- `coder` uses a VibeKit SDK "host sandbox" provider: commands run on your machine (so MCP/config works), and changes land in a dedicated git worktree under `.coder/worktrees/`.
- Plan review uses Gemini CLI with search grounding to verify external API documentation.
- The workflow files live under `.coder/artifacts/` by default (`ISSUE.md`, `PLAN.md`, `PLANREVIEW.md`).
- Progress + logs are written under `.coder/` (see `.coder/state.json` and `.coder/logs/*.jsonl`).

## MCP Autonomous Mode

When running as an MCP server (`coder-mcp`), use `coder_auto` for unattended batch execution.

- `coder_auto` processes multiple assigned issues in one loop and checkpoints progress in `.coder/loop-state.json`.
- `coder://loop-state` exposes the live queue/results for monitoring.
- Resume behavior is crash-safe: re-running `coder_auto` resumes from the next unfinished issue.
- Dependency-aware stacked mode is enabled: if issue `B` depends on `A`, `B` is drafted on top of `A`'s branch and its PR is created with `--base <A-branch>`.
- Safe reset is default: repo cleanup between issues does not discard local changes unless `destructiveReset: true` is explicitly set.
- `destructiveReset: true` checks out the repo's default branch between issues and runs `git restore`/`git clean`. If your `testCmd` assumes files that only exist on an unmerged feature branch (e.g. `Cargo.toml` only added in a previous PR), tests will fail due to missing infrastructure. In this case, either merge the prerequisite branch, stack dependent issues via dependencies, or adjust `testCmd`/`.coder/test.json` to match the repo.
