import assert from "node:assert/strict";
import test from "node:test";
import { ApiAgent } from "../src/agents/api-agent.js";

test("GH-59: Gemini API key in x-goog-api-key header, not URL", async () => {
  let capturedUrl;
  let capturedHeaders;

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    };
  };

  try {
    const agent = new ApiAgent({
      provider: "gemini",
      endpoint: "https://test",
      apiKey: "test-key",
    });
    const res = await agent.execute("hello");

    assert.equal(res.stdout, "ok");
    assert.equal(
      new URL(capturedUrl).searchParams.get("key"),
      null,
      "API key must not appear in URL query params",
    );
    assert.equal(
      capturedHeaders["x-goog-api-key"],
      "test-key",
      "API key must be in x-goog-api-key header",
    );
  } finally {
    global.fetch = origFetch;
  }
});
