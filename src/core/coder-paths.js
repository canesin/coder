import path from "node:path";

/** Artifact file name constants. */
export const ISSUE_FILE = "ISSUE.md";
export const PLAN_FILE = "PLAN.md";
export const CRITIQUE_FILE = "PLANREVIEW.md";
export const REVIEW_FINDINGS_FILE = "REVIEW_FINDINGS.md";
export const RCA_FILE = "RCA.md";

/**
 * Canonical `.coder` directory path builder.
 * Centralizes knowledge of the `.coder` directory layout.
 */
export class CoderPaths {
  constructor(workspaceDir) {
    this.root = path.join(workspaceDir, ".coder");
    this.artifacts = path.join(this.root, "artifacts");
    this.scratchpad = path.join(this.root, "scratchpad");
    this.logs = path.join(this.root, "logs");
    this.locks = path.join(this.root, "locks");
    this.rca = path.join(this.root, "rca");
    this.backups = path.join(this.root, "backups");
    this.failures = path.join(this.root, "failures");
    this.localIssues = path.join(this.root, "local-issues");
  }

  /** Well-known JSON state files. */
  stateFile() {
    return path.join(this.root, "state.json");
  }
  workflowStateFile() {
    return path.join(this.root, "workflow-state.json");
  }
  loopStateFile() {
    return path.join(this.root, "loop-state.json");
  }
  controlFile() {
    return path.join(this.root, "control.json");
  }
  activityFile() {
    return path.join(this.root, "activity.json");
  }
  mcpHealthFile() {
    return path.join(this.root, "mcp-health.json");
  }
  researchStateFile() {
    return path.join(this.root, "research-state.json");
  }
  checkpointFile(runId) {
    return path.join(this.root, `checkpoint-${runId}.json`);
  }

  /** Lock files. */
  startLockFile() {
    return path.join(this.locks, "workflow-start.lock");
  }
  developPipelineLockFile() {
    return path.join(this.locks, "develop-pipeline.lock");
  }

  /** Artifact files within the artifacts directory. */
  artifactFile(name) {
    return path.join(this.artifacts, name);
  }
}
