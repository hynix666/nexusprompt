import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cloudRefusal,
  corpusPath,
  cleanSliceCases,
  buildPrecisionCorpus,
  main,
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
        log: () => {},
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

  it("writes the model's file when nothing refuses", async () => {
    const d = deps();
    expect(await main(["--model", "llama3.1:8b"], d.deps)).toBe(0);
    expect(d.written).toEqual(["eval/precision-corpus/llama3.1_8b.json"]);
  });
});
