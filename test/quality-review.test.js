import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveModelName } from "../src/helpers.js";
import qualityReviewMachine, {
  buildReviewerPrompt,
  buildSpecDeltaPrompt,
  parseReviewVerdict,
} from "../src/machines/develop/quality-review.machine.js";
import { loadState, saveState } from "../src/state/workflow-state.js";

// ---------------------------------------------------------------------------
// parseReviewVerdict
// ---------------------------------------------------------------------------

test("parseReviewVerdict returns nulls for nonexistent file", () => {
  const result = parseReviewVerdict("/nonexistent-" + Date.now());
  assert.equal(result.verdict, null);
  assert.equal(result.findings, null);
});

test("parseReviewVerdict returns null verdict when no verdict line exists", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(
    filePath,
    "# Review Findings\n\n## Finding 1\nSome issue here\n",
  );
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, null);
  assert.ok(result.findings.includes("Finding 1"));
});

test("parseReviewVerdict extracts APPROVED verdict", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(
    filePath,
    "# Review Findings — Round 1\n\n## Finding 1\nMinor issue\n\n## VERDICT: APPROVED\n",
  );
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "APPROVED");
  assert.ok(result.findings.includes("Finding 1"));
});

test("parseReviewVerdict extracts REVISE verdict", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(
    filePath,
    "# Review Findings — Round 1\n\n## Finding 1\nCritical bug\n\n## VERDICT: REVISE\n",
  );
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "REVISE");
});

test("parseReviewVerdict takes the LAST verdict (ignores earlier prompt examples)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  const content = [
    "# Review Findings — Round 1",
    "",
    "Example format:",
    "## VERDICT: APPROVED",
    "",
    "## Finding 1",
    "Critical issue found",
    "",
    "## VERDICT: REVISE",
    "",
  ].join("\n");
  writeFileSync(filePath, content);
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "REVISE");
});

test("parseReviewVerdict ignores verdict inside code fences", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  // The regex uses ^...$ with multiline, so a verdict inside a code block
  // that starts at column 0 would still match. The mitigation is "take last".
  // This test verifies the last-match behavior when the real verdict follows.
  const content = [
    "# Review Findings",
    "",
    "```markdown",
    "## VERDICT: REVISE",
    "```",
    "",
    "## VERDICT: APPROVED",
    "",
  ].join("\n");
  writeFileSync(filePath, content);
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "APPROVED");
});

test("parseReviewVerdict handles trailing whitespace on verdict line", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "coder-rv-"));
  const filePath = path.join(tmp, "REVIEW_FINDINGS.md");
  writeFileSync(filePath, "## VERDICT: APPROVED   \n");
  const result = parseReviewVerdict(filePath);
  assert.equal(result.verdict, "APPROVED");
});

// ---------------------------------------------------------------------------
// buildSpecDeltaPrompt
// ---------------------------------------------------------------------------

test("buildSpecDeltaPrompt includes both file paths", () => {
  const result = buildSpecDeltaPrompt("/path/to/ISSUE.md", "/path/to/PLAN.md");
  assert.ok(result.includes("/path/to/ISSUE.md"));
  assert.ok(result.includes("/path/to/PLAN.md"));
});

test("buildSpecDeltaPrompt requests Spec Delta Summary output", () => {
  const result = buildSpecDeltaPrompt("/a/ISSUE.md", "/a/PLAN.md");
  assert.ok(result.includes("Spec Delta Summary"));
  assert.ok(result.includes("Additions"));
  assert.ok(result.includes("Refinements"));
  assert.ok(result.includes("Omissions"));
});

// ---------------------------------------------------------------------------
// buildReviewerPrompt
// ---------------------------------------------------------------------------

test("buildReviewerPrompt without specDeltaSummary omits Plan Adherence", () => {
  const paths = {
    issue: "/a/ISSUE.md",
    plan: "/a/PLAN.md",
    reviewFindings: "/a/REVIEW_FINDINGS.md",
  };
  const result = buildReviewerPrompt(paths, "ppcommit passed.", 1, null, "");
  assert.ok(!result.includes("Plan Adherence"));
});

test("buildReviewerPrompt with specDeltaSummary includes Plan Adherence", () => {
  const paths = {
    issue: "/a/ISSUE.md",
    plan: "/a/PLAN.md",
    reviewFindings: "/a/REVIEW_FINDINGS.md",
  };
  const delta =
    "### Additions\n- New constraint X\n### Refinements\n- Changed Y";
  const result = buildReviewerPrompt(paths, "ppcommit passed.", 1, null, delta);
  assert.ok(result.includes("Plan Adherence"));
});

test("buildReviewerPrompt with specDeltaSummary injects delta text", () => {
  const paths = {
    issue: "/a/ISSUE.md",
    plan: "/a/PLAN.md",
    reviewFindings: "/a/REVIEW_FINDINGS.md",
  };
  const delta = "### Additions\n- New constraint X";
  const result = buildReviewerPrompt(paths, "ppcommit passed.", 1, null, delta);
  assert.ok(result.includes(delta));
});

test("buildReviewerPrompt with specDeltaSummary references paths.plan in Scope Conformance", () => {
  const paths = {
    issue: "/a/ISSUE.md",
    plan: "/a/PLAN.md",
    reviewFindings: "/a/REVIEW_FINDINGS.md",
  };
  const delta = "### Additions\n- New constraint X";
  const result = buildReviewerPrompt(paths, "ppcommit passed.", 1, null, delta);
  assert.ok(result.includes("/a/PLAN.md"));
});

// ---------------------------------------------------------------------------
// quality_review machine: spec delta integration
// ---------------------------------------------------------------------------

test("quality_review execute: generates spec delta, persists to state, and passes it to reviewer", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "coder-qr-"));
  const artifactsDir = path.join(ws, ".coder", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  spawnSync("git", ["init", "-b", "main"], { cwd: ws });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: ws });
  spawnSync("git", ["config", "user.name", "T"], { cwd: ws });
  writeFileSync(path.join(ws, ".gitignore"), ".coder/\n");
  spawnSync("git", ["add", ".gitignore"], { cwd: ws });
  spawnSync("git", ["commit", "-m", "init"], { cwd: ws });

  writeFileSync(path.join(artifactsDir, "ISSUE.md"), "Issue content");
  writeFileSync(path.join(artifactsDir, "PLAN.md"), "Plan content");

  await saveState(ws, {
    selected: null,
    selectedProject: null,
    linearProjects: null,
    repoPath: ".",
    baseBranch: "main",
    branch: "main",
    questions: null,
    answers: null,
    steps: { implemented: true },
    claudeSessionId: null,
    reviewerSessionId: null,
    lastError: null,
    reviewFingerprint: null,
    reviewedAt: null,
    prUrl: null,
    prBranch: null,
    prBase: null,
    scratchpadPath: null,
    lastWipPushAt: null,
  });

  const reviewFindingsPath = path.join(artifactsDir, "REVIEW_FINDINGS.md");
  let capturedDeltaPrompt = null;
  let capturedReviewPrompt = null;

  const mockReviewerAgent = {
    execute: async (prompt) => {
      // First call is always spec delta; subsequent calls are review rounds.
      if (!capturedDeltaPrompt) {
        capturedDeltaPrompt = prompt;
        return {
          exitCode: 0,
          stdout:
            "## Spec Delta Summary\n### Additions\n- item A\n### Omissions\n- item B\n",
        };
      }
      capturedReviewPrompt = prompt;
      writeFileSync(
        reviewFindingsPath,
        "# Review Findings — Round 1\n\n## VERDICT: APPROVED\n",
      );
      return { exitCode: 0, stdout: "" };
    },
  };
  const mockAgent = { execute: async () => ({ exitCode: 0, stdout: "" }) };

  const ctx = {
    workspaceDir: ws,
    artifactsDir,
    config: {
      ppcommit: {},
      models: {
        gemini: {
          model: "gemini-test",
          apiEndpoint: "http://localhost",
          apiKeyEnv: "GEMINI_API_KEY",
        },
      },
      workflow: {
        timeouts: {
          reviewRound: 60000,
          programmerFix: 60000,
          committerEscalation: 60000,
          finalGate: 60000,
        },
        wip: {},
      },
      test: { command: "", allowNoTests: true },
    },
    agentPool: {
      getAgent: (role) => {
        const agent = role === "reviewer" ? mockReviewerAgent : mockAgent;
        return { agentName: `mock-${role}`, agent };
      },
    },
    log: () => {},
    cancelToken: { cancelled: false, paused: false },
    secrets: {},
    scratchpadDir: path.join(ws, ".coder", "scratchpad"),
  };

  const result = await qualityReviewMachine.run({ allowNoTests: true }, ctx);
  assert.equal(result.status, "ok", result.error);

  const finalState = await loadState(ws);
  assert.ok(
    finalState.specDeltaSummary,
    "specDeltaSummary should be persisted to state",
  );
  assert.ok(
    finalState.specDeltaSummary.includes("Spec Delta Summary"),
    "persisted delta should contain the summary",
  );

  assert.ok(capturedDeltaPrompt, "delta prompt should have been captured");
  assert.ok(
    capturedDeltaPrompt.includes(path.join(artifactsDir, "ISSUE.md")),
    "delta prompt should reference ISSUE.md",
  );
  assert.ok(
    capturedDeltaPrompt.includes(path.join(artifactsDir, "PLAN.md")),
    "delta prompt should reference PLAN.md",
  );

  assert.ok(capturedReviewPrompt, "reviewer should have been called");
  assert.ok(
    capturedReviewPrompt.includes("Plan Adherence"),
    "reviewer prompt should include Plan Adherence section",
  );
  assert.ok(
    capturedReviewPrompt.includes("Spec Delta"),
    "reviewer prompt should include spec delta context",
  );
});

// ---------------------------------------------------------------------------
// resolveModelName
// ---------------------------------------------------------------------------

test("resolveModelName returns string as-is", () => {
  assert.equal(resolveModelName("gemini-2.5-pro"), "gemini-2.5-pro");
});

test("resolveModelName extracts .model from object", () => {
  assert.equal(
    resolveModelName({ model: "gemini-2.5-pro", apiEndpoint: "http://..." }),
    "gemini-2.5-pro",
  );
});

test("resolveModelName returns null/undefined passthrough", () => {
  assert.equal(resolveModelName(null), null);
  assert.equal(resolveModelName(undefined), undefined);
});

test("resolveModelName returns undefined for empty object", () => {
  assert.equal(resolveModelName({}), undefined);
});
