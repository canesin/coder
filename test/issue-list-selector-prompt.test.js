import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveIssueListHangTimeoutMs,
  slimGithubIssuesForPrompt,
  slimGitlabIssuesForPrompt,
} from "../src/machines/develop/issue-list.machine.js";

function ctx(hangMs) {
  return {
    config: {
      workflow: {
        timeouts: { issueSelectionHangMs: hangMs },
      },
    },
  };
}

test("resolveIssueListHangTimeoutMs: 0 means disabled", () => {
  assert.equal(resolveIssueListHangTimeoutMs(ctx(0)), 0);
});

test("resolveIssueListHangTimeoutMs: positive value passes through", () => {
  assert.equal(resolveIssueListHangTimeoutMs(ctx(120_000)), 120_000);
});

test("slimGithubIssuesForPrompt: caps count and drops comments", () => {
  const raw = [
    {
      number: 1,
      title: "A",
      body: "x".repeat(500),
      labels: [{ name: "bug" }],
      url: "https://g/1",
      comments: [{ body: "noise" }],
    },
    { number: 2, title: "B", body: "y", labels: [], url: "https://g/2" },
  ];
  const slim = slimGithubIssuesForPrompt(raw, 1);
  assert.equal(slim.length, 1);
  assert.equal(slim[0].number, 1);
  assert.ok(!("comments" in slim[0]));
  assert.equal(slim[0].body.length, 400);
  assert.deepEqual(slim[0].labels, ["bug"]);
});

test("slimGithubIssuesForPrompt: label with empty-string name uses empty string not toString", () => {
  const raw = [
    {
      number: 1,
      title: "A",
      body: "b",
      labels: [{ name: "" }, { name: "bug" }, "plain"],
      url: "https://g/1",
    },
  ];
  const slim = slimGithubIssuesForPrompt(raw, 10);
  assert.deepEqual(slim[0].labels, ["", "bug", "plain"]);
});

test("slimGitlabIssuesForPrompt: caps count and truncates description", () => {
  const raw = [
    {
      iid: 1,
      title: "A",
      description: "z".repeat(500),
      labels: [],
      web_url: "u",
    },
    { iid: 2, title: "B", description: "", labels: [], web_url: "v" },
  ];
  const slim = slimGitlabIssuesForPrompt(raw, 1);
  assert.equal(slim.length, 1);
  assert.equal(slim[0].iid, 1);
  assert.equal(slim[0].description.length, 400);
});
