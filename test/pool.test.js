import assert from "node:assert/strict";
import test from "node:test";
import { AgentPool } from "../src/agents/pool.js";

function makePool(workspaceDir = "/workspace") {
  return new AgentPool({ config: { verbose: false }, workspaceDir });
}

function mockAgent() {
  return {
    killed: false,
    kill: async function () {
      this.killed = true;
    },
  };
}

test("setRepoRoot kills stale cli agent on normal path", async () => {
  const pool = makePool();
  const agent = mockAgent();
  pool._agents.set("cli:gemini:/home/user/project", agent);

  await pool.setRepoRoot("/home/user/other");

  assert.equal(pool._agents.size, 0);
  assert.equal(agent.killed, true);
});

test("setRepoRoot kills cli agent when cwd contains colons", async () => {
  const pool = makePool();
  const agent = mockAgent();
  // Key: cli:gemini:C:\Users\User\MyProject — split(":") gives parts[2]="C", not the full cwd
  pool._agents.set("cli:gemini:C:\\Users\\User\\MyProject", agent);

  await pool.setRepoRoot("C:\\Users\\User\\Other");

  assert.equal(pool._agents.size, 0);
  assert.equal(agent.killed, true);
});

test("setRepoRoot preserves cli agent when cwd with colons matches new repoRoot", async () => {
  const pool = makePool();
  const agent = mockAgent();
  pool._agents.set("cli:gemini:C:\\Users\\User\\MyProject", agent);

  await pool.setRepoRoot("C:\\Users\\User\\MyProject");

  assert.equal(pool._agents.size, 1);
  assert.equal(agent.killed, false);
});

test("setRepoRoot preserves workspace-scoped cli agent", async () => {
  const pool = makePool("/workspace");
  const agent = mockAgent();
  pool._agents.set("cli:gemini:/workspace", agent);

  await pool.setRepoRoot("/other/repo");

  assert.equal(pool._agents.size, 1);
  assert.equal(agent.killed, false);
});

test("setRepoRoot does not remove non-cli agent keys", async () => {
  const pool = makePool();
  const apiAgent = mockAgent();
  const mcpAgent = mockAgent();
  pool._agents.set("api:gemini:planner", apiAgent);
  pool._agents.set("mcp:server:http://localhost", mcpAgent);

  await pool.setRepoRoot("/some/repo");

  assert.equal(pool._agents.size, 2);
  assert.equal(apiAgent.killed, false);
  assert.equal(mcpAgent.killed, false);
});
