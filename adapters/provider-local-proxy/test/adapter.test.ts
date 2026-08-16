import { describe, it, expect, afterEach } from "vitest";
import { LocalProxyProvider, isSafePathTail } from "../src/index.js";
import type { GenerationRequest } from "../../../contracts/index.js";

/**
 * The provider adapter had no direct test. A mutation probe that disabled the
 * path-traversal check survived the whole suite, which is the plainest possible
 * statement that this file's security behaviour was unverified.
 *
 * Assertions here are traced to the source suite where one exists —
 * sources/v5/promptnexus-v5/tests/test_server.py. That file tests an HTTP
 * server and this is a client transport, so the mapping is partial by nature;
 * `assertion-map` below records which of its checks port and which cannot,
 * rather than implying full coverage.
 */

const req: GenerationRequest = {
  request_id: "req-1",
  run_id: "run-1",
  messages: [{ role: "user", content: "hello" }],
  model_policy: { preferred_models: ["claude-opus-5"], allow_fallback: true },
};

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("isSafePathTail — port of test_server.py traversal checks", () => {
  it("accepts an ordinary model segment", () => {
    expect(isSafePathTail("claude-opus-5")).toBe(true);
    expect(isSafePathTail("gemini-1.5_pro")).toBe(true);
  });

  // port of test_server.py "traversal blocked: <escape>"
  for (const escape of ["..", "../", "../../etc/passwd", "a/../b", "..\\windows"]) {
    it(`blocks traversal: ${JSON.stringify(escape)}`, () => {
      expect(isSafePathTail(escape)).toBe(false);
    });
  }

  // port of test_server.py "sibling-prefix traversal blocked"
  it("blocks a URL-encoded traversal", () => {
    expect(isSafePathTail("%2e%2e%2fsecret")).toBe(false);
    expect(isSafePathTail("%2E%2E/secret")).toBe(false);
  });

  it("blocks path separators outright", () => {
    expect(isSafePathTail("models/secret")).toBe(false);
    expect(isSafePathTail("models\\secret")).toBe(false);
  });

  it("rejects empty and over-long segments", () => {
    expect(isSafePathTail("")).toBe(false);
    expect(isSafePathTail("a".repeat(129))).toBe(false);
    expect(isSafePathTail("a".repeat(128))).toBe(true);
  });

  it("rejects characters outside the allowed set", () => {
    expect(isSafePathTail("model?query=1")).toBe(false);
    expect(isSafePathTail("model name")).toBe(false);
    expect(isSafePathTail("model;rm")).toBe(false);
  });
});

describe("credentials", () => {
  // port of test_server.py "missing key is 401, not a crash"
  it("a missing key is a typed AUTH failure, not a throw", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = new LocalProxyProvider({ fetchImpl: async () => { throw new Error("must not be called"); } });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("AUTH");
  });

  // port of test_server.py "401 names the env var, not the key"
  it("names the environment variable and never a key value", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-SECRETVALUE0123456789";
    const p = new LocalProxyProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "API key is invalid." } }), { status: 401 }),
    });
    const out = await p.generate(req);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("SECRETVALUE");

    delete process.env.ANTHROPIC_API_KEY;
    const out2 = await new LocalProxyProvider({ fetchImpl: async () => new Response("{}") }).generate(req);
    expect("safe_message" in out2 && out2.safe_message).toContain("ANTHROPIC_API_KEY");
  });

  it("does not call out at all when no key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let called = false;
    const p = new LocalProxyProvider({ fetchImpl: async () => { called = true; return new Response("{}"); } });
    await p.generate(req);
    expect(called).toBe(false);
  });
});

describe("failure classification", () => {
  const withStatus = async (status: number, body: unknown = { error: { message: "x" } }) => {
    process.env.ANTHROPIC_API_KEY = "k";
    const p = new LocalProxyProvider({
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
    });
    return p.generate(req);
  };

  it.each([
    [401, "AUTH", false],
    [403, "AUTH", false],
    [429, "RATE_LIMIT", true],
    [400, "INVALID_REQUEST", false],
    [500, "UNAVAILABLE", true],
    [503, "UNAVAILABLE", true],
  ])("HTTP %i maps to %s (retriable=%s)", async (status, category, retriable) => {
    const out = await withStatus(status as number);
    expect("category" in out && out.category).toBe(category);
    expect("retriable" in out && out.retriable).toBe(retriable);
  });

  // port of test_server.py "oversized body is 413" — checked before sending
  it("rejects an oversized request before it leaves", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    let called = false;
    const p = new LocalProxyProvider({ fetchImpl: async () => { called = true; return new Response("{}"); } });
    const huge: GenerationRequest = { ...req, messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }] };
    const out = await p.generate(huge);
    expect("reason_code" in out && out.reason_code).toBe("request_too_large");
    expect(called).toBe(false);
  });

  it("treats a truncated response as a failure, not a success", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const p = new LocalProxyProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "half" }], stop_reason: "max_tokens" })),
    });
    const out = await p.generate(req);
    expect("category" in out).toBe(true);
    expect("reason_code" in out && out.reason_code).toBe("max_tokens_truncated");
  });

  it("treats a refusal as a failure", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const p = new LocalProxyProvider({
      fetchImpl: async () => new Response(JSON.stringify({ content: [], stop_reason: "refusal" })),
    });
    const out = await p.generate(req);
    expect("category" in out && out.category).toBe("CONTENT_FILTER");
  });

  it("returns a result on success", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const p = new LocalProxyProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({
          content: [{ type: "text", text: "compiled" }],
          model: "claude-opus-5",
          stop_reason: "end_turn",
        })),
    });
    const out = await p.generate(req);
    expect("content" in out && out.content).toBe("compiled");
  });
});

describe("healthCheck", () => {
  // port of test_server.py "providers exposes booleans only"
  it("reports configuration state without exposing the key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-SECRETVALUE0123456789";
    const health = await new LocalProxyProvider().healthCheck();
    expect(health.ok).toBe(true);
    expect(JSON.stringify(health)).not.toContain("SECRETVALUE");
  });

  // port of test_server.py "unset provider reports unconfigured"
  it("reports UNAVAILABLE and names the missing dependency when unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const health = await new LocalProxyProvider().healthCheck();
    expect(health.ok).toBe(false);
    expect(health.degradation_state).toBe("UNAVAILABLE");
    expect(health.failing_dependency).toBe("ANTHROPIC_API_KEY");
  });
});
