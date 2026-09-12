import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cloudRefusal,
  corpusPath,
  cleanSliceCases,
  buildPrecisionCorpus,
  main,
  PinnedHostedModel,
  ProgressLogger,
} from "../scripts/build-precision-corpus.js";
import type {
  GenerationRequest, GenerationResult, ProviderFailure, ProviderHealth, ProviderTransport,
} from "../contracts/index.js";

/**
 * The precision corpus builder (Phase 9, Task 2).
 *
 * Nothing here needs the Ollama daemon: the provider is injected. The corpus is the one input
 * to precision that CI can never regenerate, so what is tested is everything around the model
 * call — which briefs are asked, what is kept, what is refused before anything runs.
 */

const pilotBriefs = new Set<string>(
  JSON.parse(readFileSync("eval/brief-pilot.json", "utf8")).cases.map((c: { input: { brief: string } }) => c.input.brief),
);

/** Answers every brief with a fixed system prompt, or fails the briefs `failWhen` picks. */
class FakeOllama implements ProviderTransport {
  readonly provider_id = "ollama-local";
  calls = 0;
  constructor(private readonly failWhen: (req: GenerationRequest) => boolean = () => false) {}
  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    this.calls += 1;
    if (this.failWhen(req)) {
      return { request_id: req.request_id, category: "UNAVAILABLE", reason_code: "connection_failed",
               safe_message: "down", retriable: false, retry_after_ms: null, attempt: 1, provider_id: this.provider_id };
    }
    return { request_id: req.request_id, content: "# SYSTEM PROMPT\n\nScope: billing only.", provider_id: this.provider_id,
             model_id: "fake:1b", finish_reason: "stop" };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0, degradation_state: "NONE",
             failing_dependency: null };
  }
}

describe("which models may build a corpus", () => {
  it("refuses a model Ollama runs off this machine", () => {
    // `:cloud` tags are proxied to a hosted service: the briefs would leave the machine and the
    // run would stop being zero-spend. The name is the only signal the daemon's list gives.
    for (const m of ["glm-5.2:cloud", "gpt-oss:120b-cloud", "gemma4:31b-cloud"]) {
      expect(cloudRefusal(m), m).toMatch(/off this machine/);
    }
  });

  it("accepts the four local models the owner chose", () => {
    for (const m of ["llama3.1:8b", "phi4-mini:latest", "qwen3.8:27b", "qwen3-coder:30b"]) {
      expect(cloudRefusal(m), m).toBeNull();
    }
  });

  it("gives each model its own file, so adding one never rewrites another", () => {
    expect(corpusPath("qwen3-coder:30b")).toBe("eval/precision-corpus/qwen3-coder_30b.json");
    expect(corpusPath("phi4-mini:latest")).not.toBe(corpusPath("phi4-mini:3.8b"));
  });
});

describe("the clean slice", () => {
  const clean = cleanSliceCases(pilotBriefs);

  it("holds 100 briefs with nothing planted", () => {
    expect(clean).toHaveLength(100);
    // A structure-shape brief is purpose, audience and requirements — no credential, no
    // stand-in token. Those two shapes are the only ones brief-pilot plants anything in.
    for (const c of clean) {
      expect(c.input.brief).not.toMatch(/authenticates with|\{\{|<<|\[\[/);
      expect(c.case_id).toMatch(/^clean-\d{4}$/);
    }
  });

  it("repeats no brief, and shares none with brief-pilot", () => {
    // 512 structure briefs are possible, so a repeat is a real risk. A repeated brief would
    // count one model answer twice, and an overlap would make the two slices not independent.
    const briefs = clean.map((c) => c.input.brief);
    expect(new Set(briefs).size).toBe(100);
    expect(briefs.filter((b) => pilotBriefs.has(b))).toEqual([]);
  });

  it("is the same 100 on every call", () => {
    expect(cleanSliceCases(pilotBriefs).map((c) => c.case_id + c.input.brief))
      .toEqual(clean.map((c) => c.case_id + c.input.brief));
  });
});

describe("building a model's corpus", () => {
  it("keeps one record per brief, in both slices, with a hash that matches its text", async () => {
    const provider = new FakeOllama();
    const file = await buildPrecisionCorpus({ model: "fake:1b", provider, generatedAt: "2026-09-11T00:00:00.000Z" });
    expect(file.records.filter((r) => r.slice === "pilot")).toHaveLength(100);
    expect(file.records.filter((r) => r.slice === "clean")).toHaveLength(100);
    expect(file.excluded).toEqual([]);
    for (const r of file.records) {
      expect(r.output_sha256).toBe(createHash("sha256").update(r.text, "utf8").digest("hex"));
      expect(r.model).toBe("fake:1b");
    }
    expect(provider.calls).toBe(200);
  });

  it("excludes a degraded answer and says which, rather than keeping a placeholder as a prompt", async () => {
    // A demo placeholder is not a compiled prompt. Kept, every gate would be measured on text
    // no model wrote; dropped silently, the corpus would look complete when it is not.
    const provider = new FakeOllama((req) => (req.messages[0]?.content ?? "").includes("billing"));
    const file = await buildPrecisionCorpus({ model: "fake:1b", provider, generatedAt: "2026-09-11T00:00:00.000Z" });
    expect(file.excluded.length).toBeGreaterThan(0);
    expect(file.records.length + file.excluded.length).toBe(200);
    for (const r of file.records) expect(r.text).not.toMatch(/WORKFLOW DEMO/);
    for (const e of file.excluded) expect(e).toMatchObject({ case_id: expect.any(String), slice: expect.any(String) });
    // Degraded covers a truncated or malformed answer too, where the model DID respond
    // (ADR-0014); the outcome does not carry which, so the reason must not claim silence.
    for (const e of file.excluded) expect(e.reason).not.toMatch(/did not answer/);
  });
});

describe("refusals, before any model is asked", () => {
  const deps = (over: Partial<Parameters<typeof main>[1]> = {}) => {
    const provider = new FakeOllama();
    const written: string[] = [];
    return {
      provider,
      written,
      deps: {
        makeProvider: () => provider,
        fileExists: () => false,
        writeFile: (p: string) => { written.push(p); },
        log: (_: string) => {},
        env: {} as Record<string, string | undefined>,
        now: () => "2026-09-11T00:00:00.000Z",
        ...over,
      },
    };
  };

  it("refuses without a model named", async () => {
    const d = deps();
    expect(await main([], d.deps)).toBe(2);
    expect(d.provider.calls).toBe(0);
  });

  it("refuses a cloud model", async () => {
    const d = deps();
    expect(await main(["--model", "glm-5.2:cloud"], d.deps)).toBe(2);
    expect(d.provider.calls).toBe(0);
  });

  it("refuses to overwrite a model's corpus without --force", async () => {
    // Regenerating is not refreshing: a stochastic model writes a different corpus, and every
    // adjudication made against the old one would silently stop describing what is on disk.
    const d = deps({ fileExists: () => true });
    expect(await main(["--model", "llama3.1:8b"], d.deps)).toBe(2);
    expect(d.provider.calls).toBe(0);
    expect(d.written).toEqual([]);
  });

  it("refuses when the daemon does not answer", async () => {
    const d = deps();
    d.provider.healthCheck = async () => ({ ok: false, checked_at: "", latency_ms: 0,
      degradation_state: "UNAVAILABLE" as const, failing_dependency: "ollama" });
    expect(await main(["--model", "llama3.1:8b"], d.deps)).toBe(2);
    expect(d.provider.calls).toBe(0);
  });

  it("writes the model's file when nothing refuses, reporting every brief on the way", async () => {
    const lines: string[] = [];
    const d = deps({ log: (l: string) => lines.push(l) });
    expect(await main(["--model", "llama3.1:8b"], d.deps)).toBe(0);
    expect(d.written).toEqual(["eval/precision-corpus/llama3.1_8b.json"]);
    // The wiring, not just the decorator: 200 briefs, 200 progress lines, the last one numbered.
    expect(lines.filter((l) => /^\s+\[\s*\d+\/200\]/.test(l))).toHaveLength(200);
    expect(lines.some((l) => l.includes("[200/200]"))).toBe(true);
  });

  it("refuses --hosted without the endpoint's key and base URL, and never prints either", async () => {
    // A hosted run sends every brief off this machine; it is opted into by flag and by the
    // operator's own environment, never by a value typed into a command or committed file.
    const lines: string[] = [];
    const d = deps({ env: { COMPATIBLE_OPENAI_BASE_URL: "https://integrate.api.nvidia.com/v1" }, log: (l: string) => { lines.push(l); } });
    expect(await main(["--model", "nvidia/nemotron-3-super-120b-a12b", "--hosted"], d.deps)).toBe(2);
    expect(d.provider.calls).toBe(0);
    expect(lines.join("\n")).toMatch(/COMPATIBLE_OPENAI_API_KEY/);
    expect(lines.join("\n")).not.toMatch(/integrate\.api\.nvidia\.com/);
  });

  it("records which endpoint answered a hosted run, and nothing extra for a local one", async () => {
    // A hosted fingerprint is `hosted-server:<model>` whichever endpoint served it, so a
    // reseller's proxied model and the maker's own would be indistinguishable without this.
    const texts: string[] = [];
    const hostedEnv = { COMPATIBLE_OPENAI_API_KEY: "k", COMPATIBLE_OPENAI_BASE_URL: "https://kiraai.vn/api/v1" };
    const h = deps({ env: hostedEnv, writeFile: (_p: string, t: string) => { texts.push(t); } });
    await main(["--model", "glm-5.3-free", "--hosted"], h.deps);
    const l = deps({ writeFile: (_p: string, t: string) => { texts.push(t); } });
    await main(["--model", "llama3.1:8b"], l.deps);
    expect(JSON.parse(texts[0]).endpoint).toBe("kiraai.vn");
    expect("endpoint" in JSON.parse(texts[1])).toBe(false);
    expect(texts[0]).not.toMatch(/"k"/);
  });

  it("checks a hosted endpoint with one real request, not the adapter's model-metadata probe", async () => {
    // Measured 11 September 2026: NVIDIA answers /models/<id> only with the slash unencoded,
    // and kiraai.vn has no per-model route at all, so the metadata probe would refuse both.
    // One real request through the same path proves key, model id and route together.
    const hostedEnv = { COMPATIBLE_OPENAI_API_KEY: "k", COMPATIBLE_OPENAI_BASE_URL: "https://kiraai.vn/api/v1" };
    const failing = deps({ env: hostedEnv });
    failing.provider.healthCheck = async () => ({ ok: false, checked_at: "", latency_ms: 0,
      degradation_state: "UNAVAILABLE" as const, failing_dependency: "COMPATIBLE" });
    expect(await main(["--model", "glm-5.3-free", "--hosted"], failing.deps)).toBe(0);

    const down = new FakeOllama(() => true);
    const refused = deps({ env: hostedEnv, makeProvider: () => down });
    expect(await main(["--model", "glm-5.3-free", "--hosted"], refused.deps)).toBe(2);
    expect(down.calls).toBe(1);
    expect(refused.written).toEqual([]);
  });

  it("writes a hosted model's file under a path its slash cannot escape", async () => {
    const d = deps({ env: { COMPATIBLE_OPENAI_API_KEY: "k", COMPATIBLE_OPENAI_BASE_URL: "https://integrate.api.nvidia.com/v1" } });
    expect(await main(["--model", "nvidia/nemotron-3-super-120b-a12b", "--hosted"], d.deps)).toBe(0);
    expect(d.written).toEqual(["eval/precision-corpus/nvidia_nemotron-3-super-120b-a12b.json"]);
  });
});

describe("progress, so a stalled run is visible while it runs", () => {
  // glm-5.3-free was abandoned after 3h41m having written nothing, and b.ai and orcarouter
  // both stopped answering mid-run without a sign until the file landed hours later. The
  // builder writes its corpus only at the end, so the provider call is the only per-brief event.
  const req = (case_id: string): GenerationRequest => ({
    request_id: "r", run_id: `eval-${case_id}-t0`, idempotency_key: "r",
    messages: [{ role: "user", content: "brief" }],
    model_policy: { preferred_models: ["m"], allow_fallback: false },
    generation_options: { max_tokens: 100, effort: "medium" },
  });

  it("logs one line per answer, numbered against the total, naming the brief", async () => {
    const lines: string[] = [];
    const p = new ProgressLogger(new FakeOllama(), 200, (l) => lines.push(l));
    await p.generate(req("brief-secret-0000"));
    await p.generate(req("clean-0041"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("1/200");
    expect(lines[0]).toContain("brief-secret-0000");
    expect(lines[1]).toContain("2/200");
    expect(lines[1]).toContain("clean-0041");
  });

  it("names the failure category, which is what a dying endpoint looks like", async () => {
    const lines: string[] = [];
    const p = new ProgressLogger(new FakeOllama(() => true), 200, (l) => lines.push(l));
    await p.generate(req("brief-secret-0000"));
    expect(lines[0]).toContain("UNAVAILABLE");
    expect(lines[0]).toContain("connection_failed");
  });

  it("keeps counting past the total rather than pretending, because a retry is another call", async () => {
    const lines: string[] = [];
    const p = new ProgressLogger(new FakeOllama(), 2, (l) => lines.push(l));
    for (const c of ["a", "b", "c"]) await p.generate(req(c));
    expect(lines[2]).toContain("3/2");
  });

  it("passes the answer through untouched", async () => {
    const inner = new FakeOllama();
    const out = await new ProgressLogger(inner, 1, () => {}).generate(req("x"));
    expect("content" in out && out.content).toContain("SYSTEM PROMPT");
    expect(inner.calls).toBe(1);
  });
});

describe("a hosted model, driven from the composition root", () => {
  const request = (): GenerationRequest => ({
    request_id: "r", run_id: "run", messages: [{ role: "user", content: "brief" }],
    model_policy: { preferred_models: ["claude-opus-5"], allow_fallback: true },
    generation_options: { max_tokens: 100, effort: "medium" }, idempotency_key: "r",
  });

  it("asks for the model named, not the one Core writes into every request", async () => {
    // core/src/stages/stage-kit.ts names claude-opus-5 on every request; the hosted adapter
    // sends preferred_models[0]. Unpinned, NVIDIA would be asked for a Claude model.
    const seen: GenerationRequest[] = [];
    const inner = new FakeOllama();
    const spy: ProviderTransport = { provider_id: "hosted", healthCheck: () => inner.healthCheck(),
      generate: (r) => { seen.push(r); return inner.generate(r); } };
    const pinned = new PinnedHostedModel(spy, "nvidia/nemotron-3-super-120b-a12b", { minIntervalMs: 0 });
    await pinned.generate(request());
    expect(seen[0].model_policy).toEqual({ preferred_models: ["nvidia/nemotron-3-super-120b-a12b"], allow_fallback: false });
  });

  it("spaces calls so the adapter's own 12-per-minute limit is never the reason a brief is excluded", async () => {
    // runSuite's retries do not wait, so a rate-limited call fails for good and its brief is
    // dropped as degraded — a corpus thinned by the limiter rather than by the model.
    let clock = 0;
    const slept: number[] = [];
    const pinned = new PinnedHostedModel(new FakeOllama(), "m", {
      minIntervalMs: 5_100, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
    });
    await pinned.generate(request());
    clock += 1_000; // the first answer took a second
    await pinned.generate(request());
    expect(slept).toEqual([4_100]);
  });
});
