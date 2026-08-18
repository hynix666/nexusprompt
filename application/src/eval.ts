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
import type {
  EvalCase, EvalRun, EvalSuite, Score, Configuration,
  GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport, RevisionStore, EventSink,
} from "../../contracts/index.js";

/** What a case pins the provider to return. Absent means the provider fails, degrading the run. */
export interface CaseStub {
  content?: string;
  fail?: boolean;
}

export type StubbedCase = EvalCase & { stub?: CaseStub };

/**
 * A provider whose every response is fixed by the case. Not a mock of a model — a
 * declaration that this suite is not measuring one.
 */
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
    return {
      request_id: req.request_id,
      content: this.stub.content,
      provider_id: this.provider_id,
      model_id: "pinned",
      finish_reason: "end_turn",
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
}

export interface SuiteResult {
  run: EvalRun;
  scores: Score[];
  perCase: Array<{ case_id: string; passed: boolean; failure_mode: string; scores: Score[] }>;
}

/** Content hash of everything that can move a result. Also the cache key. */
export function configurationId(c: Omit<Configuration, "configuration_id">): string {
  return createHash("sha256").update(JSON.stringify(c), "utf8").digest("hex");
}

export async function runSuite(opts: RunSuiteOptions): Promise<SuiteResult> {
  const { suite, cases, configuration } = opts;
  const provider = new PinnedProvider({});
  const events: unknown[] = [];
  let tick = 0;

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
  const byFailureMode: Record<string, { cases: number; passed: number }> = {};

  for (const case_id of suite.case_ids) {
    const kase = byId.get(case_id);
    if (!kase) {
      // A suite naming a case nobody wrote must fail, not silently shrink.
      const missing: Score = { case_id, detector_id: "(suite)", passed: false, detail: "case not found in suite data" };
      allScores.push(missing);
      perCase.push({ case_id, passed: false, failure_mode: "unknown", scores: [missing] });
      continue;
    }

    provider.setStub(kase.stub ?? { fail: true });
    const outcome = await orchestrator.run({
      command_id: `eval-${case_id}`,
      run_id: `eval-${case_id}`,
      stage_id: "compile",
      input: kase.input,
      config_fingerprint: configuration.configuration_id,
    });

    const scores = scoreCase(kase, outcome);
    const passed = casePassed(scores);
    allScores.push(...scores);
    perCase.push({ case_id, passed, failure_mode: kase.failure_mode, scores });

    const slot = (byFailureMode[kase.failure_mode] ??= { cases: 0, passed: 0 });
    slot.cases++;
    if (passed) slot.passed++;
  }

  const passedCount = perCase.filter((c) => c.passed).length;

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
    cost: {
      tokens_in: 0,
      tokens_out: 0,
      provider_calls: provider.calls,
      cache_hits: 0,
      usd: 0,
      budget_exceeded: false,
    },
    latency_ms: null,
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

  return { run, scores: allScores, perCase };
}
