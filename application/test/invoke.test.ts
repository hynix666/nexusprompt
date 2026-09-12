import { describe, it, expect } from "vitest";
import { invokeWithRetry } from "../src/invoke.js";
import { runSuite } from "../src/eval.js";
import type { GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport } from "../../contracts/index.js";

/**
 * `invokeWithRetry` is the Application's single provider call, so it is where the two
 * unsupported shapes the Phase 8 spec deferred (§7, §8) have to be refused — and where an
 * adapter that throws has to become a value.
 *
 * None of this is reachable from a Shell today: nothing outside Core builds a
 * `model_policy`, and every first-party adapter returns a typed failure from every catch. The
 * guard sits at the boundary those inputs would arrive through, which is the only place that
 * stays true when a Shell or a third-party adapter is added.
 */

const request = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  request_id: "r", run_id: "run", idempotency_key: "r",
  messages: [{ role: "user", content: "brief" }],
  model_policy: { preferred_models: ["claude-opus-5"], allow_fallback: true },
  generation_options: { max_tokens: 100, effort: "medium" },
  ...over,
});

const ok = (): GenerationResult => ({
  request_id: "r", content: "# SYSTEM PROMPT", provider_id: "p", model_id: "m", finish_reason: "stop",
});

class Provider implements ProviderTransport {
  readonly provider_id = "p";
  calls = 0;
  constructor(private readonly behaviour: (n: number) => GenerationResult | ProviderFailure | never = () => ok()) {}
  async generate(): Promise<GenerationResult | ProviderFailure> {
    this.calls += 1;
    return this.behaviour(this.calls);
  }
  async healthCheck() {
    return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "NONE" as const, failing_dependency: null };
  }
}

const opts = (provider: ProviderTransport, maxAttempts = 3) => ({
  provider, maxAttempts, now: () => new Date(0), sleep: async () => {},
});

describe("an adapter that throws becomes a typed failure (Phase 8 spec, exception normalization)", () => {
  it("returns a failure instead of propagating the exception", async () => {
    // Every first-party adapter catches today. A future one, a decorator, or an injected test
    // double need not, and an exception here bypasses retry classification entirely: the
    // pipeline catches it outside the loop and marks the stage failed without a category.
    const provider = new Provider(() => { throw new Error("socket hang up at 10.0.0.4:443"); });
    const { outcome } = await invokeWithRetry(request(), opts(provider));
    expect("category" in outcome && outcome.category).toBe("INTERNAL");
    expect("reason_code" in outcome && outcome.reason_code).toBe("adapter_threw");
  });

  it("does not put the exception's text in the failure", async () => {
    // #169: the hosted-judge adapter leaked upstream error text into a failure message. An
    // exception message is the likeliest place for a host, a path or a key fragment to appear.
    const provider = new Provider(() => { throw new Error("401 from https://api.example/v1?key=sk-secret"); });
    const { outcome } = await invokeWithRetry(request(), opts(provider));
    const rendered = JSON.stringify(outcome);
    expect(rendered).not.toMatch(/sk-secret|api\.example/);
    expect("safe_message" in outcome && outcome.safe_message).toMatch(/threw/i);
  });

  it("does not retry it, because an adapter defect is not a transient condition", async () => {
    const provider = new Provider(() => { throw new Error("boom"); });
    const { outcome, attempts } = await invokeWithRetry(request(), opts(provider, 3));
    expect(provider.calls).toBe(1);
    expect(attempts).toBe(1);
    expect("retriable" in outcome && outcome.retriable).toBe(false);
  });

  it("reports the thrown attempt to the observer like any other failure", async () => {
    const seen: string[] = [];
    const provider = new Provider(() => { throw new Error("boom"); });
    await invokeWithRetry(request(), { ...opts(provider), onAttempt: (a) => seen.push(a.phase) });
    expect(seen).toEqual(["started", "failed"]);
  });

  it("still succeeds and still retries when the adapter behaves", async () => {
    const flaky = new Provider((n) =>
      n === 1
        ? { request_id: "r", category: "TIMEOUT", reason_code: "timeout", safe_message: "slow",
            retriable: true, retry_after_ms: 1, attempt: 1, provider_id: "p" }
        : ok());
    const { outcome, attempts } = await invokeWithRetry(request(), opts(flaky));
    expect("content" in outcome).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe("a routing policy is refused rather than accepted and ignored (Phase 8 spec §8)", () => {
  const suite = {
    suite_id: "s", version: "1.0.0", kind: "smoke" as const, case_ids: ["c"],
    resolution: { detectable_delta: 1, confidence: 0.95 },
    significance_protocol: "exact-mcnemar" as const,
  };
  const cases = [{
    case_id: "c", input: { brief: "a billing assistant" },
    expectation: { kind: "predicate" as const, value: "SYSTEM" },
    failure_mode: "constraint-violation" as const, detector_ids: ["output-nonempty"],
    stub: { content: "# SYSTEM PROMPT" },
  }];
  const configuration = (router_policy_ref: string | null) => ({
    configuration_id: "cfg", prompt_template_ref: "core/src/stages/compile.ts", model_id: "pinned",
    decoding: { temperature: null, seed: null },
    topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
    retrieval_config: null, tool_config: null, gate_set_ref: "scripts/ported-gates.json",
    router_policy_ref, budget: null,
  });

  it("refuses a run whose configuration names a router", async () => {
    // core/src/routing/policy.ts is not wired to the pipeline. Accepting the reference would
    // hash it into the configuration_id and attribute the run to a router that never ran.
    await expect(runSuite({ suite, cases, configuration: configuration("router-v2") }))
      .rejects.toThrow(/router_policy_ref/);
  });

  it("runs when no router is named, which is every configuration this repository builds", async () => {
    const result = await runSuite({ suite, cases, configuration: configuration(null) });
    expect(result.outcomes).toHaveLength(1);
  });
});

describe("model fallback is refused rather than pretended (Phase 8 spec §7)", () => {
  it("refuses several preferred models with fallback allowed, before any call", async () => {
    // Fallback needs retry classification, aggregate call-budget accounting, idempotency and
    // provenance for WHICH model answered. None of that exists, and an adapter silently using
    // preferred_models[0] would report a run against a model the caller did not get.
    const provider = new Provider();
    const { outcome } = await invokeWithRetry(
      request({ model_policy: { preferred_models: ["a", "b"], allow_fallback: true } }),
      opts(provider),
    );
    expect("category" in outcome && outcome.category).toBe("INVALID_REQUEST");
    expect("reason_code" in outcome && outcome.reason_code).toBe("fallback_not_implemented");
    expect(provider.calls).toBe(0);
  });

  it("allows the shape Core actually builds: one model, fallback flag set", async () => {
    // core/src/stages/stage-kit.ts names one model and sets allow_fallback true on EVERY
    // request. Refusing that would refuse the whole pipeline.
    const provider = new Provider();
    const { outcome } = await invokeWithRetry(request(), opts(provider));
    expect("content" in outcome).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it("allows several models when fallback is not requested", async () => {
    // Adapters take preferred_models[0]; the rest are inert. That is a narrower claim than
    // fallback and is left alone here — this guard is about the combination the spec names.
    const provider = new Provider();
    const { outcome } = await invokeWithRetry(
      request({ model_policy: { preferred_models: ["a", "b"], allow_fallback: false } }),
      opts(provider),
    );
    expect("content" in outcome).toBe(true);
  });
});
