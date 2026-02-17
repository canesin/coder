/**
 * AgentAdapter — abstract interface for all agent backends.
 *
 * Implementations: CliAgent (shell CLI), ApiAgent (HTTP), McpAgent (MCP client).
 */
export class AgentAdapter {
  /**
   * @param {string} prompt - Prompt text to send to the agent
   * @param {{
   *   timeoutMs?: number,
   *   hangTimeoutMs?: number,
   *   structured?: boolean,
   *   sessionId?: string,
   *   resumeId?: string,
   * }} [opts]
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
   */
  async execute(_prompt, _opts) {
    throw new Error("AgentAdapter.execute() must be implemented");
  }

  /**
   * Execute and parse structured JSON from the response.
   * @param {string} prompt
   * @param {object} [opts]
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, parsed?: any }>}
   */
  async executeStructured(_prompt, _opts) {
    throw new Error("AgentAdapter.executeStructured() must be implemented");
  }

  /**
   * Kill any running process.
   */
  async kill() {}
}
