import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchGithubIssues,
  fetchGitlabIssues,
} from "../src/machines/develop/issue-list.machine.js";

// Async stub helper — wraps a sync return value in a resolved promise
const asyncStub =
  (fn) =>
  (...args) =>
    Promise.resolve(fn(...args));

// --- fetchGithubIssues ---

test("fetchGithubIssues throws on missing binary (ENOENT)", async () => {
  const stub = asyncStub(() => ({
    error: new Error("spawn gh ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  }));
  await assert.rejects(
    () => fetchGithubIssues("/tmp", { _spawn: stub }),
    /gh:.*ENOENT/,
  );
});

test("fetchGithubIssues throws on non-zero exit with stderr", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 1,
    stderr: "auth token expired",
    stdout: "",
  }));
  await assert.rejects(
    () => fetchGithubIssues("/tmp", { _spawn: stub }),
    (err) => {
      assert.match(err.message, /gh issue list failed/);
      assert.match(err.message, /exit 1/);
      assert.match(err.message, /auth token expired/);
      return true;
    },
  );
});

test("fetchGithubIssues throws on invalid JSON output", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: "not json{",
    stderr: "",
  }));
  await assert.rejects(
    () => fetchGithubIssues("/tmp", { _spawn: stub }),
    /invalid JSON/,
  );
});

test("fetchGithubIssues throws on non-array JSON output", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: '{"foo":1}',
    stderr: "",
  }));
  await assert.rejects(
    () => fetchGithubIssues("/tmp", { _spawn: stub }),
    /non-array JSON/,
  );
});

test("fetchGithubIssues returns [] on empty stdout", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
  }));
  assert.deepEqual(await fetchGithubIssues("/tmp", { _spawn: stub }), []);
});

test("fetchGithubIssues returns [] on empty JSON array", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: "[]",
    stderr: "",
  }));
  assert.deepEqual(await fetchGithubIssues("/tmp", { _spawn: stub }), []);
});

test("fetchGithubIssues returns parsed array on valid JSON", async () => {
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
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  const result = await fetchGithubIssues("/tmp", { _spawn: stub });
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 1);
  assert.equal(result[0].title, "test");
});

// --- fetchGitlabIssues ---

test("fetchGitlabIssues throws on missing binary (ENOENT)", async () => {
  const stub = asyncStub(() => ({
    error: new Error("spawn glab ENOENT"),
    status: null,
    stdout: "",
    stderr: "",
  }));
  await assert.rejects(
    () => fetchGitlabIssues("/tmp", { _spawn: stub }),
    /glab:.*ENOENT/,
  );
});

test("fetchGitlabIssues throws on non-zero exit with stderr", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 1,
    stderr: "token revoked",
    stdout: "",
  }));
  await assert.rejects(
    () => fetchGitlabIssues("/tmp", { _spawn: stub }),
    (err) => {
      assert.match(err.message, /glab issue list failed/);
      assert.match(err.message, /exit 1/);
      assert.match(err.message, /token revoked/);
      return true;
    },
  );
});

test("fetchGitlabIssues throws on invalid JSON output", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: "{broken",
    stderr: "",
  }));
  await assert.rejects(
    () => fetchGitlabIssues("/tmp", { _spawn: stub }),
    /invalid JSON/,
  );
});

test("fetchGitlabIssues throws on non-array JSON output", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: '{"foo":1}',
    stderr: "",
  }));
  await assert.rejects(
    () => fetchGitlabIssues("/tmp", { _spawn: stub }),
    /non-array JSON/,
  );
});

test("fetchGitlabIssues returns [] on empty stdout (first page)", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
  }));
  assert.deepEqual(await fetchGitlabIssues("/tmp", { _spawn: stub }), []);
});

test("fetchGitlabIssues returns [] on empty JSON array", async () => {
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: "[]",
    stderr: "",
  }));
  assert.deepEqual(await fetchGitlabIssues("/tmp", { _spawn: stub }), []);
});

test("fetchGitlabIssues returns mapped data on valid JSON", async () => {
  const payload = [
    {
      iid: 7,
      title: "Fix CI",
      description: "Long description here",
      labels: [{ name: "bug" }],
      web_url: "https://gl.example.com/7",
    },
  ];
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  const result = await fetchGitlabIssues("/tmp", { _spawn: stub });
  assert.equal(result.length, 1);
  assert.equal(result[0].iid, 7);
  assert.equal(result[0].title, "Fix CI");
  assert.equal(result[0].description, "Long description here");
  assert.deepEqual(result[0].labels, ["bug"]);
  assert.equal(result[0].web_url, "https://gl.example.com/7");
});

test("fetchGitlabIssues handles string labels alongside object labels", async () => {
  const payload = [
    {
      iid: 10,
      title: "Mixed labels",
      description: "",
      labels: ["plain-string", { name: "object-label" }, 42],
      web_url: "https://gl.example.com/10",
    },
  ];
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  const result = await fetchGitlabIssues("/tmp", { _spawn: stub });
  assert.deepEqual(result[0].labels, ["plain-string", "object-label", "42"]);
});

test("fetchGitlabIssues truncates description to 500 chars", async () => {
  const longDesc = "x".repeat(600);
  const payload = [
    {
      iid: 11,
      title: "Long desc",
      description: longDesc,
      labels: [],
      web_url: "https://gl.example.com/11",
    },
  ];
  const stub = asyncStub(() => ({
    error: null,
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  const result = await fetchGitlabIssues("/tmp", { _spawn: stub });
  assert.equal(result[0].description.length, 500);
});

test("fetchGitlabIssues paginates across multiple pages", async () => {
  let callCount = 0;
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    iid: i + 1,
    title: `Issue ${i + 1}`,
    description: "",
    labels: [],
    web_url: `https://gl.example.com/${i + 1}`,
  }));
  const page2 = [
    {
      iid: 101,
      title: "Issue 101",
      description: "",
      labels: [],
      web_url: "https://gl.example.com/101",
    },
  ];

  const stub = asyncStub(() => {
    callCount++;
    return {
      error: null,
      status: 0,
      stdout: JSON.stringify(callCount === 1 ? page1 : page2),
      stderr: "",
    };
  });
  const result = await fetchGitlabIssues("/tmp", { _spawn: stub });
  assert.equal(result.length, 101);
  assert.equal(result[0].iid, 1);
  assert.equal(result[100].iid, 101);
  assert.equal(callCount, 2);
});
