# coder

MCP server that orchestrates `gemini`, `claude`, and `codex` CLI agents across three composable pipelines: **Develop**, **Research**, and **Design**.

Each pipeline step is an independent **machine** — callable as a standalone MCP tool or composed into full workflows. An LLM host (Claude Code, Cursor, etc.) connects to the MCP server and drives the tools.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js >= 20 | Runtime |
| `gemini` CLI | Default agent for issue selection, plan review, committing |
| `claude` (Claude Code) | Default agent for planning, implementation |
| `codex` CLI | Default agent for code review, coalescing |
| `gh` CLI | GitHub issue listing and PR creation (`issueSource: "github"`) |
| `glab` CLI | GitLab issue listing and MR creation (`issueSource: "gitlab"`) |

Agent role assignments are configurable — any role can use any of the three backends.

## Install

```bash
npm install -g @canesin/coder
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
coder status                  # workflow state and progress
coder status --watch          # refresh every 3s
coder events                  # stream structured log events
coder events --follow         # tail logs in real-time
coder cancel                  # cancel current workflow run
coder pause                   # pause at next checkpoint
coder resume                  # resume paused run
coder config                  # resolved configuration
coder steering generate       # create steering context
coder steering update         # refresh steering context
coder ppcommit                # commit hygiene (all files)
coder ppcommit --base main    # commit hygiene (branch diff only)
coder version                 # version, branch, and commit info
coder serve                   # start MCP server (delegates to coder-mcp)
```

## Pipelines

### Develop

Picks up issues from GitHub, GitLab, Linear, or a local manifest, implements code, and pushes PRs/MRs:

```
issue-list → issue-draft → planning ⇄ plan-review → implementation → quality-review → pr-creation
```

```
coder_workflow { action: "start", workflow: "develop" }
```

The develop pipeline can run in **loop mode** to process multiple issues autonomously. Loop state (queue, progress, heartbeat) is exposed via `coder status` and the MCP `coder_status` tool. Crash recovery via `ensureCleanLoopStart` handles dirty branches, stale state, and interrupted runs.

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

`AgentPool.getAgent(role, { scope, mode })` manages lifecycle and caching. Roles: `issueSelector`, `planner`, `planReviewer`, `programmer`, `reviewer`, `committer`, `coalesce`.

Agents include automatic retry with configurable backoff and hang detection. If a primary agent fails, an optional fallback agent can take over (configured via `agents.fallback`).

### Workflow control

`coder_workflow` is the unified control plane:

| Action | Description |
|--------|-------------|
| `start` | Launch a pipeline run |
| `status` | Current stage, heartbeat, loop state, progress |
| `events` | Structured event log with cursor pagination |
| `pause` | Pause at next checkpoint |
| `resume` | Resume paused run |
| `cancel` | Cooperative cancellation |

XState v5 models the lifecycle: `idle → running → paused → completed/failed/cancelled/blocked`.

### State

All state lives under `.coder/` (gitignored):

| Path | Purpose |
|------|---------|
| `workflow-state.json` | Per-issue step completion |
| `loop-state.json` | Multi-issue develop queue, loop status, heartbeat |
| `checkpoint-{runId}.json` | Pipeline step checkpoints per run |
| `artifacts/` | `ISSUE.md`, `PLAN.md`, `PLANREVIEW.md` |
| `steering/` | Persistent project context (`product.md`, `structure.md`, `tech.md`) |
| `scratchpad/` | Research pipeline checkpoints |
| `logs/*.jsonl` | Structured event logs (tagged with `runId`) |
| `state.db` | Optional SQLite mirror |

## Configuration

Layered: `~/.config/coder/config.json` (user) → `coder.json` (repo) → MCP tool inputs.

```jsonc
{
  // Model selection (see coder.example.json for full structure)
  "models": {
    "gemini": { "model": "gemini-3-flash-preview" },
    "claude": { "model": "claude-sonnet-4-6" }
  },

  // Agent role assignments (gemini | claude | codex)
  "workflow": {
    "agentRoles": {
      "issueSelector": "gemini",
      "planner": "claude",
      "planReviewer": "gemini",
      "programmer": "claude",
      "reviewer": "codex",
      "committer": "gemini",
      "coalesce": "codex"
    },
    // Issue source: "github" (default), "linear", "gitlab", or "local"
    // github → gh CLI, gitlab → glab CLI, linear → Linear MCP, local → .coder/local-issues/
    "issueSource": "github",
    "localIssuesDir": ".coder/local-issues",
    "wip": { "push": true, "autoCommit": true },
    "maxPlanRevisions": 3,
    // Post-step hooks (shell commands triggered on workflow events)
    "hooks": [
      { "on": "machine_complete", "machine": "implementation", "run": "npm run lint" }
    ]
  },

  // Agent retry, hang detection, and fallback
  "agents": {
    "retry": {
      "retries": 1,
      "backoffMs": 5000,
      "retryOnRateLimit": true,
      "hangTimeoutMs": 300000
    },
    // Fallback agents when primary fails (role → agent name)
    "fallback": {}
  },

  // Commit hygiene (tree-sitter AST-based)
  // Presets: "strict" (default), "relaxed", "minimal"
  "ppcommit": {
    "preset": "strict",
    "enableLlm": true,
    "llmModelRef": "gemini"
  },

  // Test execution (setup/teardown hooks, health checks, timeouts)
  "test": {
    "command": "",
    "allowNoTests": false,
    "setup": [],
    "teardown": [],
    "healthCheck": null,
    "timeoutMs": 600000
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

Built-in commit hygiene checker using tree-sitter AST analysis. Three presets control strictness:

| Preset | Description |
|--------|-------------|
| `strict` | All checks enabled (default) |
| `relaxed` | Disables magic numbers, narration, new-markdown, and workflow artifact checks |
| `minimal` | Only secrets and gitleaks — everything else off |

Blocks (in `strict` mode):

- Secrets and API keys (+ gitleaks integration)
- TODO/FIXME comments
- LLM narration markers (`Here we...`, `Step 1:`, etc.)
- Emojis in code (not strings)
- Magic numbers
- Placeholder code and compat hacks
- Over-engineering patterns
- New markdown files outside allowed directories

Each check can be individually toggled (e.g., `"blockMagicNumbers": false`). Optional LLM-assisted checks via Gemini API for deeper analysis.

## Steering context

Persistent project knowledge in `.coder/steering/` that agents receive automatically:

```bash
coder steering generate   # scan repo, create product.md / structure.md / tech.md
coder steering update     # refresh after significant changes
```

Also available as MCP tools (`coder_steering_generate`, `coder_steering_update`) and the `coder://steering` MCP resource.

## Hooks

User-defined shell commands triggered on workflow events. Configure in `config.workflow.hooks[]`:

```jsonc
{ "on": "machine_complete", "machine": "implementation", "run": "npm run lint" }
```

The `machine` field accepts a regex pattern for matching multiple machines.

Events: `workflow_start`, `workflow_complete`, `workflow_failed`, `machine_start`, `machine_complete`, `machine_error`, `loop_start`, `loop_complete`, `issue_start`, `issue_complete`, `issue_failed`, `issue_skipped`, `issue_deferred`.

Hook scripts receive `CODER_HOOK_EVENT`, `CODER_HOOK_MACHINE`, `CODER_HOOK_STATUS`, `CODER_HOOK_DATA`, and `CODER_HOOK_RUN_ID` environment variables. Failures are logged but never break the workflow.

## Safety

- Workspace boundaries enforced — symlink escape detection on workspace and scratchpad paths
- Non-destructive reset between issues (opt-in `destructiveReset`)
- Crash recovery at loop start — WIP-commits known branches, resets stale state
- Health-check URLs restricted to localhost
- One active run per workspace (concurrent starts force-cancel previous)
- Session TTL with automatic cleanup (HTTP mode)
- Agent hang detection with configurable timeout (default 5 min)
- Codex runs inside the host sandbox with `--dangerously-bypass-approvals-and-sandbox` for Linux compatibility
- `CODER_ALLOW_ANY_WORKSPACE=1` to allow arbitrary paths
- `CODER_ALLOW_EXTERNAL_HEALTHCHECK=1` for external health-check URLs

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini CLI + ppcommit LLM checks (auto-aliased) |
| `ANTHROPIC_API_KEY` | Claude Code |
| `OPENAI_API_KEY` | Codex CLI |
| `GITHUB_TOKEN` | GitHub API (issues, PRs) — used by `gh` CLI |
| `GITLAB_TOKEN` / `GITLAB_API_TOKEN` | GitLab API — used by `glab` CLI |
| `LINEAR_API_KEY` | Linear issue tracking |
| `GOOGLE_STITCH_API_KEY` | Design pipeline (Google Stitch) |
| `CODER_ALLOW_ANY_WORKSPACE` | Allow arbitrary workspace paths (default: restricted) |
| `CODER_ALLOW_EXTERNAL_HEALTHCHECK` | Allow non-localhost health-check URLs |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
