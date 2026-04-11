# Prompt Contracts

## Why

Machine prompts produce and consume structured artifacts (PLANREVIEW.md, PLAN.md, ISSUE.md, etc.). When section names are hardcoded in multiple files, they drift — a section added to a producer but missing from the consumer silently breaks downstream logic. Hard parsers like `parsePlanVerdict` also key off specific headings and fail silently when names change.

## The Registry

`src/machines/prompt-contracts.js` exports a `CONTRACTS` object keyed by artifact name. Each entry declares:

- `producedBy` — file path of the producing machine
- `consumers` — file paths of consuming machines
- `format` — `"markdown"` or `"json"`
- `sections` — canonical section/field names

Render helpers convert entries into prompt-ready strings:

- `renderRequiredSections(key)` — numbered list for heading-level output
- `renderCritiqueSectionList(key)` — comma-joined actionable names (strips parentheticals, excludes Verdict) for inline use
- `getSections(key)` — raw array for programmatic access

## Adding a Section to an Existing Artifact

1. Add the section name to the `sections` array in the corresponding `CONTRACTS` entry.
2. Run `node --test test/prompt-contracts.test.js` to verify the registry is consistent.
3. The producer and consumer prompts will pick up the change automatically via render helpers.

## Adding a New Artifact

1. Add a new key to `CONTRACTS` with `producedBy`, `consumers`, `format`, and `sections`.
2. Add corresponding tests in `test/prompt-contracts.test.js`.
3. Update producer/consumer machine files to import from the registry.

## Test Enforcement

`test/prompt-contracts.test.js` validates:

- All producer/consumer files exist on disk
- Synthetic artifacts built from registry headings roundtrip through `parsePlanVerdict` and `parseReviewVerdict`
- Render helpers produce output containing all declared sections
