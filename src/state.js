import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const SelectedIssueSchema = z.object({
  source: z.enum(["github", "linear"]),
  id: z.string().min(1),
  title: z.string().min(1),
  repo_path: z.string().default(""),
  difficulty: z.number().int().min(1).max(5).optional(),
  reason: z.string().default(""),
});

const StepsSchema = z
  .object({
    listedProjects: z.boolean().optional(),
    listedIssues: z.boolean().optional(),
    verifiedCleanRepo: z.boolean().optional(),
    wroteIssue: z.boolean().optional(),
    wrotePlan: z.boolean().optional(),
    wroteCritique: z.boolean().optional(),
    implemented: z.boolean().optional(),
    codexReviewed: z.boolean().optional(),
    ppcommitClean: z.boolean().optional(),
    testsPassed: z.boolean().optional(),
    finalized: z.boolean().optional(),
    prCreated: z.boolean().optional(),
  })
  .default({});

const IssuesPayloadSchema = z
  .object({
    issues: z.array(
      z.object({
        source: z.enum(["github", "linear"]),
        id: z.string().min(1),
        title: z.string().min(1),
        repo_path: z.string().default(""),
        difficulty: z.number().int().min(1).max(5),
        reason: z.string().default(""),
      }),
    ),
    recommended_index: z.number().int(),
  })
  .optional();

const LinearProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string().default(""),
});

	const StateSchema = z
	  .object({
    version: z.number().int().default(1),
    selected: SelectedIssueSchema.nullable().default(null),
    selectedProject: LinearProjectSchema.nullable().default(null),
    linearProjects: z.array(LinearProjectSchema).nullable().default(null),
    repoPath: z.string().nullable().default(null),
    branch: z.string().nullable().default(null),
    questions: z.array(z.string()).nullable().default(null),
    answers: z.array(z.string()).nullable().default(null),
    issuesPayload: IssuesPayloadSchema,
    steps: StepsSchema,
	    claudeSessionId: z.string().nullable().default(null),
	    lastError: z.string().nullable().default(null),
	    prUrl: z.string().nullable().default(null),
	    prBranch: z.string().nullable().default(null),
	  })
	  .passthrough();

const DEFAULT_STATE = {
  version: 1,
  selected: null,
  selectedProject: null,
  linearProjects: null,
  repoPath: null,
  branch: null,
  questions: null,
  answers: null,
  steps: {},
	  claudeSessionId: null,
	  lastError: null,
	  prUrl: null,
	  prBranch: null,
	};

export function statePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "state.json");
}

export function loadState(workspaceDir) {
  const p = statePathFor(workspaceDir);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return StateSchema.parse(raw);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(workspaceDir, state) {
  const p = statePathFor(workspaceDir);
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}
