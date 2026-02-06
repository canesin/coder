import { z } from "zod";

export function registerPrompts(server) {
  server.prompt(
    "coder_workflow",
    "Multi-agent coding workflow — guides you through the full pipeline from issue selection to finalized implementation",
    { projectFilter: z.string().optional().describe("Optional project name to filter issues") },
    ({ projectFilter }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are orchestrating a multi-agent coding workflow using the coder MCP tools.
Follow this sequence strictly — each step depends on the previous one.

## Workflow Sequence

### Step 1: List and Select Issue
Call \`coder_list_issues\`${projectFilter ? ` with projectFilter: "${projectFilter}"` : ""} to fetch assigned issues rated by difficulty.
Present the results to the user as a numbered list with difficulty ratings.
The response includes a \`recommended_index\` — highlight that issue.
Ask the user which issue to work on.

### Step 2: Draft Issue Specification
Once the user selects an issue, gather any clarifications from conversation
(requirements, constraints, existing code they mention). Then call
\`coder_draft_issue\` with the selected issue details and clarifications.
Show the user the ISSUE.md summary and ask if they want to proceed.

### Step 3: Create Plan + Review
Call \`coder_create_plan\`. This has Claude write PLAN.md, then runs built-in
plan review (Gemini) to critique it. Show the user key points and any reviewer concerns.
Ask if they want to start implementation.

### Step 4: Implement
Call \`coder_implement\`. This is long-running — Claude implements the feature
based on PLAN.md and PLANREVIEW.md. Report the changes made when complete.

### Step 5: Review and Test
Call \`coder_review_and_test\`. Codex reviews the changes, ppcommit checks
commit hygiene, and tests are run. Report results.

### Step 6: Finalize
Call \`coder_finalize\`. Claude runs final tests and updates ISSUE.md with
completion status. Report the final branch name and status.

### Step 7: Create PR (Optional)
Call \`coder_create_pr\` to create a pull request from the feature branch.
You can specify type (feat/bug/refactor), a semantic branch name, custom title,
and description. If not provided, defaults are auto-generated from the issue.
Report the PR URL when complete.

## Important Notes
- Call \`coder_status\` at any point to check which steps are complete.
- You can resume a partially-completed workflow — check status first.
- Each tool validates its preconditions and will error if called out of order.
- For code exploration (reading files, searching code), use your own built-in
  tools — the coder tools are only for workflow orchestration.

## Autonomous Mode (\`coder_auto\`)

For batch processing multiple issues without human intervention, use \`coder_auto\`.
Pass a \`goal\` describing what to work on — the tool uses Gemini to filter relevant
issues, analyze inter-dependencies, and produce a topological execution order
(dependencies first, then easy-to-hard among independents).

Each issue gets a fresh agent context (no context pollution between issues).
If an issue fails, its dependents are automatically skipped.

### When to use
- Multiple issues to batch-process (e.g. "work on all monitoring-related issues")
- Unattended runs — the loop is fully autonomous with test-driven verification
- Well-specified issues where ISSUE.md + tests can close the feedback loop

### When NOT to use
- Issues needing human decisions or visual review
- Issues with no testable verification criteria

### Monitoring progress
- Read \`coder://loop-state\` resource for queue status and per-issue results
- Check \`.coder/logs/auto.jsonl\` for detailed event log
- Call \`coder_status\` for current per-issue workflow state

### Reset safety
- \`coder_auto\` defaults to safe reset behavior (no destructive cleanup)
- Pass \`destructiveReset: true\` only when you want stale/untracked repo
  changes discarded between issues

### Stacked dependencies
- If issue B depends on issue A, auto-mode stacks B on top of A's branch
- B's PR is opened with A's branch as the PR base
- If multiple dependency branches exist, auto-mode picks the first completed
  dependency branch as base and logs the selection

### Resume behavior
If the process crashes mid-loop, calling \`coder_auto\` again with the same
workspace resumes from the last incomplete issue (checkpointed after each issue).`,
        },
      }],
    }),
  );
}
