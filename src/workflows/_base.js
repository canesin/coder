import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isRateLimitError } from "../helpers.js";
import {
  appendStepCheckpoint,
  loadCheckpoint,
  truncateCheckpoint,
} from "../state/machine-state.js";
import { pollControlSignal } from "../state/workflow-state.js";

export { CancelledError, checkCancel } from "../machines/_base.js";

export function runHooks(
  ctx,
  runId,
  event,
  machineName = "",
  data = {},
  extraEnv = {},
) {
  const hooks = ctx.config?.workflow?.hooks ?? [];
  for (const hook of hooks) {
    if (hook.on !== event) continue;
    if (hook.machine && !new RegExp(hook.machine).test(machineName)) continue;

    let hookData = "{}";
    try {
      hookData = JSON.stringify(data);
    } catch {}

    const env = {
      ...process.env,
      CODER_HOOK_EVENT: event,
      CODER_HOOK_MACHINE: machineName,
      CODER_HOOK_STATUS: String(data.status ?? ""),
      CODER_HOOK_DATA: hookData,
      CODER_HOOK_RUN_ID: runId,
      ...extraEnv,
    };

    try {
      execSync(hook.run, {
        env,
        shell: true,
        stdio: "pipe",
        encoding: "utf8",
        timeout: 30000,
      });
      ctx.log({
        event: "hook_run",
        hook: hook.run,
        hookEvent: event,
        machine: machineName,
      });
    } catch (err) {
      ctx.log({
        event: "hook_error",
        hook: hook.run,
        hookEvent: event,
        machine: machineName,
        error: err.message,
        stderr: (err.stderr ?? "").slice(0, 500),
        exitCode: err.status ?? null,
        signal: err.signal ?? null,
      });
    }
  }
}

/**
 * WorkflowRunner — composes machines into sequential pipelines.
 *
 * Handles:
 * - Sequential machine execution with inputMapper glue
 * - Cancel/pause checkpoints between machines
 * - Heartbeat emission
 * - State checkpointing after each machine
 * - Logging
 */
export class WorkflowRunner {
  /**
   * @param {{
   *   name: string,
   *   workflowContext: import("../machines/_base.js").WorkflowContext,
   *   onStageChange?: (stage: string, agentName?: string) => void,
   *   stageActiveAgent?: (machineName: string) => string | null | undefined,
   *   onHeartbeat?: () => void,
   *   onCheckpoint?: (machineIndex: number, result: any, machineName: string) => void,
   *   onResumeSkipped?: (runId: string) => Promise<void> | void,
   * }} opts
   */
  constructor(opts) {
    this.name = opts.name;
    this.ctx = opts.workflowContext;
    this.onStageChange = opts.onStageChange || (() => {});
    this.stageActiveAgent = opts.stageActiveAgent;
    this.onHeartbeat = opts.onHeartbeat || (() => {});
    this.onCheckpoint = opts.onCheckpoint || (() => {});
    this.onResumeSkipped = opts.onResumeSkipped || null;

    this.runId = randomUUID().slice(0, 8);
    this.results = [];
    this._heartbeatInterval = null;
  }

  /**
   * Run a sequence of machines.
   *
   * @param {Array<{
   *   machine: import("../machines/_base.js").Machine,
   *   inputMapper: (prevResult: any, state: { results: any[], runId: string }) => any,
   *   optional?: boolean,
   *   maxRetries?: number,
   *   backoffMs?: number,
   *   onFailedAttempt?: (info: { attempt: number, maxRetries: number, result: any }) => Promise<void> | void,
   * }>} steps
   * @param {any} [initialInput] - Input for the first machine's inputMapper (as prevResult)
   * @param {{ resumeFromRunId?: string }} [opts] - If resumeFromRunId, load checkpoint and resume from that run
   * @returns {Promise<{ status: string, results: any[], runId: string, durationMs: number }>}
   */
  async run(steps, initialInput = {}, opts = {}) {
    const start = Date.now();
    const workspaceDir = this.ctx.workspaceDir;

    let startIndex = 0;
    let prevResult = initialInput;

    if (opts.resumeFromRunId) {
      const checkpoint = loadCheckpoint(workspaceDir, opts.resumeFromRunId);
      if (!checkpoint || checkpoint.workflow !== this.name) {
        this.ctx.log({
          event: "resume_skipped",
          reason: checkpoint ? "workflow_mismatch" : "checkpoint_not_found",
          runId: opts.resumeFromRunId,
        });
        if (this.onResumeSkipped) await this.onResumeSkipped(this.runId);
      } else if (
        checkpoint.steps.length > 0 &&
        checkpoint.currentStep <= steps.length
      ) {
        this.runId = checkpoint.runId;
        this.results = checkpoint.steps.map((s) => ({
          machine: s.machine,
          status: s.status,
          data: s.data,
          error: s.error,
          durationMs: s.durationMs,
        }));
        const lastStep = checkpoint.steps[checkpoint.steps.length - 1];
        const retryFailed = lastStep?.status === "error";
        startIndex = retryFailed
          ? checkpoint.currentStep - 1
          : checkpoint.currentStep;
        if (retryFailed) {
          this.results.pop();
          truncateCheckpoint(workspaceDir, checkpoint.runId, startIndex);
        }
        prevResult =
          startIndex > 0 ? this.results[startIndex - 1] : initialInput;
        this.ctx.log({
          event: "workflow_resumed",
          workflow: this.name,
          runId: this.runId,
          fromStep: startIndex,
        });
      } else if (this.onResumeSkipped) {
        await this.onResumeSkipped(this.runId);
      }
    }

    if (startIndex === 0) {
      this.results = [];
    }

    this.ctx.workflowRunId = this.runId;

    this._heartbeatInterval = setInterval(() => {
      this.onHeartbeat();
      pollControlSignal(
        this.ctx.workspaceDir,
        this.ctx.cancelToken,
        this.runId,
      ).catch(() => {});
    }, 2000);

    try {
      this._runHooks("workflow_start", this.name);

      for (let i = startIndex; i < steps.length; i++) {
        // Cancel checkpoint
        if (this.ctx.cancelToken.cancelled) {
          this.ctx.log({
            event: "workflow_cancelled",
            workflow: this.name,
            runId: this.runId,
            atStep: i,
          });
          return {
            status: "cancelled",
            results: this.results,
            runId: this.runId,
            durationMs: Date.now() - start,
          };
        }

        // Pause checkpoint
        if (this.ctx.cancelToken.paused) {
          await this._waitForResume();
          if (this.ctx.cancelToken.cancelled) {
            return {
              status: "cancelled",
              results: this.results,
              runId: this.runId,
              durationMs: Date.now() - start,
            };
          }
        }

        const step = steps[i];
        const machineName = step.machine.name;

        this.onStageChange(machineName);
        if (typeof this.ctx.onWorkflowStage === "function") {
          /** @type {{ stage: string, activeAgent?: string }} */
          const payload = { stage: machineName };
          if (typeof this.stageActiveAgent === "function") {
            const agent = this.stageActiveAgent(machineName);
            if (agent != null && agent !== "") payload.activeAgent = agent;
          }
          this.ctx.onWorkflowStage(payload);
        }
        this.ctx.log({
          event: "machine_start",
          workflow: this.name,
          runId: this.runId,
          machine: machineName,
          stepIndex: i,
        });
        this._runHooks("machine_start", machineName);

        const input = step.inputMapper(prevResult, {
          results: this.results,
          runId: this.runId,
        });

        const stepMaxRetries =
          step.maxRetries ?? this.ctx.config?.workflow?.maxMachineRetries ?? 0;
        const stepBackoffMs =
          step.backoffMs ?? this.ctx.config?.workflow?.retryBackoffMs ?? 5000;

        let result;
        for (let attempt = 0; attempt <= stepMaxRetries; attempt++) {
          if (attempt > 0) {
            if (this.ctx.cancelToken.cancelled) {
              result = {
                status: "cancelled",
                error: "Cancelled between retry attempts",
                durationMs: 0,
              };
              break;
            }
            this.ctx.log({
              event: "step_retry_attempt",
              workflow: this.name,
              runId: this.runId,
              machine: machineName,
              attempt,
              maxRetries: stepMaxRetries,
            });
            if (stepBackoffMs > 0)
              await new Promise((r) => setTimeout(r, stepBackoffMs));
          }

          result = await step.machine.run(input, this.ctx);

          if (result.status === "cancelled") break;
          if (result.status !== "error") break;
          if (isRateLimitError(result.error)) {
            this.ctx.log({
              event: "step_retry_suppressed_rate_limit",
              workflow: this.name,
              runId: this.runId,
              machine: machineName,
              attempt,
              maxRetries: stepMaxRetries,
              error: result.error,
            });
            break;
          }

          this.ctx.log({
            event: "step_retry_failed",
            workflow: this.name,
            runId: this.runId,
            machine: machineName,
            attempt,
            maxRetries: stepMaxRetries,
            error: result.error,
          });
          if (typeof step.onFailedAttempt === "function") {
            await step.onFailedAttempt({
              attempt,
              maxRetries: stepMaxRetries,
              result,
            });
          }
          if (attempt === stepMaxRetries) break;
        }

        this.results.push({ machine: machineName, ...result });
        this.onCheckpoint(i, result, machineName);

        try {
          appendStepCheckpoint(this.ctx.workspaceDir, this.runId, this.name, {
            machine: machineName,
            status:
              result.status === "ok"
                ? "ok"
                : result.status === "cancelled"
                  ? "cancelled"
                  : result.status === "error"
                    ? "error"
                    : "skipped",
            data: result.data,
            error: result.error,
            durationMs: result.durationMs || 0,
          });
        } catch {
          /* best-effort */
        }

        this.ctx.log({
          event: "machine_complete",
          workflow: this.name,
          runId: this.runId,
          machine: machineName,
          status: result.status,
          durationMs: result.durationMs,
          error: result.error || null,
        });
        this._runHooks(
          result.status === "error" ? "machine_error" : "machine_complete",
          machineName,
          result,
        );

        if (result.status === "cancelled") {
          return {
            status: "cancelled",
            results: this.results,
            runId: this.runId,
            durationMs: Date.now() - start,
          };
        }

        if (result.status === "error" && !step.optional) {
          const failedResult = {
            status: "failed",
            results: this.results,
            runId: this.runId,
            durationMs: Date.now() - start,
            error: result.error,
          };
          this._runHooks("workflow_failed", this.name, failedResult);
          return failedResult;
        }

        prevResult = result;
      }

      const completedResult = {
        status: "completed",
        results: this.results,
        runId: this.runId,
        durationMs: Date.now() - start,
      };
      this._runHooks("workflow_complete", this.name, completedResult);
      return completedResult;
    } catch (err) {
      this._runHooks("workflow_failed", this.name, {
        status: "failed",
        error: err.message,
      });
      throw err;
    } finally {
      delete this.ctx.workflowRunId;
      if (this._heartbeatInterval) {
        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
      }
    }
  }

  _runHooks(event, machineName, data = {}) {
    runHooks(this.ctx, this.runId, event, machineName, data);
  }

  async _waitForResume() {
    const MAX_PAUSE_MS = 1000 * 60 * 60 * 24; // 24 hours
    const CHECK_INTERVAL_MS = 1000;
    const start = Date.now();

    while (this.ctx.cancelToken.paused && !this.ctx.cancelToken.cancelled) {
      if (Date.now() - start > MAX_PAUSE_MS) {
        this.ctx.cancelToken.cancelled = true;
        this.ctx.log({
          event: "workflow_pause_timeout",
          workflow: this.name,
          runId: this.runId,
          pausedDurationMs: Date.now() - start,
        });
        break;
      }
      await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
      this.onHeartbeat();
      await pollControlSignal(
        this.ctx.workspaceDir,
        this.ctx.cancelToken,
        this.runId,
      );
    }
  }
}
