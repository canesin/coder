import { randomUUID } from "node:crypto";

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
    }, 2000);

    try {
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

        if (result.status === "error" && !step.optional) {
          return {
            status: "failed",
            results: this.results,
            runId: this.runId,
            durationMs: Date.now() - start,
            error: result.error,
          };
        }

        prevResult = result;
      }

      return {
        status: "completed",
        results: this.results,
        runId: this.runId,
        durationMs: Date.now() - start,
      };
    } finally {
      if (this._heartbeatInterval) {
        clearInterval(this._heartbeatInterval);
        this._heartbeatInterval = null;
      }
    }
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
    }
  }
}
