import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runSuite, configurationId, type StubbedCase } from "../src/eval.js";
import { MemoryCacheStore } from "../src/cache.js";
import type { Configuration, EvalSuite } from "../../contracts/index.js";

/**
 * The execution plane: caching, budget, and cost that is measured rather than declared.
 *
 * `eval-run.cost` has carried `budget_exceeded` as a required field since the schema landed,
 * and it has always been the literal `false` because nothing could enforce a budget. These
 * are the tests that make it capable of being true.
 *
 * Everything here runs against pinned stubs, so the token counts are estimates and the
 * dollar figures are arithmetic over estimates. What is under test is whether the ACCOUNTING
 * works — not what anything costs.
 */

const data: { suite: EvalSuite; cases: StubbedCase[] } =
  JSON.parse(readFileSync("eval/compile-smoke.json", "utf8"));

const CASES = data.suite.case_ids.length;
/**
 * Cases pinned to a provider failure — two of fourteen, both about degraded runs.
 *
 * They matter to every cost assertion here because FAILURES ARE NEVER CACHED: a
 * ProviderFailure is a statement about the provider at a moment, not about the request,
 * and caching one would turn a transient outage into a permanent answer — pinning a run to
 * the demo placeholder for as long as the cache lived. The consequence is worth naming:
 * caching cannot reduce the cost of a case that fails, so a suite full of failing cases
 * stays expensive to repeat.
 */
const FAILING = data.cases
  .filter((c) => data.suite.case_ids.includes(c.case_id))
  .filter((c) => !c.stub || c.stub.fail || c.stub.content === undefined).length;
const CACHEABLE = CASES - FAILING;

const base = {
  prompt_template_ref: "core/src/stages/compile.ts",
  model_id: "pinned",
  topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
  retrieval_config: null,
  tool_config: null,
  gate_set_ref: "scripts/ported-gates.json",
  router_policy_ref: null,
};

const config = (over: Partial<Configuration> = {}): Configuration => {
  const c = { ...base, decoding: { temperature: 0, seed: 1 }, ...over } as Omit<Configuration, "configuration_id">;
  return { configuration_id: configurationId(c), ...c } as Configuration;
};

const run = (over: Partial<Configuration>, rest: Record<string, unknown> = {}) =>
  runSuite({ suite: data.suite, cases: data.cases, configuration: config(over), ...rest });

describe("caching makes repeated trials affordable — without faking them", () => {
  it("collapses trials to one call per case when decoding is deterministic", async () => {
    // Temperature 0: every trial must produce the same answer, so a lookup is honest.
    const { run: r } = await run(
      { decoding: { temperature: 0, seed: 1 } },
      { trials: 100, cache: new MemoryCacheStore() },
    );
    // One call per cacheable case, plus every trial of the ones pinned to fail.
    expect(r.cost.provider_calls).toBe(CACHEABLE + FAILING * 100);
    expect(r.cost.cache_hits).toBe(CACHEABLE * 99);
    // The spec's DONE WHEN, stated as the inequality it actually is.
    expect(r.cost.provider_calls).toBeLessThan(CASES * 100);
  });

  it("does NOT collapse trials when decoding is stochastic", async () => {
    /**
     * The correction to ADR-0008, pinned.
     *
     * The ADR specifies the cache key as `(config_hash, case_hash)` and says that key is
     * "what makes 100-trial protocols affordable". Both cannot hold: a repeated-trial
     * protocol exists because decoding is stochastic, so keying on config and case alone
     * makes trials 2..100 cache hits of trial 1 — one sample reported as a hundred, with a
     * measured variance of exactly zero and a confident interval around it.
     *
     * Ten trials rather than a hundred, because the point is the ratio, not the bill.
     */
    const { run: r } = await run(
      { decoding: { temperature: 0.7, seed: null } },
      { trials: 10, cache: new MemoryCacheStore() },
    );
    expect(r.cost.provider_calls).toBe(CASES * 10);
    expect(r.cost.cache_hits).toBe(0);
  });

  it("still pays across runs, which is where a stochastic config gets its saving", async () => {
    const cache = new MemoryCacheStore();
    const cfg = { decoding: { temperature: 0, seed: 1 } };
    const first = await run(cfg, { trials: 1, cache });
    const second = await run(cfg, { trials: 1, cache });
    expect(first.run.cost.provider_calls).toBe(CASES);
    // Only the failing cases still reach the provider on a warm second run.
    expect(second.run.cost.provider_calls).toBe(FAILING);
    expect(second.run.cost.cache_hits).toBe(CACHEABLE);
  });

  it("reaches the provider every trial when no cache is supplied", async () => {
    const { run: r } = await run({ decoding: { temperature: 0, seed: 1 } }, { trials: 3 });
    expect(r.cost.provider_calls).toBe(CASES * 3);
    expect(r.cost.cache_hits).toBe(0);
  });

  it("counts cases, not executions", async () => {
    // 14 cases × 100 trials is still 14 cases. Reporting 1,400 would inflate every
    // denominator in the run and make the score meaningless.
    const { run: r } = await run(
      { decoding: { temperature: 0, seed: 1 } },
      { trials: 100, cache: new MemoryCacheStore() },
    );
    expect(r.aggregate.cases).toBe(CASES);
  });
});

describe("budget is enforced before dispatch, not reported after", () => {
  it("refuses to start, and spends nothing", async () => {
    await expect(
      run(
        { decoding: { temperature: 0.7, seed: null }, budget: { on_exceed: "refuse", max_provider_calls: 5 } },
        { trials: 10 },
      ),
    ).rejects.toThrow(/refused before dispatch/);
  });

  it("names what it refused on", async () => {
    await expect(
      run({ budget: { on_exceed: "refuse", max_provider_calls: 2 } }),
    ).rejects.toThrow(/max_provider_calls 2/);
  });

  it("admits a run that fits", async () => {
    const { run: r } = await run({ budget: { on_exceed: "refuse", max_provider_calls: CASES } });
    expect(r.cost.provider_calls).toBe(CASES);
    expect(r.cost.budget_exceeded).toBe(false);
  });

  it("prices the UNCACHED worst case, so a warm cache cannot authorise a cold run", async () => {
    // The budget is checked against what the run might cost, not what it will cost if the
    // cache happens to be warm — and the cold run is the one right after a config change.
    const cache = new MemoryCacheStore();
    await expect(
      run(
        { decoding: { temperature: 0.7, seed: null }, budget: { on_exceed: "refuse", max_provider_calls: CASES } },
        { trials: 4, cache },
      ),
    ).rejects.toThrow(/refused before dispatch/);
  });

  it("runs without a budget rather than inventing one", async () => {
    const { run: r } = await run({});
    expect(r.cost.budget_exceeded).toBe(false);
  });
});

describe("cost is measured", () => {
  it("reports real token counts rather than zeros", async () => {
    const { run: r } = await run({});
    expect(r.cost.tokens_in).toBeGreaterThan(0);
    expect(r.cost.tokens_out).toBeGreaterThan(0);
  });

  it("leaves usd null when no rate is known, rather than claiming zero", async () => {
    // The field was the literal 0 before this. Zero reads as free.
    const { run: r } = await run({});
    expect(r.cost.usd).toBeNull();
  });

  it("computes usd when a rate is supplied", async () => {
    const { run: r } = await run({}, { rate: { in: 3, out: 15 } });
    expect(r.cost.usd).toBeGreaterThan(0);
  });

  it("validates against the eval-run contract with a populated cost block", async () => {
    const { run: r } = await run({}, { rate: { in: 3, out: 15 } });
    expect(Object.keys(r.cost).sort()).toEqual(
      ["budget_exceeded", "cache_hits", "provider_calls", "tokens_in", "tokens_out", "usd"],
    );
  });
});

/**
 * The live-provider seam.
 *
 * Until this existed, `runSuite` hard-coded its stubs, so the evaluation plane could not
 * reach a model however the rest of the system was configured. These tests are about the
 * seam being real AND the default staying offline — the second half matters more, because
 * an `EvalRun` is only recomputable from stored artifacts while nothing in it phoned out.
 */
describe("a suite can run against a live provider", () => {
  /** A transport that answers without a network, standing in for the real adapter. */
  class ScriptedProvider {
    readonly provider_id = "scripted-live";
    calls = 0;
    constructor(private readonly tokens = { prompt_tokens: 7, completion_tokens: 11 }) {}
    async generate(req: { request_id: string }) {
      this.calls++;
      return {
        request_id: req.request_id,
        content: "# SYSTEM PROMPT\n\nScope: billing only.",
        provider_id: this.provider_id,
        model_id: "scripted-1",
        finish_reason: "end_turn" as const,
        usage: this.tokens,
      };
    }
    async healthCheck() {
      return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
               degradation_state: "NONE" as const, failing_dependency: null };
    }
  }

  it("uses the injected provider, and records which one answered", async () => {
    const provider = new ScriptedProvider();
    const { run: evalRun } = await run({}, { provider });
    expect(provider.calls).toBe(CASES);
    // The distinction a reader needs: a stubbed run must never be mistaken for a live one.
    expect(evalRun.provenance.provider).toBe("scripted-live");
  });

  it("defaults to the pinned stub and touches nothing", async () => {
    // The must-not-fire half. If the default ever became live, every existing suite would
    // start spending money and stop being reproducible, silently.
    const { run: evalRun } = await run({});
    expect(evalRun.provenance.provider).toBe("pinned-stub");
  });

  it("accounts for a live provider's real usage rather than an estimate", async () => {
    const provider = new ScriptedProvider({ prompt_tokens: 100, completion_tokens: 200 });
    const { run: evalRun } = await run({}, { provider });
    // Every case succeeds here, so the totals are exactly cases x the reported usage.
    expect(evalRun.cost.tokens_in).toBe(100 * CASES);
    expect(evalRun.cost.tokens_out).toBe(200 * CASES);
    expect(evalRun.cost.provider_calls).toBe(CASES);
  });

  it("does not count a cache hit as a provider call", async () => {
    /**
     * The recorder sits INSIDE the cache for this reason. Outside it, every hit would be
     * counted as spend and `provider_calls` would measure the suite's size rather than what
     * it cost — which is the number a budget is enforced against.
     */
    const provider = new ScriptedProvider();
    const cache = new MemoryCacheStore();
    const first = await run({}, { provider, cache });
    const callsAfterFirst = provider.calls;
    const second = await run({}, { provider, cache });

    expect(callsAfterFirst).toBe(CASES);
    // The second run answers entirely from cache: the transport is never reached again.
    expect(provider.calls).toBe(callsAfterFirst);
    expect(second.run.cost.provider_calls).toBe(0);
    expect(second.run.cost.cache_hits).toBe(CASES);
    expect(first.run.aggregate.score).toBe(second.run.aggregate.score);
  });
});
