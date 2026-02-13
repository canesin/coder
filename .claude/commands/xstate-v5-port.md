# XState v4 to v5 Migration + Graph Testing

Port the XState v4 state machine(s) described below to idiomatic XState v5 using `setup().createMachine()`, then add exhaustive tests using `xstate/graph`.

**Target:** $ARGUMENTS

---

## Reference documentation

- Migration guide: https://stately.ai/docs/migration
- `setup()` API and machine creation: https://stately.ai/docs/machines
- Actions (assign, raise, sendTo, enqueueActions): https://stately.ai/docs/actions
- Guards (named, combinators, stateIn): https://stately.ai/docs/guards
- Actors (fromPromise, fromCallback, invoke): https://stately.ai/docs/actors
- Graph utilities (getShortestPaths, getSimplePaths): https://stately.ai/docs/graph
- Persistence (getPersistedSnapshot, createPersistedState): https://stately.ai/docs/persistence
- Testing guide: https://stately.ai/docs/testing

---

## Phase 1 — Audit the existing machine

Read every file indicated above. Before writing any code, produce a short inventory:

1. **States** — list every state node (including nested/parallel).
2. **Events** — list every event type and its payload fields.
3. **Actions** — list every action (inline `assign`, named, `send`, `choose`, `pure`, etc.).
4. **Guards** — list every `cond` / guard.
5. **Services / Invocations** — list every `invoke.src` (promise, callback, observable, machine).
6. **Context shape** — document the full context type.
7. **Standalone helper functions** — list any functions called from within inline actions (e.g., a `applyLoopSync(context, data)` called inside `assign()`). These will be absorbed into named actions.
8. **Known smells** — flag any of these v4 anti-patterns:
   - `...context` spread inside `assign()` — v5 `assign` does partial merge, spread is redundant
   - Duplicated transition blocks across states (same COMPLETE/FAIL/CANCEL handlers copy-pasted in running/paused/cancelling)
   - Inline anonymous actions/guards instead of named ones
   - `send()` where `raise()` or `sendTo()` is appropriate
   - `choose()` / `pure()` — replaced by `enqueueActions()`
   - `machine.withContext()` — replaced by `input`
   - `machine.withConfig()` — replaced by `machine.provide()`
   - `interpret()` — replaced by `createActor()`
   - `(context, event) =>` two-arg signatures — v5 uses `({ context, event }) =>` single destructured object
   - `cond:` property — renamed to `guard:`
   - `internal: false` — renamed to `reenter: true`
   - String-only event sends like `actor.send('EVENT')` — must be `actor.send({ type: 'EVENT' })`
   - `getSnapshot()` used for persistence/rehydration — should be `getPersistedSnapshot()`
   - `actor.subscribe((snapshot) => { saveState(snapshot) })` — use `actor.getPersistedSnapshot()` inside the callback for rehydration-safe persistence
   - `event.data` on invoke done/error — renamed to `event.output` (done) and `event.error` (error)
   - Actions that depend on execution order with `assign()` batched first — v5 runs all actions in document order
   - Direct context mutation inside actions (v5 may freeze context in dev mode)
   - `fromPromise` accessing context directly — must use `input` to pass data
   - `enqueueActions` using bare `assign()` instead of `enqueue.assign()`
   - Overly flat machines that should use hierarchy or parallel states
   - God-context with fields that only matter in certain states

Present the inventory to the user and wait for confirmation before proceeding.

---

## Phase 2 — Rewrite using XState v5 best practices

Apply ALL of the following patterns. This is not a mechanical translation; improve the machine design.

### 2.1 — `setup().createMachine()` structure

Use `setup().createMachine()` to pre-register actions, guards, actors, and delays. This is the **recommended** pattern in v5 for type safety and reusability. Note: `createMachine()` is still a valid import and works without `setup()`, but `setup()` is preferred when you have named actions/guards/actors.

```js
// v4
import { createMachine, assign } from "xstate";
const machine = createMachine({ ... });

// v5 (recommended)
import { assign, setup } from "xstate";
const machine = setup({
  actions: { /* ... */ },
  guards:  { /* ... */ },
  actors:  { /* ... */ },  // fromPromise, fromCallback, child machines
  delays:  { /* ... */ },  // named delays
}).createMachine({
  id: "descriptiveId",
  initial: "idle",
  context: { /* ... */ },
  states: { /* ... */ },
});
```

Ref: https://stately.ai/docs/machines

### 2.2 — Named actions (strongly recommended)

Register actions in `setup({ actions })` and reference by string name in the machine config. Inline `assign()` calls still work in v5, but named actions improve readability, reusability, and testability. Prefer named actions for any non-trivial machine.

**Action naming**: use descriptive verb-prefixed names that describe what the action does to context. Good examples: `initRun`, `recordHeartbeat`, `updateStage`, `markPaused`, `markFailed`, `stampCompletedAt`.

```js
// GOOD — named action, partial merge, only destructures what's needed
setup({
  actions: {
    recordHeartbeat: assign(({ event }) => ({
      lastHeartbeatAt: event.at,
    })),
  },
}).createMachine({
  on: { HEARTBEAT: { actions: "recordHeartbeat" } },
});

// BAD — inline assign with context spread and unnecessary destructuring
on: {
  HEARTBEAT: {
    actions: assign(({ context, event }) => ({
      ...context,
      lastHeartbeatAt: event.at,
    }))
  }
}
```

**Absorb standalone helpers into named actions.** If v4 code has external functions like `applySync(context, data)` called from inline assigns, fold the logic directly into the named action:

```js
// v4 — external helper called from inline assign
function applyLoopSync(context, loopState) {
  if (!loopState || typeof loopState !== "object") return context;
  return { ...context, currentStage: loopState.currentStage || context.currentStage };
}
// ...inside machine: assign(({ context, event }) => applyLoopSync(context, event.loopState))

// v5 — logic absorbed into named action
setup({
  actions: {
    syncLoopState: assign(({ context, event }) => {
      const ls = event.loopState;
      if (!ls || typeof ls !== "object") return {};  // empty object = no-op
      return {
        currentStage: ls.currentStage || context.currentStage || null,
      };
    }),
  },
})
```

Note: returning `{}` from `assign()` is a clean no-op in v5 — it merges nothing.

Ref: https://stately.ai/docs/actions

### 2.3 — Partial-merge `assign()` (no spread)

XState v5 `assign()` does a **shallow merge** into context. Never spread `...context`.

Only destructure `context` when you actually read from it. If the action only uses `event`, destructure `({ event })` only.

```js
// GOOD — partial merge, only destructures event
assign(({ event }) => ({ lastUpdatedAt: event.at }))

// GOOD — reads context because it needs fallback values
assign(({ context, event }) => ({
  currentStage: event.stage || context.currentStage,
}))

// BAD — spreads context (redundant, error-prone)
assign(({ context, event }) => ({ ...context, lastUpdatedAt: event.at }))
```

### 2.4 — Reuse named actions across transitions

A single named action can serve multiple event types. This eliminates the duplicated `assign()` blocks that plague v4 machines:

```js
setup({
  actions: {
    stampCompletedAt: assign(({ event }) => ({
      completedAt: event.at || new Date().toISOString(),
    })),
  },
}).createMachine({
  states: {
    running: {
      on: {
        COMPLETE:  { target: "completed", actions: "stampCompletedAt" },
        CANCELLED: { target: "cancelled", actions: "stampCompletedAt" },  // same action
      },
    },
  },
});
```

### 2.5 — Named guards

Register guards in `setup({ guards })`. Reference by string or `{ type, params }`.

```js
setup({
  guards: {
    isAboveThreshold: ({ context }, params) => context.count > params.min,
  },
}).createMachine({
  on: {
    CHECK: {
      guard: { type: "isAboveThreshold", params: { min: 10 } },
      target: "active",
    },
  },
});
```

Use guard combinators for complex conditions:
```js
import { and, or, not } from "xstate";
guard: and(["isValid", not("isLocked")])
```

Ref: https://stately.ai/docs/guards

### 2.6 — Event signatures

All function signatures use a single destructured object:

```js
// GOOD — v5
assign(({ context, event }) => ({ ... }))
({ context, event }) => context.count > event.min

// BAD — v4 two-arg
assign((context, event) => ({ ... }))
(context, event) => context.count > event.min
```

### 2.7 — Actor/service migration

| v4 | v5 |
|---|---|
| `invoke: { src: (ctx) => fetch(...) }` | `invoke: { src: "fetchData" }` + `setup({ actors: { fetchData: fromPromise(...) } })` |
| `invoke: { src: (ctx) => (cb) => { ... } }` | `fromCallback(({ sendBack, receive, input }) => { ... })` |
| `invoke: { data: ... }` | `invoke: { input: ({ context, event }) => ({ ... }) }` |
| `spawn(machine)` | `assign({ ref: ({ spawn }) => spawn("childMachine") })` or `spawnChild("childMachine")` |

Ref: https://stately.ai/docs/actors

### 2.8 — Replace deprecated action creators

| v4 | v5 |
|---|---|
| `send({ type: "X" })` (to self) | `raise({ type: "X" })` |
| `send({ type: "X" }, { to: "actor" })` | `sendTo("actor", { type: "X" })` |
| `sendParent({ type: "X" })` | `sendTo(({ context }) => context.parentRef, { type: "X" })` — pass parent ref via `input` at spawn time |
| `choose([...])` | `enqueueActions(({ enqueue, check }) => { ... })` |
| `pure((ctx, evt) => [...])` | `enqueueActions(({ enqueue, context, event }) => { ... })` |
| `escalate(err)` | Throw directly or use output |

> **`enqueueActions` caveat**: inside the callback, use `enqueue.assign()` (not bare `assign()`). All enqueued actions must go through the `enqueue` parameter:
> ```js
> enqueueActions(({ enqueue, check }) => {
>   if (check("isReady")) {
>     enqueue.assign({ status: "ready" });  // GOOD
>     enqueue("namedAction");               // GOOD
>   }
> });
> ```

### 2.9 — `cond` to `guard`, `internal` to `reenter`

```js
// v4
{ target: "next", cond: "isReady", internal: false }

// v5
{ target: "next", guard: "isReady", reenter: true }
```

### 2.10 — `interpret` to `createActor`

```js
// v4
import { interpret } from "xstate";
const service = interpret(machine).start();
service.onTransition((state) => { ... });

// v5
import { createActor } from "xstate";
const actor = createActor(machine);
actor.subscribe((snapshot) => { ... });
actor.start();
```

Ref: https://stately.ai/docs/migration

### 2.11 — Use `getPersistedSnapshot()` for persistence

When persisting actor state for later **rehydration** (restoring into a new actor), always use `actor.getPersistedSnapshot()`. It produces a minimal, rehydration-safe snapshot. `actor.getSnapshot()` works fine with `JSON.stringify()` (via `toJSON()`), but its output is not designed for `createActor({ snapshot })` rehydration.

**Subscriber pattern**: prefer `getPersistedSnapshot()` inside subscribers when persisting to disk/DB:

```js
// GOOD — rehydration-safe snapshot for persistence
actor.subscribe(() => {
  saveToDb(actor.getPersistedSnapshot());
});

// OK for logging / status reads (JSON.stringify works via toJSON())
// but NOT designed for rehydration into createActor({ snapshot })
actor.subscribe((snapshot) => {
  console.log(JSON.stringify(snapshot));
});
```

Ref: https://stately.ai/docs/persistence

### 2.12 — Behavioral changes in v5 (critical to know)

These are silent behavioral changes — the code compiles but behaves differently:

- **Action execution order**: In v4, `assign()` actions were batched to run before other actions regardless of document order. In v5, ALL actions execute in document order. If you have `actions: ["logEvent", "updateCount"]` where `updateCount` is an `assign`, `logEvent` now runs first and sees the OLD context. Reorder actions if needed.
- **`always` transitions**: In v4, `always` (eventless) transitions could interrupt mid-action execution. In v5, they only evaluate after all actions for the current event have completed.
- **`fromPromise` does not receive context**: Invoked actors created with `fromPromise` cannot access parent context directly. Pass data via `input`:
  ```js
  // v5 — pass data to invoked promise via input
  invoke: {
    src: "fetchUser",
    input: ({ context }) => ({ userId: context.userId }),
  }
  // in setup:
  actors: {
    fetchUser: fromPromise(({ input }) => fetch(`/users/${input.userId}`)),
  }
  ```
- **Never mutate context directly**: v5 may freeze context objects in development mode. Always use `assign()` to produce new values.
- **Done/error event data**: `event.data` on invoke-done transitions is now `event.output`. `event.data` on invoke-error transitions is now `event.error`.
- **String events removed**: `actor.send("EVENT")` no longer works. Must be `actor.send({ type: "EVENT" })`.

### 2.13 — Design improvements (apply when appropriate)

- **Deduplicate transitions**: If multiple states share identical event handlers (COMPLETE/FAIL/CANCELLED appearing in running, paused, and cancelling), use shared named actions so each transition is a one-liner referencing the same action string.
- **Use hierarchy**: If context fields are only relevant in certain states, model them as nested states instead of top-level flags.
- **Use parallel states**: For independent concurrent concerns (e.g., form validation + autosave).
- **Lean context**: Only store what changes. Derived values should be computed, not stored.
- **Final states with output**: Use `output` on final states to communicate results to parent actors.
- **Input over withContext**: Use `context: ({ input }) => ({ ...defaults, ...input })` for parameterized machines.

---

## Phase 3 — Add exhaustive tests with `xstate/graph`

Import from `xstate/graph` — bundled with xstate v5, no extra dependency needed.

Ref: https://stately.ai/docs/graph

### 3.1 — Structural coverage with `getShortestPaths` + `getSimplePaths`

```js
import { getShortestPaths, getSimplePaths } from "xstate/graph";
import { createActor } from "xstate";
```

**Set up traversal events and serialization** — these are shared across all graph tests:

```js
// Candidate events — one representative payload per event type the machine handles.
// CRITICAL: this MUST be a function returning an array, NOT an object map.
// Passing an object like { START: [...], COMPLETE: [...] } will throw
// "TypeError: events is not iterable".
const traversalEvents = () => [
  { type: "START", runId: "r1", workspace: "/tmp/ws", goal: "goal", at: "2026-01-01T00:00:00.000Z" },
  { type: "HEARTBEAT", at: "2026-01-01T00:01:00.000Z" },
  { type: "COMPLETE", at: "2026-01-01T00:05:00.000Z" },
  { type: "FAIL", error: "test_error", at: "2026-01-01T00:06:00.000Z" },
  // ... one entry per event type
];

// CRITICAL: serialize by state VALUE only to avoid context-permutation explosion.
// Without this, self-loop events like HEARTBEAT/STAGE/SYNC create unique context
// snapshots at every step, and getSimplePaths produces thousands of paths instead
// of the structural handful you actually care about.
const serializeState = (s) => JSON.stringify(s.value);

// Replay a graph path through a fresh actor and return the final snapshot.
// This validates that the graph's theoretical path actually works end-to-end.
function replayPath(machine, graphPath) {
  const actor = createActor(machine);
  actor.start();
  for (const step of graphPath.steps) {
    actor.send(step.event);
  }
  const snapshot = actor.getSnapshot();
  actor.stop();
  return snapshot;
}
```

> **Note:** graph paths include a synthetic `xstate.init` event as the first step.
> This is not a user event — it represents the machine's initialization transition.
> The "idle" state path has 1 step (`xstate.init`), not 0.

### 3.2 — Required test categories

Write tests for ALL of the following:

**a) Reachability** — every state in the machine is reachable:
```js
test("all N states are reachable", () => {
  const paths = getShortestPaths(machine, { events: traversalEvents, serializeState });
  const reachable = new Set(paths.map((p) => p.state.value));
  assert.deepEqual(reachable, new Set(["idle", "running", /* ... all states */]));
});
```

**b) Path count** — exact number of simple paths acts as a regression guard. If someone adds or removes a transition, this count changes and the test catches it:
```js
test("exactly N simple paths exist", () => {
  const paths = getSimplePaths(machine, { events: traversalEvents, serializeState });
  assert.equal(
    paths.length,
    EXPECTED_COUNT,
    `Expected ${EXPECTED_COUNT} paths, got ${paths.length}: ` +
      paths.map((p) => p.steps.map((s) => s.event.type).join("->")).join("; "),
  );
});
```

**c) Exhaustive replay** — every path replays to its expected state. Include the path in the assertion message for debugging:
```js
test("every simple path replays correctly", () => {
  const paths = getSimplePaths(machine, { events: traversalEvents, serializeState });
  for (const p of paths) {
    const snapshot = replayPath(machine, p);
    assert.equal(
      snapshot.value,
      p.state.value,
      `Path [${p.steps.map((s) => s.event.type).join(" -> ")}] ` +
        `expected ${p.state.value} but got ${snapshot.value}`,
    );
  }
});
```

**d) Context invariants on terminal states** — assert domain rules hold for every path reaching each final state. Use `toState` to filter. Always include the path in assertion messages:
```js
test("completedAt is set on every terminal path", () => {
  const paths = getSimplePaths(machine, {
    events: traversalEvents,
    serializeState,
    toState: (s) => ["completed", "failed", "cancelled"].includes(s.value),
  });
  assert.ok(paths.length > 0, "should have terminal paths");
  for (const p of paths) {
    const snapshot = replayPath(machine, p);
    assert.ok(
      snapshot.context.completedAt,
      `completedAt missing for path -> ${snapshot.value}: ` +
        `[${p.steps.map((s) => s.event.type).join(" -> ")}]`,
    );
  }
});

test("error is set on all failed paths, null on completed/cancelled", () => {
  const machine = createMyMachine();
  const paths = getSimplePaths(machine, { events: traversalEvents, serializeState });
  for (const p of paths) {
    const snapshot = replayPath(machine, p);
    if (snapshot.value === "failed") {
      assert.ok(snapshot.context.error, `error missing: [${p.steps.map((s) => s.event.type).join(" -> ")}]`);
    } else if (["completed", "cancelled"].includes(snapshot.value)) {
      assert.equal(snapshot.context.error, null, `error should be null: [${p.steps.map((s) => s.event.type).join(" -> ")}]`);
    }
  }
});
```

**e) Terminal state immutability** — send every possible event to each terminal state and assert neither state value nor context changes. Use a hardcoded list of terminal state values (there is no built-in `isFinal()` helper):

```js
test("terminal states are immutable", () => {
  const terminalStates = ["completed", "failed", "cancelled"];
  const paths = getShortestPaths(machine, { events: traversalEvents, serializeState });
  // Build poison list from ALL event types the machine handles
  const poison = [
    { type: "START", runId: "x", workspace: "/x", goal: "x" },
    { type: "HEARTBEAT", at: "2099-01-01T00:00:00Z" },
    { type: "FAIL", error: "injected" },
    { type: "COMPLETE", at: "2099-01-01T00:00:00Z" },
    // ... every event type
  ];

  for (const p of paths) {
    if (!terminalStates.includes(p.state.value)) continue;
    const actor = createActor(machine);
    actor.start();
    for (const step of p.steps) actor.send(step.event);
    const before = JSON.stringify(actor.getSnapshot().context);
    for (const evt of poison) actor.send(evt);
    const after = actor.getSnapshot();
    assert.equal(after.value, p.state.value, "state should not change");
    assert.equal(
      JSON.stringify(after.context),
      before,
      `context mutated in terminal ${p.state.value}`,
    );
    actor.stop();
  }
});
```

### 3.3 — Keep targeted manual tests for

Graph tests cover structural reachability and invariants but NOT:

- **Specific context field values** — e.g., "SYNC with `null` loopState is a no-op" or "HEARTBEAT updates exactly `lastHeartbeatAt` and nothing else". Write focused manual tests for these.
- **Edge-case payloads** — null, undefined, wrong types, missing fields. Test that the machine handles garbage input gracefully (e.g., `assign()` returning `{}` as no-op).
- **Persistence / disk I/O** — if machine state is saved externally, test save/load round-trips separately.
- **Integration with real actors** — invoke, spawn, parent-child communication.

### 3.4 — Graph traversal options reference

| Option | Purpose |
|---|---|
| `events: () => [...]` | **Must be a function** returning candidate events (or a flat array). NOT an object map. |
| `serializeState: (s) => string` | Dedup key. **Always set this** to `JSON.stringify(s.value)` unless you need context-aware paths. Without it, self-loop events explode the state space. |
| `toState: (s) => bool` | Only return paths reaching matching states. Great for testing invariants on specific terminal states. |
| `stopWhen: (s) => bool` | Stop exploring beyond matching states. |
| `limit: number` | Max states to visit. Set this for machines with cycles to prevent infinite traversal. |
| `fromState: snapshot` | Start traversal from a specific state instead of initial. |

### 3.5 — Common graph testing pitfalls

1. **`TypeError: events is not iterable`** — you passed `events` as an object `{ EVENT: [...] }`. Must be a function `() => [...]` or a flat array `[...]`.
2. **Thousands of paths / huge output** — you forgot `serializeState`. Every context-modifying self-loop (HEARTBEAT, SYNC, STAGE) creates a new "unique" state.
3. **Path count changes unexpectedly** — adding a self-loop event to `traversalEvents` that doesn't change state value still creates a new context permutation. Either add it to `traversalEvents` (if you want it tested) and accept the higher count, or omit context-only events from traversal and test them manually.
4. **`isFinal is not defined`** — there's no built-in helper. Use a hardcoded array: `const terminalStates = ["completed", "failed", "cancelled"]` and filter with `.includes()`.

---

## Phase 4 — Verify

1. Run all tests and confirm they pass.
2. Run the project linter and fix any issues.
3. Confirm no `xstate` v4-only imports remain (`interpret`, `Machine`, `send`, `choose`, `pure`).
4. Confirm `setup().createMachine()` is used when there are named actions/guards/actors.
5. Confirm `assign()` calls never spread `...context`.
6. Confirm actions and guards are registered in `setup()` and referenced by string name (inline is allowed for trivial one-offs but named is preferred).
7. Confirm no standalone helper functions remain that were only used inside inline `assign()` calls — their logic should now live in named actions.
8. Confirm `getPersistedSnapshot()` is used everywhere state is persisted for rehydration, not `getSnapshot()`.
9. Confirm no `(context, event) =>` two-arg signatures remain — must be `({ context, event }) =>`.
10. Confirm no `event.data` usage on invoke completion — should be `event.output` (done) or `event.error` (error).
11. Confirm no direct context mutation — all updates go through `assign()`.
