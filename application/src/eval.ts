/**
 * The evaluation runner.
 *
 * Owns the effects — provider invocation, storage, event emission — exactly as the
 * authoring orchestrator does, and calls Core for every decision that can be pure:
 * detectors score, the comparator compares, neither performs anything.
 *
 * **This is a pipeline suite, not a model evaluation, and the distinction is
 * load-bearing.** Each case pins what the provider returns, so the run is offline,
 * deterministic, and free. What it measures is whether the *pipeline* keeps its own
 * guarantees — gates fire when they should, degraded output labels itself, provenance
 * is complete, nothing is fabricated. Those are the properties that fail silently, and
 * they are the ones worth gating every change on.
 *
 * Measuring a model needs a live provider, an anchor sized to the difference being
 * claimed, and a judge whose agreement has been established. None of that is here, and
 * a run from this file must never be read as evidence about a model.
 */

import { createHash, randomUUID } from "node:crypto";
import { Orchestrator } from "./orchestrator.js";
import { scoreCase, casePassed } from "../../core/src/eval/detectors.js";
import { estimateTokens } from "../../core/src/gates/lint-primitives.js";
import { measureRecall } from "../../core/src/eval/probes.js";
import {
  admitRun, cacheKey, plannedCalls, emptyCost, accrue, hit, exceeds,
} from "../../core/src/eval/budget.js";
import { CachingProvider } from "./cache.js";
import type {
  EvalCase, EvalRun, EvalSuite, Score, Configuration, PipelineOutcome,
  GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport, RevisionStore, EventSink,
  CacheStore,
} from "../../contracts/index.js";

/** What a case pins the provider to return. Absent means the provider fails, degrading the run. */
export interface CaseStub {
  content?: string;
  fail?: boolean;
}

/**
 * A case, plus what the provider returns for it under each configuration.
 *
 * `variant_stubs` is how a second configuration is expressed without a live provider. It is
 * not a model producing worse output — it is a *declaration* of worse output, which is the
 * honest form here: what the exit gate tests is whether the harness reports a regression,
 * not whether some prompt causes one. Pinning makes the deliberateness explicit rather than
 * hiding it behind a sampled response.
 */
export type StubbedCase = EvalCase & {
  stub?: CaseStub;
  variant_stubs?: Record<string, CaseStub>;
};

/**
 * A provider whose every response is fixed by the case. Not a mock of a model — a
 * declaration that this suite is not measuring one.
 */
/**
 * Records what each call consumed, for whichever transport is underneath.
 *
 * One recorder rather than one per transport: `provider_calls` and the token totals must mean
 * the same thing whether the run was stubbed or live, and two implementations of that
 * accounting would agree the day they were written and drift afterwards.
 *
 * A failed call still pushes an entry. A failure consumed a request and on a real provider
 * can consume tokens too; recording only successes under-counted `provider_calls` by exactly
 * the number of cases a suite pins to failure, which is the kind of quiet under-count a
 * budget exists to prevent, appearing inside the budget's own accounting.
 */
class RecordingProvider implements ProviderTransport {
  readonly usages: Array<{ prompt_tokens: number; completion_tokens: number } | undefined> = [];
  calls = 0;
  constructor(private readonly inner: ProviderTransport) {}
  get provider_id(): string { return this.inner.provider_id; }

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    this.calls++;
    const out = await this.inner.generate(req);
    this.usages.push("category" in out ? undefined : {
      prompt_tokens: out.usage?.prompt_tokens ?? 0,
      completion_tokens: out.usage?.completion_tokens ?? 0,
    });
    return out;
  }

  async healthCheck() { return this.inner.healthCheck(); }
}

class PinnedProvider implements ProviderTransport {
  readonly provider_id = "pinned-stub";
  calls = 0;
  constructor(private stub: CaseStub) {}
  setStub(stub: CaseStub) { this.stub = stub; }

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    this.calls++;
    if (this.stub.fail || this.stub.content === undefined) {
      return {
        request_id: req.request_id,
        category: "UNAVAILABLE",
        retriable: false,
        reason_code: "pinned_failure",
        safe_message: "The suite pinned this case to a provider failure.",
        retry_after_ms: null,
        attempt: 1,
        provider_id: this.provider_id,
      };
    }
    /**
     * Token counts are ESTIMATED, from the same `estimateTokens` the TOKEN_BUDGET gate uses.
     *
     * A pinned provider has no real usage to report, and reporting nothing would make the
     * cost block unmeasurable rather than merely approximate. Estimating is honest here and
     * labelled as such — but a run against this provider must never be read as evidence
     * about spend, only about whether the accounting works. `cache_read_tokens` is
     * deliberately absent rather than zero: a stub has no prompt cache, and a zero would be
     * indistinguishable from a real provider whose cache is silently invalidated.
     */
    const usage = {
      prompt_tokens: estimateTokens(`${req.system ?? ""}\n${req.messages.map((m) => m.content).join("\n")}`),
      completion_tokens: estimateTokens(this.stub.content),
    };
    return {
      request_id: req.request_id,
      content: this.stub.content,
      provider_id: this.provider_id,
      model_id: "pinned",
      finish_reason: "end_turn",
      usage,
    };
  }

  async healthCheck() {
    return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "NONE" as const, failing_dependency: null };
  }
}

/** In-memory store: an evaluation run must not touch the user's revision history. */
class EphemeralStore implements RevisionStore {
  private runs = new Map<string, any[]>();
  async append(e: any) { this.runs.set(e.run_id, [...(this.runs.get(e.run_id) ?? []), e]); }
  async getRun(id: string) { return this.runs.get(id) ?? []; }
  async listRecent() { return []; }
  async markStale() { /* no history to invalidate */ }
}

export interface RunSuiteOptions {
  suite: EvalSuite;
  cases: StubbedCase[];
  configuration: Configuration;
  coreBuildHash?: string;
  sink?: EventSink;
  /** Selects `variant_stubs[variant]` per case, falling back to `stub`. Absent runs the baseline. */
  variant?: string;
  /**
   * Independent repetitions of every case. Default 1.
   *
   * Under stochastic decoding each trial is its own provider call, because that is the
   * whole point of repeating. Under deterministic decoding they collapse to one call and
   * the rest are cache hits — honestly, since the answer cannot differ.
   */
  trials?: number;
  /** Absent means no caching: every trial reaches the provider. */
  cache?: CacheStore;
  /**
   * A live provider, replacing the pinned stubs.
   *
   * Absent is the default and keeps every existing run offline, deterministic and
   * recomputable — which is what makes an `EvalRun` re-derivable from stored artifacts
   * without re-invoking anything. Supplying one is how a suite finally measures a model, and
   * `provenance.provider` records which of the two answered so a stubbed run can never be
   * read as evidence about a model.
   *
   * The caller composes it (Composition Root's job, not this function's), so caching, retry
   * and the host allowlist are all decided above this layer.
   */
  provider?: ProviderTransport;
  /** USD per million tokens. Absent leaves `cost.usd` null rather than claiming zero. */
  rate?: { in: number; out: number } | null;
}

export interface SuiteResult {
  run: EvalRun;
  scores: Score[];
  perCase: Array<{ case_id: string; passed: boolean; failure_mode: string; scores: Score[] }>;
  /** Returned so recall stays recomputable from what the run actually produced. */
  outcomes: PipelineOutcome[];
}

/** Content hash of everything that can move a result. Also the cache key. */
export function configurationId(c: Omit<Configuration, "configuration_id">): string {
  return createHash("sha256").update(JSON.stringify(c), "utf8").digest("hex");
}

export async function runSuite(opts: RunSuiteOptions): Promise<SuiteResult> {
  const { suite, cases, configuration } = opts;
  /**
   * Stubs unless a live provider was supplied. The recorder wraps whichever it is, so cost
   * accounting is identical across both and `provenance.provider` is the only thing that
   * changes — which is exactly the distinction a reader needs.
   */
  const pinned = new PinnedProvider({});
  const live = opts.provider !== undefined;
  const events: unknown[] = [];
  let tick = 0;

  const trials = Math.max(1, opts.trials ?? 1);
  const decoding = configuration.decoding;

  /**
   * Admission happens before anything is spent, and refuses rather than truncating midway.
   *
   * A partially executed suite is not an `EvalRun`: its aggregate would be a score over
   * whichever cases happened to fit, published under the name of a suite that means
   * something else. The planned count is the UNCACHED worst case, because a budget that
   * assumes a warm cache authorises a spend it cannot bound on a cold one — and the cold
   * run is the one right after a configuration changes.
   */
  const planned = plannedCalls(suite.case_ids.length, trials, decoding);
  const admission = admitRun({ budget: configuration.budget, plannedCalls: planned });
  if (!admission.admit) {
    throw new Error(
      `Suite "${suite.suite_id}" ${admission.reason}.\n` +
        `  Raise the budget on the configuration, or run a smaller suite. Nothing was spent.`,
    );
  }

  // The trial index belongs in the key only when the configuration is stochastic; Core
  // owns that rule so a cache cannot quietly make a repeated-trial protocol look like a
  // single-sample one.
  let currentCase = "";
  let currentTrial = 0;
  /**
   * Layering, innermost first: the transport (stub or live), then the recorder, then the
   * cache.
   *
   * The recorder sits INSIDE the cache deliberately. `CachingProvider` returns a hit without
   * touching what it wraps, so a hit must not count as a provider call — putting the recorder
   * outside would count every cache hit as spend and make `provider_calls` a measure of the
   * suite's size rather than of what it cost.
   */
  const recorder = new RecordingProvider(opts.provider ?? pinned);
  const caching = opts.cache
    ? new CachingProvider(recorder, {
        cache: opts.cache,
        keyFor: () => cacheKey(configuration.configuration_id, currentCase, currentTrial, decoding),
      })
    : null;
  const provider: ProviderTransport & { calls?: number } = caching ?? recorder;

  const orchestrator = new Orchestrator({
    provider,
    store: new EphemeralStore(),
    sink: opts.sink ?? { emit: (e) => events.push(e) },
    // Injected clock: an evaluation run must be reproducible, so it does not read one.
    now: () => new Date(1_760_000_000_000 + tick++ * 10),
    sleep: async () => {},
    coreBuildHash: opts.coreBuildHash ?? "eval",
  });

  const byId = new Map(cases.map((c) => [c.case_id, c]));
  const allScores: Score[] = [];
  const perCase: SuiteResult["perCase"] = [];
  const outcomes: PipelineOutcome[] = [];
  const byFailureMode: Record<string, { cases: number; passed: number }> = {};

  /** A variant that names no stub for a case falls back to the baseline stub, never to silence. */
  const stubFor = (kase: StubbedCase): CaseStub =>
    (opts.variant ? kase.variant_stubs?.[opts.variant] : undefined) ?? kase.stub ?? { fail: true };

  for (const case_id of suite.case_ids) {
    const kase = byId.get(case_id);
    if (!kase) {
      // A suite naming a case nobody wrote must fail, not silently shrink.
      const missing: Score = { case_id, detector_id: "(suite)", passed: false, detail: "case not found in suite data" };
      allScores.push(missing);
      perCase.push({ case_id, passed: false, failure_mode: "unknown", scores: [missing] });
      continue;
    }

    // A live provider answers for itself; a stub has to be told what to say.
    if (!live) pinned.setStub(stubFor(kase));
    currentCase = case_id;

    /**
     * Every trial is scored. Under deterministic decoding they are identical by
     * construction and the extra ones are cache hits; under stochastic decoding they are
     * separate calls, which is the only way a spread means anything.
     *
     * The case is recorded once, from the FIRST trial, so `aggregate.cases` still counts
     * cases rather than executions. Reporting 14 cases × 100 trials as 1,400 cases would
     * inflate every denominator in the run.
     */
    let firstScores: Score[] | null = null;
    for (let trial = 0; trial < trials; trial++) {
      currentTrial = trial;
      const outcome = await orchestrator.run({
        command_id: `eval-${case_id}-t${trial}`,
        run_id: `eval-${case_id}-t${trial}`,
        stage_id: "compile",
        input: kase.input,
        config_fingerprint: configuration.configuration_id,
      });
      const scores = scoreCase(kase, outcome);
      if (firstScores === null) {
        firstScores = scores;
        outcomes.push(outcome);
      }
    }

    const scores = firstScores ?? [];
    const passed = casePassed(scores);
    allScores.push(...scores);
    perCase.push({ case_id, passed, failure_mode: kase.failure_mode, scores });

    const slot = (byFailureMode[kase.failure_mode] ??= { cases: 0, passed: 0 });
    slot.cases++;
    if (passed) slot.passed++;
  }

  const passedCount = perCase.filter((c) => c.passed).length;

  /**
   * Cost, measured rather than declared.
   *
   * `provider_calls` and `cache_hits` come from the caching decorator, which counts what it
   * actually did. `usd` stays null unless a rate was supplied: a run whose provider reported
   * no usage must not print a dollar figure, because zero reads as free and null reads as
   * unmeasured, and those take different paths downstream.
   *
   * `budget_exceeded` was a required field holding the literal `false` since the schema
   * landed, because nothing could enforce it. It is now computed from what was spent.
   */
  const cost = (() => {
    let c = emptyCost();
    for (const u of recorder.usages) c = accrue(c, u, opts.rate ?? null);
    for (let i = 0; i < (caching?.hits ?? 0); i++) c = hit(c);
    if (!opts.rate) c = { ...c, usd: null };
    return { ...c, budget_exceeded: exceeds(c, configuration.budget) };
  })();

  const run: EvalRun = {
    run_id: randomUUID(),
    configuration_id: configuration.configuration_id,
    suite_id: suite.suite_id,
    suite_version: suite.version,
    aggregate: {
      cases: perCase.length,
      passed: passedCount,
      score: perCase.length ? passedCount / perCase.length : 0,
      by_failure_mode: byFailureMode,
    },
    cost,
    latency_ms: null,
    // Measured against this run's own outcomes, in this configuration's own output format.
    // Recall is a property of (detector, configuration), so a block measured elsewhere would
    // describe a format nobody compared.
    detector_recall: measureRecall(outcomes),
    // No judge ran. Absent means no judge was involved, never that a judge was fine.
    grader_health: null,
    scorer_provenance: {
      scorer_ids: [...new Set(cases.flatMap((c) => c.detector_ids))].sort(),
      // Deterministic detectors are not tuned on anything, so the held-out guarantee
      // that sample disjointness alone cannot give is available here by construction.
      selected_using: null,
    },
    provenance: {
      core_build_hash: opts.coreBuildHash ?? "eval",
      configuration_id: configuration.configuration_id,
      model_id: configuration.model_id,
      decoding: configuration.decoding,
      topology: configuration.topology,
      suite_version: suite.version,
      grader_id: null,
      budget: null,
      provider: provider.provider_id,
    },
  };

  return { run, scores: allScores, perCase, outcomes };
}
