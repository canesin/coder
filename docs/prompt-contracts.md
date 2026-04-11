# Cross-Prompt Contract Registry

`src/machines/prompt-contracts.js` is the single source of truth for artifact
section headings, producer/consumer file paths, and JSON payload field schemas
shared across develop and research machine prompts.

## Why

Prompt builders in different machines independently define the same section
headings. When a heading is renamed in the producer, consumers silently
reference a stale name, causing the agent to skip sections. The registry
eliminates this by centralizing section names with render helpers that surface
mismatches at test time.

## Access Patterns

Three tiers serve different prompt-assembly needs:

| Pattern | When to use | Example |
|---------|-------------|---------|
| `renderRequiredSections(key)` | Plain numbered list, no inline prose | `plan-review.machine.js` |
| `renderCritiqueSectionList(key, names)` | Prose references; **throws** if name not found | `implementation.machine.js` |
| `CONTRACTS[key].sections` iteration | Interleaved instructional prose between items | `planning.machine.js`, `issue-draft.machine.js` |

### `renderRequiredSections(contractKey)`

Returns a numbered list string:

```
1. Critical Issues (Must Fix)
2. Over-Engineering Concerns
...
```

### `renderCritiqueSectionList(contractKey, sectionNames)`

Returns a comma-joined string of the requested names. Throws an `Error`
(matching `/not found/`) if any name is absent from the registry.

### Direct `CONTRACTS[key].sections` iteration

For prompts that need to insert conditional or multi-line prose after specific
sections (e.g., EARS syntax after "Requirements", Red/Green TDD after "Testing
Strategy"), iterate the sections array and use **name-based checks**:

```js
CONTRACTS["ISSUE.md"].sections.map((s, i) => {
  let line = `${i + 1}. **${s.name}**: ${s.description}`;
  if (s.name === "Requirements") {
    line += ":\n   - Ubiquitous: ...";
  }
  return line;
}).join("\n")
```

## Adding a Section

1. Add the `{ name, description }` entry to the appropriate `CONTRACTS` key in
   `src/machines/prompt-contracts.js`.
2. Update the producer machine to emit the new section heading.
3. Update consumer machines that reference sections (the throw-on-miss helper
   catches stale references at test time).
4. Run `node ./scripts/run-tests.mjs test/prompt-contracts.test.js` to verify.

## Adding an Artifact

1. Add a new key to `CONTRACTS` with `description`, `producedBy`, `consumers`,
   and either `sections` (markdown) or `fields` (JSON).
2. Update the test expectations in `test/prompt-contracts.test.js` (the
   `expectedKeys` array).
3. Run the full suite: `npm test`.

## JSON Payload Contracts

Research machines use `fields` entries (e.g., `{ issues: "array" }`) with
`requirePayloadFields()` from `research/_shared.js`. Changing a field name in
the registry automatically updates the validation call site.
