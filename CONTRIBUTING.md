# Contributing

## Branch model

| Branch | Purpose |
|--------|---------|
| `main` | Stable releases — PRs from `dev` only |
| `dev` | Integration branch — all contributions target here |

**Workflow:**

1. Fork or create a feature branch from `dev`
2. Open a PR targeting `dev`
3. Once merged, maintainers layer follow-up fixes if needed
4. Periodically, `dev` is PR'd into `main` as a release

Both `main` and `dev` are protected — no direct pushes, PRs required.

## Setup

```bash
git clone https://github.com/canesin/coder.git
cd coder
npm install
```

## Validation

```bash
npm run lint          # biome check
npm run format:check  # biome format
npm test              # node --test
npm audit --audit-level=high
```

Auto-fix formatting:

```bash
npm run lint:fix
```

## Commit hygiene

This project uses `ppcommit` (tree-sitter AST-based) to enforce commit quality:

```bash
coder ppcommit              # check all files
coder ppcommit --base dev   # check branch diff only
```

## Pull request checklist

- Target the `dev` branch (not `main`)
- Keep changes focused and scoped to one concern
- Add or update tests when behavior changes
- Update README.md if user-facing behavior or config changes
- Never commit secrets or local config (`.env`, `.mcp.json`, `.claude/settings.local.json`)
- Never commit local workflow artifacts (`ISSUE.md`, `PLAN.md`, `PLANREVIEW.md`, `REVIEW.md`)
