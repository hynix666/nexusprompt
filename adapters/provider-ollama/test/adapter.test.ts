import { describe, it, expect, afterEach } from "vitest";
import { OllamaProvider, isLoopbackHost } from "../src/index.js";
import type { GenerationRequest } from "../../../contracts/index.js";

/**
 * The Ollama transport, driven against a fake daemon.
 *
 * No test here reaches the network. `fetchImpl` is injected in every case, and the one live
 * test at the bottom is skipped unless a daemon is actually there — CI has none, and a suite
 * that needs a 17 GB model pulled is a suite nobody can run.
 *
 * The property this file exists for is the `MALFORMED_RESPONSE` classification. Three
 * different things can go wrong AFTER a successful call, and all three mean the model ran:
 * a body that is not JSON, an envelope with no content, an empty completion. Getting any of
 * them wrong puts `⟦WORKFLOW DEMO — no model⟧` on a run that reached a model, which is the
 * false statement ADR-0014 exists to prevent.
 */

const req: GenerationRequest = {
  request_id: "req-1",
  run_id: "run-1",
  messages: [{ role: "user", content: "hello" }],
  model_policy: { preferred_models: ["local"], allow_fallback: false },
};

/** A fake daemon that answers with whatever the case needs. */
const daemon = (
  body: unknown,
  init: { status?: number; json?: boolean; text?: string } = {},
): typeof fetch =>
  (async () => {
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (init.json === false) throw new SyntaxError("Unexpected token");
        return body;
      },
      text: async () => init.text ?? JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;

const good = { model: "m", message: { role: "assistant", content: "a compiled prompt" }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 34 };

const provider = (fetchImpl: typeof fetch, opts = {}) =>
  new OllamaProvider({ fetchImpl, model: "test-model", ...opts });

const saved = process.env.OLLAMA_MODEL;
afterEach(() => {
  if (saved === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = saved;
});

describe("the happy path", () => {
  it("returns the completion, the model, and real usage", async () => {
    const out = await provider(daemon(good)).generate(req);
    expect("category" in out).toBe(false);
    if ("category" in out) return;
    expect(out.content).toBe("a compiled prompt");
    expect(out.provider_id).toBe("ollama-local");
    expect(out.model_id).toBe("m");
    expect(out.finish_reason).toBe("stop");
    expect(out.usage?.prompt_tokens).toBe(12);
    expect(out.usage?.completion_tokens).toBe(34);
  });

  it("reports no cache_read_tokens, because Ollama has no prompt cache", async () => {
    // Absent rather than zero. A zero would be indistinguishable from a real cache that was
    // silently invalidated — the same reasoning the pinned-stub provider records.
    const out = await provider(daemon(good)).generate(req);
    if ("category" in out) throw new Error("expected success");
    expect(out.usage && "cache_read_tokens" in out.usage).toBe(false);
  });

  it("hoists `system` into a turn, which is where Ollama expects it", async () => {
    let sent: any;
    const spy: typeof fetch = (async (_u: string, i: RequestInit) => {
      sent = JSON.parse(i.body as string);
      return { ok: true, status: 200, json: async () => good, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    await provider(spy).generate({ ...req, system: "you are a compiler" });
    expect(sent.messages[0]).toEqual({ role: "system", content: "you are a compiler" });
    expect(sent.messages[1]).toEqual({ role: "user", content: "hello" });
    expect(sent.stream).toBe(false);
  });
});

describe("MALFORMED_RESPONSE — the call succeeded and the model ran", () => {
  /**
   * Each of these must NOT be classified as UNAVAILABLE or INTERNAL. Those produce the demo
   * placeholder, whose text asserts "No output was produced" — false here, in the direction
   * that looks fine.
   */
  it("a 200 whose body is not JSON", async () => {
    const out = await provider(daemon(null, { json: false })).generate(req);
    expect("category" in out && out.category).toBe("MALFORMED_RESPONSE");
    expect("reason_code" in out && out.reason_code).toBe("body_not_json");
  });

  it("an envelope with no message.content", async () => {
    const out = await provider(daemon({ model: "m", done: true })).generate(req);
    expect("category" in out && out.category).toBe("MALFORMED_RESPONSE");
    expect("reason_code" in out && out.reason_code).toBe("no_content_field");
  });

  it("an empty completion", async () => {
    // A model that returns nothing has answered. Passing "" forward would let a stage record
    // an artifact that is silently blank.
    const out = await provider(daemon({ ...good, message: { content: "   \n " } })).generate(req);
    expect("category" in out && out.category).toBe("MALFORMED_RESPONSE");
    expect("reason_code" in out && out.reason_code).toBe("empty_completion");
  });

  it("all three are retriable — a resample may well parse", async () => {
    // The second real difference from AUTH, which never will. Recorded because `retriable`
    // is what an orchestrator reads to decide whether trying again is honest.
    for (const d of [
      daemon(null, { json: false }),
      daemon({ model: "m" }),
      daemon({ ...good, message: { content: "" } }),
    ]) {
      const out = await provider(d).generate(req);
      expect("retriable" in out && out.retriable).toBe(true);
    }
  });
});

describe("failures where NOTHING came back", () => {
  it("a 404 says the model is not pulled, and how to fix it", async () => {
    const out = await provider(daemon({}, { status: 404, text: "model not found" })).generate(req);
    expect("category" in out && out.category).toBe("INVALID_REQUEST");
    expect("reason_code" in out && out.reason_code).toBe("model_not_pulled");
    expect("safe_message" in out && out.safe_message).toContain("ollama pull");
  });

  it("a dead daemon is UNAVAILABLE, not MALFORMED_RESPONSE", async () => {
    const dead: typeof fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const out = await provider(dead).generate(req);
    expect("category" in out && out.category).toBe("UNAVAILABLE");
    expect("safe_message" in out && out.safe_message).toContain("Is it running?");
  });

  it("a timeout is TIMEOUT, and says slow is not broken", async () => {
    const hang: typeof fetch = (async () => {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }) as unknown as typeof fetch;
    const out = await provider(hang).generate(req);
    expect("category" in out && out.category).toBe("TIMEOUT");
    expect("safe_message" in out && out.safe_message).toContain("may simply need longer");
  });

  it("no HTTP status maps to MALFORMED_RESPONSE", async () => {
    // An error page is not a response from a model. Derived over the statuses this adapter
    // classifies rather than spot-checked, so a future branch cannot quietly add one.
    for (const status of [400, 401, 404, 409, 429, 500, 502, 503]) {
      const out = await provider(daemon({}, { status, text: "err" })).generate(req);
      expect("category" in out && out.category, `HTTP ${status}`).not.toBe("MALFORMED_RESPONSE");
    }
  });
});

describe("loopback is a boundary, not a default", () => {
  it("accepts the local spellings and rejects everything else", () => {
    for (const h of ["127.0.0.1", "localhost", "[::1]", "::1"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [
      "169.254.169.254",       // cloud metadata — the classic SSRF target
      "10.0.0.1",
      "evil.test",
      "localhost.evil.test",   // suffix trick
      "127.0.0.1.evil.test",
      "0.0.0.0",
    ]) expect(isLoopbackHost(h), h).toBe(false);
  });

  it("refuses before any request leaves", async () => {
    let called = false;
    const spy: typeof fetch = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    const out = await new OllamaProvider({ fetchImpl: spy, host: "169.254.169.254", model: "m" }).generate(req);
    expect(called, "a refused host must not be contacted").toBe(false);
    expect("reason_code" in out && out.reason_code).toBe("host_not_loopback");
  });
});

describe("the model must be named", () => {
  it("refuses with no model configured, rather than guessing one", async () => {
    delete process.env.OLLAMA_MODEL;
    const out = await new OllamaProvider({ fetchImpl: daemon(good) }).generate(req);
    expect("reason_code" in out && out.reason_code).toBe("no_model_configured");
  });

  it("reads OLLAMA_MODEL when no explicit model is given", async () => {
    process.env.OLLAMA_MODEL = "from-env";
    let sent: any;
    const spy: typeof fetch = (async (_u: string, i: RequestInit) => {
      sent = JSON.parse(i.body as string);
      return { ok: true, status: 200, json: async () => good, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await new OllamaProvider({ fetchImpl: spy }).generate(req);
    expect(sent.model).toBe("from-env");
  });

  it("an explicit model wins over the environment", async () => {
    process.env.OLLAMA_MODEL = "from-env";
    let sent: any;
    const spy: typeof fetch = (async (_u: string, i: RequestInit) => {
      sent = JSON.parse(i.body as string);
      return { ok: true, status: 200, json: async () => good, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    await new OllamaProvider({ fetchImpl: spy, model: "explicit" }).generate(req);
    expect(sent.model).toBe("explicit");
  });
});

describe("healthCheck reaches out rather than reading configuration", () => {
  it("is ok when the daemon answers and a model is named", async () => {
    const h = await provider(daemon({ models: [] })).healthCheck();
    expect(h.ok).toBe(true);
    expect(h.degradation_state).toBe("NONE");
    expect(h.failing_dependency).toBeNull();
  });

  it("blames ollama when the daemon is not there", async () => {
    // The common first-run case, and the one a configuration-only check would miss: a key
    // that is set says nothing about a daemon that is not running.
    const dead: typeof fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const h = await provider(dead).healthCheck();
    expect(h.ok).toBe(false);
    expect(h.failing_dependency).toBe("ollama");
  });

  it("blames configuration when the daemon is up but no model is named", async () => {
    delete process.env.OLLAMA_MODEL;
    const h = await new OllamaProvider({ fetchImpl: daemon({ models: [] }) }).healthCheck();
    expect(h.ok).toBe(false);
    expect(h.failing_dependency).toBe("configuration");
  });
});
