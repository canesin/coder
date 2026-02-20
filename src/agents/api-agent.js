import { extractJson } from "../helpers.js";
import { AgentAdapter } from "./_base.js";

/**
 * API-based agent — direct HTTP calls to Gemini/Anthropic APIs.
 *
 * Used for simple tasks: classification, JSON extraction, scoring.
 * No shell overhead, no MCP servers, no file system access.
 */
export class ApiAgent extends AgentAdapter {
  /**
   * @param {{
   *   provider: "gemini" | "anthropic",
   *   endpoint: string,
   *   apiKey: string,
   *   model?: string,
   *   systemPrompt?: string,
   * }} opts
   */
  constructor(opts) {
    super();
    this.provider = opts.provider;
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.model = opts.model || "";
    this.systemPrompt = opts.systemPrompt || "";
    /** @type {Map<string, AbortController>} */
    this._activeControllers = new Map();
    this._callIdCounter = 0;
  }

  async execute(prompt, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const callId = String(++this._callIdCounter);
    const abortController = new AbortController();
    this._activeControllers.set(callId, abortController);
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response =
        this.provider === "gemini"
          ? await this._callGemini(prompt, abortController.signal)
          : await this._callAnthropic(prompt, abortController.signal);

      return { exitCode: 0, stdout: response, stderr: "" };
    } catch (err) {
      if (err.name === "AbortError") {
        return {
          exitCode: 124,
          stdout: "",
          stderr: `API request timed out after ${timeoutMs}ms`,
        };
      }
      return { exitCode: 1, stdout: "", stderr: err.message };
    } finally {
      clearTimeout(timer);
      this._activeControllers.delete(callId);
    }
  }

  async executeStructured(prompt, opts = {}) {
    const res = await this.execute(prompt, opts);
    let parsed = null;
    let parseError = null;

    if (res.stdout) {
      try {
        parsed = extractJson(res.stdout);
      } catch (err) {
        parseError = err.message;
      }
    } else if (res.exitCode === 0) {
      parseError = "Empty response from API";
    }

    return { ...res, parsed, parseError };
  }

  async kill() {
    for (const controller of this._activeControllers.values()) {
      controller.abort();
    }
    this._activeControllers.clear();
  }

  async _callGemini(prompt, signal) {
    const model = this.model || "gemini-3.1-pro-preview";
    const url = `${this.endpoint}/models/${model}:generateContent`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
    };
    if (this.systemPrompt) {
      body.systemInstruction = { parts: [{ text: this.systemPrompt }] };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini API ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      throw new Error("Gemini API returned empty response");
    }
    return parts.map((p) => p.text || "").join("");
  }

  async _callAnthropic(prompt, signal) {
    const model = this.model || "claude-sonnet-4-6";
    const url = `${this.endpoint}/v1/messages`;

    const body = {
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (this.systemPrompt) {
      body.system = this.systemPrompt;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const blocks = data?.content;
    if (!blocks?.length) {
      throw new Error("Anthropic API returned empty response");
    }
    return blocks.map((b) => b.text || "").join("");
  }
}

/**
 * Create an ApiAgent from config and secrets.
 *
 * @param {{
 *   config: import("../config.js").CoderConfig,
 *   secrets: Record<string, string>,
 *   provider?: "gemini" | "anthropic",
 *   systemPrompt?: string,
 * }} opts
 */
export function createApiAgent(opts) {
  const { config, secrets } = opts;
  const provider = opts.provider || "gemini";

  if (provider === "gemini") {
    return new ApiAgent({
      provider: "gemini",
      endpoint: config.models.gemini.apiEndpoint,
      apiKey: secrets[config.models.gemini.apiKeyEnv] || "",
      model: config.models.gemini.model,
      systemPrompt: opts.systemPrompt,
    });
  }

  return new ApiAgent({
    provider: "anthropic",
    endpoint: config.models.claude.apiEndpoint,
    apiKey: secrets[config.models.claude.apiKeyEnv] || "",
    model: config.models.claude.model,
    systemPrompt: opts.systemPrompt,
  });
}
