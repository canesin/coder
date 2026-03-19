import assert from "node:assert/strict";
import test from "node:test";

let cacheId = 0;

function mockChildProcess(t, spawnSyncStub) {
  t.mock.module("node:child_process", {
    namedExports: {
      spawnSync: spawnSyncStub,
      spawn: () => {},
      execSync: () => "",
    },
  });
}

// --- fetchGithubIssues ---

test("fetchGithubIssues throws on missing binary (ENOENT)", async (t) => {
  mockChildProcess(t, () => ({
    error: new Error("spawn gh ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  }));
  const { fetchGithubIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGithubIssues("/tmp"), /gh:.*ENOENT/);
});

test("fetchGithubIssues throws on non-zero exit with stderr", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 1,
    stderr: "auth token expired",
    stdout: "",
  }));
  const { fetchGithubIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGithubIssues("/tmp"), /gh issue list failed/);
});

test("fetchGithubIssues throws on invalid JSON output", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: "not json{",
    stderr: "",
  }));
  const { fetchGithubIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGithubIssues("/tmp"), /invalid JSON/);
});

test("fetchGithubIssues throws on non-array JSON output", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: '{"foo":1}',
    stderr: "",
  }));
  const { fetchGithubIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGithubIssues("/tmp"), /non-array JSON/);
});

test("fetchGithubIssues returns [] on empty stdout", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
  }));
  const { fetchGithubIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.deepEqual(fetchGithubIssues("/tmp"), []);
});

test("fetchGithubIssues returns parsed array on valid JSON", async (t) => {
  const payload = [
    {
      number: 1,
      title: "test",
      body: "",
      labels: [],
      url: "u",
      comments: [],
    },
  ];
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  const { fetchGithubIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  const result = fetchGithubIssues("/tmp");
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
  assert.equal(result[0].title, "test");
});

// --- fetchGitlabIssues ---

test("fetchGitlabIssues throws on missing binary (ENOENT)", async (t) => {
  mockChildProcess(t, () => ({
    error: new Error("spawn glab ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  }));
  const { fetchGitlabIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGitlabIssues("/tmp"), /glab:.*ENOENT/);
});

test("fetchGitlabIssues throws on non-zero exit with stderr", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 1,
    stderr: "token revoked",
    stdout: "",
  }));
  const { fetchGitlabIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGitlabIssues("/tmp"), /glab issue list failed/);
});

test("fetchGitlabIssues throws on invalid JSON output", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: "{broken",
    stderr: "",
  }));
  const { fetchGitlabIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.throws(() => fetchGitlabIssues("/tmp"), /invalid JSON/);
});

test("fetchGitlabIssues returns [] on empty first page", async (t) => {
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: "[]",
    stderr: "",
  }));
  const { fetchGitlabIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  assert.deepEqual(fetchGitlabIssues("/tmp"), []);
});

test("fetchGitlabIssues returns mapped data on valid JSON", async (t) => {
  const payload = [
    {
      iid: 7,
      title: "Fix CI",
      description: "Long description here",
      labels: [{ name: "bug" }],
      web_url: "https://gl.example.com/7",
    },
  ];
  mockChildProcess(t, () => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  const { fetchGitlabIssues } = await import(
    `../src/machines/develop/issue-list.machine.js?t=${++cacheId}`
  );
  const result = fetchGitlabIssues("/tmp");
  assert.equal(result.length, 1);
  assert.equal(result[0].iid, 7);
  assert.equal(result[0].title, "Fix CI");
  assert.equal(result[0].description, "Long description here");
  assert.deepEqual(result[0].labels, ["bug"]);
  assert.equal(result[0].web_url, "https://gl.example.com/7");
});
