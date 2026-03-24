# Coder v2 — Architecture Design

## Vision

v2 is a rethink of how coder operates: from an MCP tool that Claude calls, to a **persistent local daemon** that Claude (and humans) observe and direct through a CLI and TUI. Workflows become long-running, multiplexed processes across many repos, coordinated by well-typed interfaces that let them chain into each other.

---

## What Changes from v1

| Concern | v1 | v2 |
|---|---|---|
| Transport | MCP stdio + HTTP | HTTP only (localhost) |
| Entry point | Claude calls MCP tools | CLI + Skill |
| Concurrency | One workflow at a time per session | Many workflows, many repos |
| Monitoring | Log files | TUI dashboard |
| Workflow chaining | Manual | Typed artifact interfaces |
| Multi-repo | No | Yes (repo registry + queue) |

---

## Components

### 1. Daemon

A single persistent process, started once, running until stopped.

```
coder daemon start   # starts on localhost:7734 (default)
coder daemon stop
coder daemon status
```

- Binds to `localhost` only — not exposed externally
- Manages all workflow lifecycle and state
- Persists everything to SQLite (`.coder/state.db` per repo, `~/.local/share/coder/daemon.db` for global state)
- Serves both the REST/SSE control API and the MCP HTTP transport on the same port

**Why daemon instead of per-session?**
Workflows take hours. The daemon survives terminal closes, SSH drops, and Claude context resets. Claude reconnects and resumes monitoring rather than restarting.

---

### 2. HTTP API

Bound to `localhost:7734`. All control goes through here — CLI, TUI, and Claude all speak to it.

```
# Workflow control
POST   /workflows/run            { workflow, repo, input?, issueNumber? }
GET    /workflows                list (all or filtered by repo/status)
GET    /workflows/:id            status + current step + output artifact
GET    /workflows/:id/events     SSE stream (step changes, log lines, prompts)
DELETE /workflows/:id            cancel

# Repo registry
GET    /repos                    list registered repos
POST   /repos                    { path, name? }
DELETE /repos/:id

# Issue queue
GET    /queue                    issues across all repos, ordered by priority
POST   /queue/dispatch           kick off issue selection across repos
POST   /queue/repos/:id/refresh  re-fetch issues for one repo

# MCP (for Claude)
GET    /mcp                      MCP endpoint (HTTP transport)
```

SSE events on `/workflows/:id/events`:
```json
{ "type": "step_change",  "step": "programmer",  "at": "2026-02-26T..." }
{ "type": "log",          "stream": "stdout",    "data": "..." }
{ "type": "prompt",       "message": "...",      "id": "prompt-abc" }
{ "type": "completed",    "artifact": { ... } }
{ "type": "failed",       "error": "..." }
```

Human-in-the-loop prompts (`type: "prompt"`) are answered via:
```
POST /workflows/:id/respond   { promptId, value }
```

---

### 3. CLI

Single binary (`coder`), installed globally.

```
coder daemon start|stop|restart|status|logs

coder run <workflow> [--repo <path>] [--issue <n>] [--input <json>]
coder list [--repo <path>] [--status running|done|failed]
coder attach <run-id>          # open TUI focused on this workflow
coder logs <run-id> [--follow]
coder cancel <run-id>

coder repos add <path> [--name <n>]
coder repos remove <path-or-id>
coder repos list

coder queue [--dispatch]       # show/kick off issue queue across repos
```

`coder run` without `--issue` triggers issue selection (the agent picks what to work on). With `--issue N` it goes straight to planning.

---

### 4. TUI

Built with **Ink v4** (React for the terminal). Launched by `coder attach` or `coder list --tui`.

**Dashboard view** — all running workflows at a glance:

```
╔══════════════════════════════════════════════════════════════════╗
║  coder v2   ● 3 running   1 queued   tab:focus   q:quit   ?:help ║
╠══════════════╦═══════════════════════════════════════════════════╣
║ WORKFLOWS    ║ coder/fix-auth  [develop]  ████████░░  12m        ║
║              ║ Step: programmer › fix attempt 2/3                ║
║ ● coder      ║                                                   ║
║   develop    ║ [stdout] Running tests...                         ║
║   12m  #45   ║ [stdout] PASS src/agents/pool.test.js             ║
║              ║ [stdout] FAIL src/config.test.js                  ║
║ ● ui-lib     ║                                                   ║
║   design     ╠═══════════════════════════════════════════════════╣
║   3m   #12   ║ > respond to prompt? _                            ║
║              ╚═══════════════════════════════════════════════════╣
║ ✓ api-svc    ║ ui-lib/add-button  [design]  ██░░░░░░░░  3m       ║
║   done  #8   ║ Step: stitch › generating screens                 ║
║              ║                                                   ║
║ ⏳ backend   ║ api-svc/fix-auth  [develop]  completed  45m       ║
║   queued     ║ PR: https://github.com/org/api/pull/89            ║
╚══════════════╩═══════════════════════════════════════════════════╝
```

Keyboard:
- `↑/↓` — select workflow in sidebar
- `Enter/Tab` — focus detail pane
- `r` — respond to active prompt
- `c` — cancel selected workflow
- `n` — trigger new workflow (repo picker)
- `q` — quit TUI (workflows keep running)

---

### 5. Typed Workflow Interfaces

The core reliability improvement in v2: every workflow has a Zod-validated **input schema** and **output artifact schema**. Artifacts are written to `.coder/artifacts/<run-id>.json` and validated before being passed downstream.

#### Input/Output contracts

**IssueRef** (common primitive)
```typescript
{ repo: string, issueNumber: number, title: string, body: string }
```

**Design workflow**
```
Input:  DesignInput  = IssueRef | { designBrief: string }
Output: DesignArtifact = {
  workflow: "design", runId: string, repo: string,
  specDir: string,          // path to generated screen specs
  screens: string[],        // file paths
  exportedAt: string,
}
```

**Research workflow**
```
Input:  ResearchInput  = IssueRef | DesignArtifact | { question: string }
Output: ResearchArtifact = {
  workflow: "research", runId: string, repo: string,
  specPath: string,         // .coder/specs/research-<id>.md
  problemStatement: string,
  proposedApproach: string,
  decisions: Array<{ title: string, rationale: string }>,
  publishedAt: string,
}
```

**Develop workflow**
```
Input:  DevelopInput  = IssueRef | ResearchArtifact
Output: DevelopArtifact = {
  workflow: "develop", runId: string, repo: string,
  prUrl: string | null,
  branchName: string,
  commitSha: string,
  testsPass: boolean,
  reviewSummary: string,
  completedAt: string,
}
```

#### Chaining

A completed workflow can automatically trigger the next one:

```
coder run research --repo ./ui-lib --issue 12 --then design
#                                                  ^ when research completes,
#                                                    pass artifact to design
```

Or manually:
```
coder run develop --repo ./api --input "$(coder artifacts get <research-run-id>)"
```

Internally, the artifact JSON is validated against the downstream workflow's input schema before dispatch. Validation failure is a hard error with a clear message.

---

### 6. Agent Skill

A `skills/coder/` directory installed alongside the binary (or at `~/.local/share/coder/skill/`). Claude Code loads it on activation.

```
skills/coder/
├── SKILL.md              # name, description, and operating instructions
└── references/
    ├── workflows.md      # workflow names, inputs, outputs, examples
    ├── config.md         # config schema reference
    └── api.md            # HTTP API reference for direct calls
```

**SKILL.md** (frontmatter + body):

```markdown
---
name: coder
description: >
  Orchestrate multi-step AI coding workflows (research, design, develop)
  across one or more repos. Use when the user wants to plan, implement,
  or review a feature or bug fix using autonomous agents.
---

# Coder Workflow Orchestrator

## When to use this skill
- User wants to work on a GitHub/GitLab/Linear issue
- User wants to run design, research, or develop workflow
- User wants to monitor running workflows or check progress
- User wants to chain workflows (research → develop, design → develop)

## Quick start
1. Check daemon: `coder daemon status`
2. Start if needed: `coder daemon start`
3. Run a workflow: `coder run develop --repo <path> --issue <n>`
4. Monitor: `coder list` or `coder attach <run-id>`

## Chaining workflows
...
```

---

### 7. Multi-repo Queue

Global issue queue across all registered repos, stored in the daemon DB.

```
coder repos add ~/code/myapp
coder repos add ~/code/ui-lib
coder queue            # shows prioritized issues across all repos
coder queue --dispatch # daemon picks top N issues and starts workflows
```

Queue ordering factors:
- Issue labels (`priority:high`, `bug` > `enhancement`)
- Issue age
- Repo-level weights (configurable in `coder.json`)
- Manual pinning (`coder queue pin <repo> <issue>`)

The daemon can run a configurable number of concurrent workflows (`agents.maxConcurrent`, default `3`), distributing them across repos.

---

## Migration from v1

v2 is a clean break — no backwards compatibility obligation. The things worth carrying forward:

- All machine implementations (develop, research, design) — they work, keep them
- State persistence model (SQLite + JSON checkpoints)
- AgentPool + RetryFallbackWrapper
- ppcommit
- Config schema (extend, don't replace)
- Steering context system

Things that go away:
- MCP stdio transport and all stdio plumbing in `bin/`
- Session-scoped agent lifetime tied to Claude's context window
- Single-repo assumption baked into WorkflowRunner

---

## Phased Delivery

### Phase 1 — Daemon + HTTP API + basic CLI
- Port WorkflowRunner to run inside the daemon process
- Implement REST + SSE API
- CLI: `daemon`, `run`, `list`, `logs`, `cancel`
- Remove stdio MCP transport

### Phase 2 — TUI
- Ink-based dashboard
- Workflow detail pane with live log stream
- Human-in-the-loop prompt answering from TUI

### Phase 3 — Typed interfaces + chaining
- Define Zod schemas for all workflow artifacts
- Artifact validation layer
- `--then` flag for chaining
- `coder artifacts` subcommand

### Phase 4 — Multi-repo queue
- Repo registry
- Global issue queue with priority ordering
- `maxConcurrent` concurrency control
- `coder queue` commands

### Phase 5 — Skill + polish
- `skills/coder/SKILL.md` authored and tested
- `coder skill install` copies skill to Claude Code skill dir
- Documentation pass
- v2.0 tag
