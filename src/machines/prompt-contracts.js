/**
 * Cross-prompt contract registry.
 *
 * Single source of truth for artifact section headings, producer/consumer
 * file paths, and JSON payload field schemas used across develop and research
 * machine prompts.
 */

export const CONTRACTS = {
  "PLANREVIEW.md": {
    description: "Plan review critique with verdict",
    producedBy: "src/machines/develop/plan-review.machine.js",
    consumers: [
      {
        file: "src/helpers.js",
        usage: "Gemini plan-review prompt sections",
      },
      {
        file: "src/machines/develop/implementation.machine.js",
        usage: "Step 1 critique sections",
      },
      {
        file: "src/machines/develop/quality-review.machine.js",
        usage: "spec delta + review",
      },
    ],
    sections: [
      {
        name: "Critical Issues (Must Fix)",
        description: "Blocking problems that must be resolved",
      },
      {
        name: "Over-Engineering Concerns",
        description: "Unnecessary complexity or abstraction",
      },
      {
        name: "Concerns (Should Address)",
        description: "Non-blocking issues worth addressing",
      },
      {
        name: "Questions (Need Clarification)",
        description: "Ambiguities requiring answers",
      },
      {
        name: "Verdict (REJECT | REVISE | PROCEED WITH CAUTION | APPROVED)",
        description: "Final review verdict",
      },
    ],
  },

  "PLAN.md": {
    description: "Structured implementation plan",
    producedBy: "src/machines/develop/planning.machine.js",
    consumers: [
      {
        file: "src/machines/develop/plan-review.machine.js",
        usage: "review input",
      },
      {
        file: "src/machines/develop/implementation.machine.js",
        usage: "implementation guide",
      },
      {
        file: "src/machines/develop/quality-review.machine.js",
        usage: "spec delta + review",
      },
    ],
    sections: [
      {
        name: "Summary",
        description: "One paragraph describing what will change",
      },
      { name: "Approach", description: "Which approach and why" },
      {
        name: "Files to Modify",
        description: "List each file with specific changes",
      },
      {
        name: "Files to Create",
        description: "New files only if absolutely necessary",
      },
      {
        name: "Dependencies",
        description: "New dependencies with version and justification",
      },
      {
        name: "Testing Strategy",
        description: "Test cases, existing tests, and test commands",
      },
      {
        name: "Out of Scope",
        description: "What this change does NOT include",
      },
    ],
  },

  "ISSUE.md": {
    description: "Structured issue specification",
    producedBy: "src/machines/develop/issue-draft.machine.js",
    consumers: [
      {
        file: "src/machines/develop/planning.machine.js",
        usage: "planning input",
      },
      {
        file: "src/machines/develop/implementation.machine.js",
        usage: "implementation scope",
      },
      {
        file: "src/machines/develop/quality-review.machine.js",
        usage: "review scope",
      },
    ],
    sections: [
      {
        name: "Metadata",
        description: "Source, Issue ID, Repo Root, Difficulty",
      },
      { name: "Problem", description: "What is wrong or missing" },
      {
        name: "Requirements",
        description: "Behavioral requirements using EARS syntax",
      },
      { name: "Changes", description: "Which files need to change and how" },
      {
        name: "Testing Strategy",
        description: "Existing tests, patterns, and new test cases",
      },
      {
        name: "Verification",
        description: "Concrete command to prove the fix works",
      },
      { name: "Out of Scope", description: "What this does NOT include" },
    ],
  },

  "REVIEW_FINDINGS.md": {
    description: "Quality review findings with verdict",
    producedBy: "src/machines/develop/quality-review.machine.js",
    consumers: [
      {
        file: "src/machines/develop/quality-review.machine.js",
        usage: "iterative review loop",
      },
    ],
    sections: [
      {
        name: "Finding N",
        description:
          "Individual finding with severity, file, lines, issue, suggestion",
      },
      { name: "VERDICT", description: "APPROVED or REVISE" },
    ],
    verdictPrefix: "## VERDICT: ",
    verdictValues: ["APPROVED", "REVISE"],
  },

  SPEC_DELTA: {
    description: "Spec delta summary comparing issue vs plan",
    producedBy: "src/machines/develop/quality-review.machine.js",
    consumers: [
      {
        file: "src/machines/develop/quality-review.machine.js",
        usage: "plan adherence review",
      },
    ],
    sections: [
      {
        name: "Additions",
        description:
          "New technical constraints or approaches introduced in the plan",
      },
      {
        name: "Refinements",
        description: "Changes in approach from the original issue",
      },
      {
        name: "Omissions",
        description: "Requirements deferred or removed in the plan",
      },
    ],
  },

  "synthesis-draft": {
    description: "Research issue backlog draft payload",
    producedBy: "src/machines/research/issue-synthesis.machine.js",
    consumers: [
      {
        file: "src/machines/research/issue-publish.machine.js",
        usage: "issue publishing",
      },
    ],
    fields: { issues: "array" },
  },

  "synthesis-review": {
    description: "Research issue backlog critique payload",
    producedBy: "src/machines/research/issue-synthesis.machine.js",
    consumers: [
      {
        file: "src/machines/research/issue-synthesis.machine.js",
        usage: "next iteration feedback",
      },
    ],
    fields: { must_fix: "array", should_fix: "array" },
  },

  "spec-architect-build": {
    description: "Spec architect build-mode payload",
    producedBy: "src/machines/research/spec-architect.machine.js",
    consumers: [
      {
        file: "src/machines/research/spec-architect.machine.js",
        usage: "build result",
      },
    ],
    fields: {
      domains: "array",
      decisions: "array",
      phases: "array",
      issueSpecs: "array",
    },
  },

  "spec-architect-ingest": {
    description: "Spec architect ingest-mode payload",
    producedBy: "src/machines/research/spec-architect.machine.js",
    consumers: [
      {
        file: "src/machines/research/spec-architect.machine.js",
        usage: "ingest result",
      },
    ],
    fields: { phases: "array", issueSpecs: "array" },
  },
};

/**
 * Render a numbered list of section headings for the given contract key.
 * @param {string} contractKey
 * @returns {string}
 */
export function renderRequiredSections(contractKey) {
  const entry = CONTRACTS[contractKey];
  if (!entry?.sections) {
    throw new Error(`renderRequiredSections: no sections for "${contractKey}"`);
  }
  return entry.sections.map((s, i) => `${i + 1}. ${s.name}`).join("\n");
}

/**
 * Return a comma-joined list of section names for embedding in prose.
 * Throws if any requested name is not in the contract.
 * @param {string} contractKey
 * @param {string[]} sectionNames
 * @returns {string}
 */
export function renderCritiqueSectionList(contractKey, sectionNames) {
  const entry = CONTRACTS[contractKey];
  if (!entry?.sections) {
    throw new Error(
      `renderCritiqueSectionList: no sections for "${contractKey}"`,
    );
  }
  const known = new Set(entry.sections.map((s) => s.name));
  for (const name of sectionNames) {
    if (!known.has(name)) {
      throw new Error(
        `renderCritiqueSectionList: section "${name}" not found in "${contractKey}"`,
      );
    }
  }
  return sectionNames.join(", ");
}
