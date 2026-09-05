import { describe, it, expect, vi } from "vitest";
import { HostedServerProvider } from "../src/index.js";
import type { GenerationRequest } from "../../../contracts/index.js";

// Base request using an OpenAI model (routed to openai provider)
const req: GenerationRequest = {
  request_id: "req-1",
  run_id: "run-1",
  messages: [{ role: "user", content: "hello" }],
  model_policy: { preferred_models: ["gpt-4.1-mini"], allow_fallback: true },
};

const openaiOkBody = JSON.stringify({
  output_text: "Normalized stage output",
  usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
  status: "completed",
});

describe("provider identity", () => {
  it("has provider_id hosted-server", () => {
    const p = new HostedServerProvider({ env: {}, fetchImpl: vi.fn() });
    expect(p.provider_id).toBe("hosted-server");
  });
});

describe("generate — OpenAI response normalization", () => {
  // port of source: "normalizes an OpenAI response without accepting a browser-supplied endpoint"
  it("maps a successful OpenAI response to GenerationResult", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(openaiOkBody, { status: 200 }));
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "server-key" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("content" in out && out.content).toBe("Normalized stage output");
    expect("model_id" in out && out.model_id).toBe("gpt-4.1-mini");
    expect("provider_id" in out && out.provider_id).toBe("hosted-server");
    expect("usage" in out && out.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 7 });
    // key must reach the upstream call, not the caller
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer server-key" }) }),
    );
  });

  it("does not expose the server API key in any returned value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(openaiOkBody, { status: 200 }));
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "SECRETVALUE01234" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect(JSON.stringify(out)).not.toContain("SECRETVALUE01234");
  });
});

describe("generate — model allowlist enforcement", () => {
  // port of source: "rejects models outside the server allowlist before any provider call"
  it("returns INVALID_REQUEST for a model not in the server allowlist", async () => {
    const fetchMock = vi.fn();
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "server-key" }, fetchImpl: fetchMock });
    const out = await p.generate({ ...req, model_policy: { preferred_models: ["unapproved-model"], allow_fallback: false } });
    expect("category" in out && out.category).toBe("INVALID_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns INVALID_REQUEST when preferred_models is empty", async () => {
    const p = new HostedServerProvider({ env: {}, fetchImpl: vi.fn() });
    const out = await p.generate({ ...req, model_policy: { preferred_models: [], allow_fallback: false } });
    expect("category" in out && out.category).toBe("INVALID_REQUEST");
  });
});

describe("generate — error mapping", () => {
  it("maps a 429 from the provider to RATE_LIMIT (retriable, retry_after_ms=60_000)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "k" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("RATE_LIMIT");
    expect("retriable" in out && out.retriable).toBe(true);
    expect("retry_after_ms" in out && out.retry_after_ms).toBe(60_000);
  });

  it("maps a fetch timeout (AbortError) to TIMEOUT (retriable)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "k" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("TIMEOUT");
    expect("retriable" in out && out.retriable).toBe(true);
  });

  it("maps a network error to UNAVAILABLE (retriable)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "k" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("UNAVAILABLE");
    expect("retriable" in out && out.retriable).toBe(true);
  });

  it("maps an empty response body to MALFORMED_RESPONSE", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "completed" }), { status: 200 }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "k" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("MALFORMED_RESPONSE");
  });

  it("maps unconfigured provider to INVALID_REQUEST, does not call fetch", async () => {
    const fetchMock = vi.fn();
    const p = new HostedServerProvider({ env: {}, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("INVALID_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "AUTH", false],
    [403, "AUTH", false],
    [400, "INVALID_REQUEST", false],
    [500, "UNAVAILABLE", true],
    [503, "UNAVAILABLE", true],
  ])("HTTP %i maps to %s (retriable=%s)", async (status, category, retriable) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "x" } }), { status }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "k" }, fetchImpl: fetchMock });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe(category);
    expect("retriable" in out && out.retriable).toBe(retriable);
  });
});

describe("generate — Anthropic and Gemini parsers", () => {
  // port of source: "uses provider-specific Anthropic and Gemini response parsers"
  it("parses an Anthropic response via the anthropic extractor", async () => {
    const body = JSON.stringify({
      content: [{ type: "text", text: "Claude result" }],
      usage: { input_tokens: 3, output_tokens: 5 },
      stop_reason: "end_turn",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const p = new HostedServerProvider({ env: { ANTHROPIC_API_KEY: "anthropic-key" }, fetchImpl: fetchMock });
    const out = await p.generate({ ...req, model_policy: { preferred_models: ["claude-sonnet-4-5"], allow_fallback: false } });
    expect("content" in out && out.content).toBe("Claude result");
    expect("finish_reason" in out && out.finish_reason).toBe("end_turn");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.anything(),
    );
  });

  it("parses a Gemini response via the gemini extractor", async () => {
    const body = JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Gemini result" }] }],
      usage: { total_input_tokens: 4, total_output_tokens: 6, total_tokens: 10 },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const p = new HostedServerProvider({ env: { GEMINI_API_KEY: "gemini-key" }, fetchImpl: fetchMock });
    const out = await p.generate({ ...req, model_policy: { preferred_models: ["gemini-3.6-flash"], allow_fallback: false } });
    expect("content" in out && out.content).toBe("Gemini result");
    expect("usage" in out && out.usage?.completion_tokens).toBe(6);
    // store:false privacy guard
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("interactions"),
      expect.objectContaining({ body: expect.stringContaining('"store":false') }),
    );
  });
});

describe("generate — multi-turn flattening", () => {
  it("sends multi-turn conversation as a formatted user string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(openaiOkBody, { status: 200 }));
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "k" }, fetchImpl: fetchMock });
    await p.generate({
      ...req,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "follow-up" },
      ],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { input: unknown[] };
    const userTurn = (body.input as Array<{ role: string; content: string }>).find((t) => t.role === "user");
    expect(userTurn?.content).toContain("User: first");
    expect(userTurn?.content).toContain("Assistant: reply");
    expect(userTurn?.content).toContain("User: follow-up");
  });
});

describe("healthCheck", () => {
  // port of source: "uses model metadata, not generation, to report cached provider health"
  it("reports ok=true when the default provider is healthy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "gpt-4.1-mini" }), { status: 200 }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "server-key" }, fetchImpl: fetchMock });
    const health = await p.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.degradation_state).toBe("NONE");
    expect(health.failing_dependency).toBeNull();
    // health check must use the model-metadata probe endpoint, not a generation endpoint
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/models/"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("caches health — only one upstream call per window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "gpt-4.1-mini" }), { status: 200 }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "server-key" }, fetchImpl: fetchMock });
    await p.healthCheck();
    await p.healthCheck();
    // fetchMock covers all 4 providers; openai is the only configured one
    const openaiCalls = fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).includes("api.openai.com"));
    expect(openaiCalls).toHaveLength(1);
  });

  it("reports ok=false and UNAVAILABLE when provider is unconfigured", async () => {
    const p = new HostedServerProvider({ env: {}, fetchImpl: vi.fn() });
    const health = await p.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.degradation_state).toBe("UNAVAILABLE");
    expect(health.failing_dependency).toContain("openai");
  });

  // port of source: "reports unavailable health without returning upstream provider details"
  it("reports UNAVAILABLE without leaking upstream credential errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "internal provider detail" } }), { status: 403 }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "server-key" }, fetchImpl: fetchMock });
    const health = await p.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.degradation_state).toBe("UNAVAILABLE");
    expect(JSON.stringify(health)).not.toContain("internal provider detail");
  });

  it("does not include any key value in the health response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "gpt-4.1-mini" }), { status: 200 }),
    );
    const p = new HostedServerProvider({ env: { OPENAI_API_KEY: "SECRETVALUE01234" }, fetchImpl: fetchMock });
    const health = await p.healthCheck();
    expect(JSON.stringify(health)).not.toContain("SECRETVALUE01234");
  });
});
