# coder

Orchestrates a multi-agent workflow using `gemini` + `claude` + `codex`.

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

If the repo's test command can't be auto-detected, pass one explicitly:

```bash
coder --test-cmd "pnpm test"
```

### `coder ppcommit`

Run ppcommit checks on all files in the repository:

```bash
coder ppcommit
```

To check only files changed since a specific branch (PR-scope review):

```bash
coder ppcommit --base main
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

- `coder` uses a host sandbox provider: commands run on your machine (so MCP/config works), and changes land in a dedicated git worktree under `.coder/worktrees/`.
- On Linux, `coder` prefers `systemd-run --user` for command execution (cgroup lifecycle + `KillMode=control-group`) and falls back to direct host execution if unavailable. Set `CODER_DISABLE_SYSTEMD_RUN=1` to force fallback, or `CODER_FORCE_SYSTEMD_RUN=1` to force systemd mode.
- Plan review uses Gemini CLI with search grounding to verify external API documentation.
- The workflow files live under `.coder/artifacts/` by default (`ISSUE.md`, `PLAN.md`, `PLANREVIEW.md`).
- Progress + logs are written under `.coder/` (see `.coder/state.json` and `.coder/logs/*.jsonl`).
- Repo includes examples for local tool config: `.mcp.example.json`, `.claude/settings.example.json`, and `coder.example.json`.
- Security model: this project orchestrates LLM agents that run shell commands. You should run it in an isolated environment (VM/container/throwaway devbox) with minimal credentials and no sensitive data. Hardening that environment is out of scope for this project.
- MCP workspace safety: tool calls are constrained to paths under the server startup directory by default. Set `CODER_ALLOW_ANY_WORKSPACE=1` to allow arbitrary workspace paths.
- Test health-check safety: URLs must target localhost by default. Set `CODER_ALLOW_EXTERNAL_HEALTHCHECK=1` to allow external health-check endpoints.
- Claude Code permissions: by default, `coder` passes `--dangerously-skip-permissions` to Claude Code. To force permission prompts, use `--claude-require-permissions` or set `CODER_CLAUDE_DANGEROUS=0`.
- Agent roles are configurable in `coder.json`:
  - `workflow.agentRoles.issueSelector`
  - `workflow.agentRoles.planner`
  - `workflow.agentRoles.planReviewer`
  - `workflow.agentRoles.programmer`
  - `workflow.agentRoles.reviewer`
  - `workflow.agentRoles.committer`
  Valid values: `"gemini" | "claude" | "codex"`.

Example:
```json
{
  "workflow": {
    "agentRoles": {
      "issueSelector": "gemini",
      "planner": "claude",
      "planReviewer": "gemini",
      "programmer": "claude",
      "reviewer": "codex",
      "committer": "codex"
    }
  }
}
```

`ppcommit` LLM settings (OpenAI-compatible API):
```json
{
  "ppcommit": {
    "enableLlm": true,
    "llmServiceUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "llmApiKey": "",
    "llmApiKeyEnv": "GEMINI_API_KEY",
    "llmModel": "gemini-3-flash-preview"
  }
}
```
API key resolution order:
1. `ppcommit.llmApiKey`
2. env var named by `ppcommit.llmApiKeyEnv`
3. `OPENAI_API_KEY`
4. `GEMINI_API_KEY`
5. `GOOGLE_API_KEY`

## MCP Autonomous Mode

When running as an MCP server (`coder-mcp`), use `coder_auto` for unattended batch execution.

- `coder_auto` processes multiple assigned issues in one loop and checkpoints progress in `.coder/loop-state.json`.
- `coder://loop-state` exposes the live queue/results for monitoring.
- Resume behavior is crash-safe: re-running `coder_auto` resumes from the next unfinished issue.
- Dependency-aware stacked mode is enabled: if issue `B` depends on `A`, `B` is drafted on top of `A`'s branch and its PR is created with `--base <A-branch>`.
- Safe reset is default: repo cleanup between issues does not discard local changes unless `destructiveReset: true` is explicitly set.
- `destructiveReset: true` checks out the repo's default branch between issues and runs `git restore`/`git clean`. If your `testCmd` assumes files that only exist on an unmerged feature branch (e.g. `Cargo.toml` only added in a previous PR), tests will fail due to missing infrastructure. In this case, either merge the prerequisite branch, stack dependent issues via dependencies, or adjust `testCmd`/`.coder/test.json` to match the repo.
