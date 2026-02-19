import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import issueListMachine from "../src/machines/develop/issue-list.machine.js";

function makeTmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "coder-issue-list-"));
}

test("issue-list local mode skips Status: done and honors markdown Depends-On override", async () => {
  const ws = makeTmpDir();
  const issuesDir = path.join(ws, "issues");
  mkdirSync(issuesDir, { recursive: true });

  writeFileSync(
    path.join(issuesDir, "manifest.json"),
    JSON.stringify({
      issues: [
        {
          id: "MODEX-001",
          file: "issues/001-first.md",
          title: "First",
          dependsOn: ["BASE-001"],
        },
        {
          id: "MODEX-002",
          file: "issues/002-second.md",
          title: "Second",
          dependsOn: ["MODEX-001"],
        },
      ],
    }),
    "utf8",
  );

  writeFileSync(
    path.join(issuesDir, "001-first.md"),
    "# MODEX-001 - First\n\nStatus: done\nDepends-On: BASE-001\n",
    "utf8",
  );
  writeFileSync(
    path.join(issuesDir, "002-second.md"),
    "# MODEX-002 - Second\n\nDepends-On: MODEX-010 MODEX-011\n",
    "utf8",
  );

  const events = [];
  const res = await issueListMachine.run(
    { localIssuesDir: "issues" },
    {
      workspaceDir: ws,
      log: (e) => events.push(e),
      secrets: {},
      agentPool: {
        getAgent() {
          throw new Error("should not call remote issue listing in local mode");
        },
      },
    },
  );

  assert.equal(res.status, "ok");
  assert.equal(res.data.source, "local");
  assert.equal(res.data.issues.length, 1);
  assert.equal(res.data.issues[0].id, "MODEX-002");
  assert.deepEqual(res.data.issues[0].depends_on, ["MODEX-010", "MODEX-011"]);

  const localEvent = events.find((e) => e.event === "step1_local_issues");
  assert.equal(localEvent.count, 1);
  assert.equal(localEvent.skippedDone, 1);

  rmSync(ws, { recursive: true, force: true });
});

test("issue-list fallback event reports explicit local manifest reason", async () => {
  const ws = makeTmpDir();
  const events = [];

  const res = await issueListMachine.run(
    { localIssuesDir: "missing-issues" },
    {
      workspaceDir: ws,
      log: (e) => events.push(e),
      secrets: {},
      agentPool: {
        getAgent() {
          return {
            agentName: "mock",
            agent: {
              async executeWithRetry() {
                return {
                  exitCode: 0,
                  stdout: JSON.stringify({
                    issues: [],
                    recommended_index: 0,
                  }),
                };
              },
            },
          };
        },
      },
    },
  );

  assert.equal(res.status, "ok");
  assert.equal(res.data.source, "remote");

  const fallback = events.find(
    (e) => e.event === "step1_local_issues_fallback",
  );
  assert.ok(fallback, "expected fallback event");
  assert.match(fallback.reason, /manifest not found/i);

  rmSync(ws, { recursive: true, force: true });
});
