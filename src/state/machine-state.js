import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Per-machine state checkpoint — saved after each machine completes within a workflow.
 */

const MachineCheckpointSchema = z.object({
  machine: z.string(),
  status: z.enum(["ok", "error", "skipped"]),
  data: z.any().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  completedAt: z.string(),
});

const WorkflowCheckpointSchema = z.object({
  runId: z.string(),
  workflow: z.string(),
  steps: z.array(MachineCheckpointSchema).default([]),
  currentStep: z.number().int().default(0),
  updatedAt: z.string(),
});

export function checkpointPathFor(workspaceDir, runId) {
  return path.join(workspaceDir, ".coder", `checkpoint-${runId}.json`);
}

export function saveCheckpoint(workspaceDir, checkpoint) {
  const p = checkpointPathFor(workspaceDir, checkpoint.runId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(checkpoint, null, 2) + "\n");
}

export function loadCheckpoint(workspaceDir, runId) {
  const p = checkpointPathFor(workspaceDir, runId);
  if (!existsSync(p)) return null;
  try {
    return WorkflowCheckpointSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function appendStepCheckpoint(workspaceDir, runId, workflow, step) {
  const existing = loadCheckpoint(workspaceDir, runId) || {
    runId,
    workflow,
    steps: [],
    currentStep: 0,
    updatedAt: new Date().toISOString(),
  };
  existing.steps.push({
    ...step,
    completedAt: new Date().toISOString(),
  });
  existing.currentStep = existing.steps.length;
  existing.updatedAt = new Date().toISOString();
  saveCheckpoint(workspaceDir, existing);
  return existing;
}
