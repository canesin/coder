import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    ppcommitInitiallyClean: z.boolean().optional(),
    ppcommitClean: z.boolean().optional(),
    testsPassed: z.boolean().optional(),
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
    baseBranch: z.string().nullable().default(null),
    branch: z.string().nullable().default(null),
    questions: z.array(z.string()).nullable().default(null),
    answers: z.array(z.string()).nullable().default(null),
    issuesPayload: IssuesPayloadSchema,
    steps: StepsSchema,
	    claudeSessionId: z.string().nullable().default(null),
	    lastError: z.string().nullable().default(null),
    reviewFingerprint: z.string().nullable().default(null),
    reviewedAt: z.string().nullable().default(null),
    prUrl: z.string().nullable().default(null),
    prBranch: z.string().nullable().default(null),
    prBase: z.string().nullable().default(null),
  })
  .passthrough();

const DEFAULT_STATE = {
  version: 1,
  selected: null,
  selectedProject: null,
  linearProjects: null,
  repoPath: null,
  baseBranch: null,
  branch: null,
  questions: null,
  answers: null,
  steps: {},
	  claudeSessionId: null,
	  lastError: null,
  reviewFingerprint: null,
  reviewedAt: null,
  prUrl: null,
  prBranch: null,
  prBase: null,
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
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}

// --- Loop (autonomous mode) state ---

const LoopIssueResultSchema = z.object({
  source: z.enum(["github", "linear"]),
  id: z.string().min(1),
  title: z.string(),
  repoPath: z.string().default(""),
  baseBranch: z.string().nullable().default(null),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]),
  branch: z.string().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
});

const LoopStateSchema = z.object({
  version: z.number().int().default(1),
  runId: z.string().nullable().default(null),
  goal: z.string().default(""),
  status: z.enum(["idle", "running", "paused", "completed", "failed", "cancelled"]).default("idle"),
  projectFilter: z.string().nullable().default(null),
  maxIssues: z.number().int().nullable().default(null),
  issueQueue: z.array(LoopIssueResultSchema).default([]),
  currentIndex: z.number().int().default(0),
  currentStage: z.string().nullable().default(null),
  currentStageStartedAt: z.string().nullable().default(null),
  lastHeartbeatAt: z.string().nullable().default(null),
  runnerPid: z.number().int().nullable().default(null),
  activeAgent: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export function loopStatePathFor(workspaceDir) {
  return path.join(workspaceDir, ".coder", "loop-state.json");
}

export function loadLoopState(workspaceDir) {
  const p = loopStatePathFor(workspaceDir);
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return LoopStateSchema.parse(raw);
  } catch {
    return LoopStateSchema.parse({});
  }
}

export function saveLoopState(workspaceDir, loopState) {
  const p = loopStatePathFor(workspaceDir);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(loopState, null, 2) + "\n");
}
