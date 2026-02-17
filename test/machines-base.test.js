import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineMachine, MachineResultSchema } from "../src/machines/_base.js";
import {
  clearMachines,
  getMachine,
  hasMachine,
  listMachines,
  registerMachine,
} from "../src/machines/_registry.js";

test("defineMachine creates a frozen machine object", () => {
  const machine = defineMachine({
    name: "test.hello",
    description: "A test machine",
    inputSchema: z.object({ greeting: z.string() }),
    async execute(input) {
      return { status: "ok", data: { message: `Hello, ${input.greeting}!` } };
    },
  });

  assert.equal(machine.name, "test.hello");
  assert.equal(machine.description, "A test machine");
  assert.ok(Object.isFrozen(machine));
});

test("defineMachine validates required fields", () => {
  assert.throws(
    () =>
      defineMachine({
        description: "no name",
        inputSchema: z.object({}),
        execute: () => {},
      }),
    /name is required/,
  );
  assert.throws(
    () =>
      defineMachine({
        name: "a",
        inputSchema: z.object({}),
        execute: () => {},
      }),
    /description is required/,
  );
  assert.throws(
    () => defineMachine({ name: "a", description: "b", execute: () => {} }),
    /inputSchema is required/,
  );
  assert.throws(
    () =>
      defineMachine({ name: "a", description: "b", inputSchema: z.object({}) }),
    /execute function is required/,
  );
});

test("machine.run validates input and returns MachineResult", async () => {
  const machine = defineMachine({
    name: "test.echo",
    description: "Echoes input",
    inputSchema: z.object({ value: z.string() }),
    async execute(input) {
      return { status: "ok", data: { echoed: input.value } };
    },
  });

  const result = await machine.run({ value: "hello" }, {});
  assert.equal(result.status, "ok");
  assert.equal(result.data.echoed, "hello");
  assert.ok(result.durationMs >= 0);

  // Validates via MachineResultSchema
  const parsed = MachineResultSchema.parse(result);
  assert.equal(parsed.status, "ok");
});

test("machine.run returns error on invalid input", async () => {
  const machine = defineMachine({
    name: "test.strict",
    description: "Requires number",
    inputSchema: z.object({ count: z.number().int() }),
    async execute(input) {
      return { status: "ok", data: { count: input.count } };
    },
  });

  const result = await machine.run({ count: "not_a_number" }, {});
  assert.equal(result.status, "error");
  assert.ok(result.error.length > 0);
});

test("machine.run catches execute exceptions", async () => {
  const machine = defineMachine({
    name: "test.crash",
    description: "Always throws",
    inputSchema: z.object({}),
    async execute() {
      throw new Error("boom");
    },
  });

  const result = await machine.run({}, {});
  assert.equal(result.status, "error");
  assert.match(result.error, /boom/);
  assert.ok(result.durationMs >= 0);
});

test("registry: register, get, list, has, clear", () => {
  clearMachines();

  const m = defineMachine({
    name: "registry.test",
    description: "For registry test",
    inputSchema: z.object({}),
    async execute() {
      return { status: "ok" };
    },
  });

  assert.equal(hasMachine("registry.test"), false);
  registerMachine(m);
  assert.equal(hasMachine("registry.test"), true);
  assert.equal(getMachine("registry.test"), m);
  assert.equal(listMachines().length, 1);

  // Duplicate registration is idempotent (required for HTTP multi-session)
  registerMachine(m);
  assert.equal(listMachines().length, 1);

  clearMachines();
  assert.equal(listMachines().length, 0);
  assert.equal(hasMachine("registry.test"), false);
});

test("registry: getMachine throws for unknown name", () => {
  clearMachines();
  assert.throws(() => getMachine("nonexistent"), /Unknown machine/);
});
