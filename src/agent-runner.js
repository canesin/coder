import { EventEmitter } from "node:events";

/**
 * Thin wrapper around HostSandboxProvider that exposes the executeCommand()
 * and EventEmitter interface the orchestrator expects.
 */
export class AgentRunner extends EventEmitter {
  constructor(provider) {
    super();
    this._provider = provider;
    this._sandbox = null;
  }

  async executeCommand(command, opts = {}) {
    if (!this._sandbox) {
      this._sandbox = await this._provider.create();
      this._sandbox.on("stdout", (d) => this.emit("stdout", d));
      this._sandbox.on("stderr", (d) => this.emit("stderr", d));
    }
    return this._sandbox.commands.run(command, opts);
  }
}
