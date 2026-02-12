# Contributing

Thanks for your interest in improving `coder`.

## Development setup

```bash
git clone https://github.com/canesin/coder.git
cd coder
npm install
```

## Validation

Before opening a PR, run:

```bash
npm run lint
npm run format:check
npm test
npm audit --audit-level=high
```

If you need automatic fixes/formatting:

```bash
npm run lint:fix
```

## Pull request checklist

- Keep changes focused and scoped to one concern.
- Add or update tests when behavior changes.
- Update `README.md` if user-facing behavior or config changes.
- Never commit secrets or local machine config (`.env`, `.mcp.json`, `.claude/settings.local.json`).

## Commit hygiene

This project includes a built-in `ppcommit` checker:

```bash
coder ppcommit
```

For PR-scope checks:

```bash
coder ppcommit --base main
```
