# coder

MCP server that orchestrates `gemini`, `claude`, and `codex` CLI agents across three composable pipelines: **Develop**, **Research**, and **Design**.

Each pipeline step is an independent **machine** — callable as a standalone MCP tool or composed into full workflows. An LLM host (Claude Code, Cursor, etc.) connects to the MCP server and drives the tools.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js >= 20 | Runtime |
| `gemini` CLI | Default agent for issue selection, plan review, research |
| `claude` (Claude Code) | Default agent for planning, implementation |
| `codex` CLI | Default agent for code review, committing |
| `gh` CLI | GitHub issue listing, PR creation |

Agent role assignments are configurable — any role can use any of the three backends.

## Install

```bash
npm install -g @canesin/coder-mcp
```

Or from source:

```bash
git clone https://github.com/canesin/coder.git
cd coder
npm install
npm link
```

## Quick start

### As MCP server (primary interface)

Add to your MCP client config (`.mcp.json`, Claude Code settings, Cursor, etc.):

```json
{
  "mcpServers": {
    "coder": {
      "command": "coder-mcp"
    }
  }
}
```

Or with explicit path (from source):

```json
{
  "mcpServers": {
    "coder": {
      "command": "node",
      "args": ["./bin/coder-mcp.js"]
    }
  }
}
```

Or run directly:

```bash
coder-mcp                    # stdio (default)
coder-mcp --transport http   # HTTP on 127.0.0.1:8787/mcp
```

### CLI (management)

```bash
coder status              # workflow state and progress
coder config              # resolved configuration
coder ppcommit            # commit hygiene (all files)
coder ppcommit --base main  # commit hygiene (branch diff only)
coder serve               # start MCP server (delegates to coder-mcp)
```

## Pipelines

### Develop

Picks up GitHub/Linear issues, implements code, pushes PRs:

```
issue-list → issue-draft → planning → plan-review → implementation → quality-review → pr-creation
```

```
coder_workflow { action: "start", workflow: "develop" }
```

### Research

Turns ideas into validated, reference-grounded issue backlogs:

```
context-gather → deep-research → tech-selection → poc-validation → issue-synthesis → issue-critique → spec-publish
```

```
coder_workflow { action: "start", workflow: "research", pointers: "..." }
```

### Design

Generates UI designs from intent descriptions via Google Stitch:

```
intent-capture → ui-generation → ui-refinement → spec-export
```

```
coder_workflow { action: "start", workflow: "design", designIntent: "..." }
```

## Architecture

### Machines

Every pipeline step is a machine defined with `defineMachine()`:

```js
defineMachine({ name, description, inputSchema, execute })
```

Machines are auto-registered as MCP tools (`coder_develop_planning`, `coder_research_context_gather`, etc.) and composable into pipelines via `WorkflowRunner`.

```
src/machines/
  develop/     7 machines
  research/    7 machines
  design/      4 machines
  shared/      2 reusable (web-research, poc-runner)
```

### Agents

Three backends, assigned to roles via config:

| Backend | Class | Use case |
|---------|-------|----------|
| CLI | `CliAgent` | Complex tasks — planning, implementation, review |
| API | `ApiAgent` | Simple tasks — classification, JSON extraction |
| MCP | `McpAgent` | External MCP servers (Stitch) |

`AgentPool.getAgent(role, { scope, mode })` manages lifecycle and caching. Roles: `issueSelector`, `planner`, `planReviewer`, `programmer`, `reviewer`, `committer`.

### Workflow control

`coder_workflow` is the unified control plane:

| Action | Description |
|--------|-------------|
| `start` | Launch a pipeline run |
| `status` | Current stage, heartbeat, progress |
| `events` | Structured event log with cursor pagination |
| `pause` | Pause at next checkpoint |
| `resume` | Resume paused run |
| `cancel` | Cooperative cancellation |
| `reset` | Stop active run(s), clear workflow state/artifacts, delete stale issue branches |

XState v5 models the lifecycle: `idle → running → paused → completed/failed/cancelled`.

### Local Issue Backlogs (`localIssuesDir`)

When running develop workflow against local generated issues, `manifest.json` provides the canonical issue list (IDs + file mapping), and issue markdown can override execution metadata:

- `Status: done|completed|closed|resolved` in an issue `.md` file causes that issue to be skipped.
- `Depends-On: ISSUE-001, ISSUE-002` in markdown overrides manifest dependency edges for that issue.
- `manifest.json` still controls which issue files are considered part of the active backlog.

If a run gets stuck with stale state/branches, use:

```json
coder_workflow { "action": "reset", "workflow": "develop" }
```

### State

All state lives under `.coder/` (gitignored):

| Path | Purpose |
|------|---------|
| `workflow-state.json` | Per-issue step completion |
| `loop-state.json` | Multi-issue develop queue |
| `artifacts/` | `ISSUE.md`, `PLAN.md`, `PLANREVIEW.md` |
| `scratchpad/` | Research pipeline checkpoints |
| `logs/*.jsonl` | Structured event logs |
| `state.db` | Optional SQLite mirror |

## Configuration

Layered: `~/.config/coder/config.json` (user) → `coder.json` (repo) → MCP tool inputs.

### `models` — Single source of truth for model IDs, endpoints, and API keys

Each entry specifies the model identifier, endpoints, and environment variable for the API key. `apiEndpoint` is the provider's native REST endpoint (used by `ApiAgent`). `openaiEndpoint` is the OpenAI-compatible chat completions base URL (used by ppcommit LLM checks).

```jsonc
"models": {
  "gemini": {
    "model": "gemini-3-flash-preview",
    "apiEndpoint": "https://generativelanguage.googleapis.com/v1beta",
    "openaiEndpoint": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKeyEnv": "GEMINI_API_KEY"
  },
  "claude": {
    "model": "claude-sonnet-4-6",
    "apiEndpoint": "https://api.anthropic.com",
    "openaiEndpoint": "",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "codex": {
    "model": "gpt-5.3-codex",
    "apiEndpoint": "https://api.openai.com",
    "openaiEndpoint": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

### `workflow.agentRoles` — CLI agent assignments

Maps each workflow step to a CLI agent: **`gemini`**, **`claude`**, or **`codex`**. These are the only accepted values — they refer to the host CLI tools (Gemini CLI, Claude Code, OpenAI Codex), not to entries in `models`.

```jsonc
"workflow": {
  "agentRoles": {
    "issueSelector": "gemini",  // picks issues from backlog
    "planner": "claude",        // writes PLAN.md
    "planReviewer": "gemini",   // critiques PLAN.md → PLANREVIEW.md
    "programmer": "claude",     // implements the plan
    "reviewer": "codex",        // code review + coalesce analysis
    "committer": "codex"        // commit, push, PR creation
  },
  "wip": { "push": true, "autoCommit": true }
}
```

The actual model each CLI uses is controlled by that CLI's own configuration, not by `models` above.

### Other sections

```jsonc
{
  // Commit hygiene (tree-sitter AST-based)
  "ppcommit": {
    "enableLlm": true,
    "llmModelRef": "gemini"  // references models.gemini for model/endpoint/key
  },

  // Test execution
  "test": {
    "command": "",
    "allowNoTests": false
  },

  // Design pipeline (requires Google Stitch)
  "design": {
    "stitch": { "enabled": false },
    "specDir": "spec/UI"
  }
}
```

See [`coder.example.json`](coder.example.json) for a full example.

## ppcommit

Built-in commit hygiene checker using tree-sitter AST analysis. Blocks:

- Secrets and API keys
- TODO/FIXME comments
- LLM narration markers (`Here we...`, `Step 1:`, etc.)
- Emojis in code (not strings)
- Magic numbers
- Placeholder code and compat hacks
- Over-engineering patterns
- New markdown files outside allowed directories

Optional LLM-assisted checks via Gemini API for deeper analysis.

## Safety

- Workspace boundaries enforced — agents operate within the target repo
- Non-destructive reset between issues (opt-in `destructiveReset`)
- Explicit workflow recovery via `coder_workflow(action="reset")`
- Health-check URLs restricted to localhost
- One active run per workspace
- Session TTL with automatic cleanup (HTTP mode)
- `CODER_ALLOW_ANY_WORKSPACE=1` to allow arbitrary paths
- `CODER_ALLOW_EXTERNAL_HEALTHCHECK=1` for external health-check URLs

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini CLI + ppcommit LLM checks (auto-aliased) |
| `ANTHROPIC_API_KEY` | Claude Code |
| `OPENAI_API_KEY` | Codex CLI |
| `GITHUB_TOKEN` | GitHub API (issues, PRs) |
| `LINEAR_API_KEY` | Linear issue tracking |
| `GOOGLE_STITCH_API_KEY` | Design pipeline (Google Stitch) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
