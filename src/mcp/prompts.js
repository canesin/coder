import { z } from "zod";

export function registerPrompts(server) {
  server.prompt(
    "coder_workflow",
    "Multi-agent coding workflow — guides you through the full pipeline from issue selection to PR creation",
    {
      projectFilter: z
        .string()
        .optional()
        .describe("Optional project name to filter issues"),
    },
    ({ projectFilter }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are orchestrating a multi-agent coding workflow using the coder MCP tools.
The coder system exposes three composable workflows, each built from small, independently-callable machines.

## Available Workflows

### 1. Develop Workflow
Consumes GitHub/Linear issues, implements code, and creates PRs.

**Individual machine tools** (call directly for fine-grained control):
- \`coder_develop_issue_list\` — List assigned issues, rate difficulty
- \`coder_develop_issue_draft\` — Draft ISSUE.md, create branch
- \`coder_develop_planning\` — Create PLAN.md
- \`coder_develop_plan_review\` — Critique → PLANREVIEW.md
- \`coder_develop_implementation\` — Implement the feature
- \`coder_develop_quality_review\` — Code review + ppcommit + tests
- \`coder_develop_pr_creation\` — Create and push PR

**Or use the workflow tool** for orchestrated execution:
\`coder_workflow { action: "start", workflow: "develop" }\`

### 2. Research Workflow
From ideas + UI specs, produces GitHub issues organized as Epics/User Stories.

**Machine tools:**
- \`coder_research_context_gather\` — Collect UI specs, links, prior research
- \`coder_research_deep_research\` — Web search, article analysis, repo mining
- \`coder_research_poc_validation\` — Build PoC, benchmark, validate
- \`coder_research_issue_synthesis\` — Draft/critique issues with iterative refinement
- \`coder_research_spec_publish\` — Render markdown issues + manifest

**Or use the workflow tool:**
\`coder_workflow { action: "start", workflow: "research", pointers: "..." }\`

### 3. Design Workflow
From intents/descriptions, generates UI designs via Google Stitch.

**Machine tools:**
- \`coder_design_intent_capture\` — Parse intent, accept screenshots/wireframes
- \`coder_design_ui_generation\` — Generate screens via Stitch
- \`coder_design_ui_refinement\` — Iterate designs with feedback
- \`coder_design_spec_export\` — Save to /spec/UI/*.png + *.md

**Or use the workflow tool:**
\`coder_workflow { action: "start", workflow: "design", designIntent: "..." }\`

## Workflow Tool (\`coder_workflow\`)

Unified control plane for all three workflows:
- \`action: "start"\` — Launch a workflow run (returns runId)
- \`action: "status"\` — Check progress, current stage, heartbeat
- \`action: "events"\` — Read structured events with cursor pagination
- \`action: "cancel"\` — Cooperative cancellation (requires runId)
- \`action: "pause" / "resume"\` — Control execution at stage boundaries

## Quick Start: Develop Workflow${projectFilter ? ` (filtered to "${projectFilter}")` : ""}

1. Call \`coder_develop_issue_list\`${projectFilter ? ` with projectFilter: "${projectFilter}"` : ""} to list issues
2. Present results to user, ask which issue to work on
3. Call \`coder_develop_issue_draft\` with the selected issue
4. Call \`coder_develop_planning\` to create the plan
5. Call \`coder_develop_plan_review\` to critique the plan
6. Call \`coder_develop_implementation\` to implement
7. Call \`coder_develop_quality_review\` to review and test
8. Call \`coder_develop_pr_creation\` to create the PR

## Status

Call \`coder_status\` at any point to check which steps are complete.
You can resume a partially-completed workflow — check status first.

## Batch Processing

For autonomous multi-issue processing:
\`coder_workflow { action: "start", workflow: "develop", goal: "resolve all assigned issues" }\`
Monitor with \`coder_workflow { action: "status" }\``,
          },
        },
      ],
    }),
  );
}
