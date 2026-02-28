import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pollControlSignal } from "../state/workflow-state.js";

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
   *   onHeartbeat?: () => void,
   *   onCheckpoint?: (machineIndex: number, result: any) => void,
   * }} opts
   */
  constructor(opts) {
    this.name = opts.name;
    this.ctx = opts.workflowContext;
    this.onStageChange = opts.onStageChange || (() => {});
    this.onHeartbeat = opts.onHeartbeat || (() => {});
    this.onCheckpoint = opts.onCheckpoint || (() => {});

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
   * }>} steps
   * @param {any} [initialInput] - Input for the first machine's inputMapper (as prevResult)
   * @returns {Promise<{ status: string, results: any[], runId: string, durationMs: number }>}
   */
  async run(steps, initialInput = {}) {
    const start = Date.now();
    this.results = [];

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
      let prevResult = initialInput;

      for (let i = 0; i < steps.length; i++) {
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

        const result = await step.machine.run(input, this.ctx);

        this.results.push({ machine: machineName, ...result });
        this.onCheckpoint(i, result);

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
