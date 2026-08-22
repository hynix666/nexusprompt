/**
 * A suite that measures the PIPELINE, not one stage of it.
 *
 * Phase β found the gap the hard way. `eval/compile-smoke.json` calls
 * `orchestrator.run({ stage_id: "compile" })` — the single-stage path — so it cannot
 * observe anything the eleven-stage runner does: not the depth plan, not a skip, not the
 * gate-feedback loop, not a degradation partway through. A change to the pipeline's shape
 * was invisible to every suite that existed, which meant Phase β shipped a mechanism whose
 * effect nothing could price.
 *
 * This runs `runPipeline` per case and scores the result. Two design choices carry it:
 *
 * **The result is projected into a `PipelineOutcome`.** Every detector in
 * `core/src/eval/detectors.ts` already scores that shape, and they are the detectors whose
 * recall has been measured against the mutation-probe corpus. Inventing a parallel detector
 * set for pipeline runs would have meant a second population with unmeasured recall — and
 * an instrument that has not itself been measured is not evidence.
 *
 * **The provider is scripted per stage, not per case.** An eleven-stage run makes up to
 * eleven different requests, so a single pinned response would answer `deconstruct` and
 * `tone_check` with the same text. Stages are identified by their own frozen templates,
 * which `check:stages` already verifies verbatim — so the routing here cannot drift from
 * the templates without that check failing first.
 */

import { randomUUID } from "node:crypto";
import { runPipeline, type PipelineRunResult } from "./pipeline.js";
import { scoreCase, casePassed } from "../../core/src/eval/detectors.js";
import { CONTRACT_VERSIONS } from "../../contracts/index.js";
import type {
  EvalCase, GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport,
  PipelineOutcome, RevisionEntry, RevisionStore, Score, StageId,
} from "../../contracts/index.js";

/** What each stage returns for a case. A stage with no entry degrades, which is a real case. */
export type StageStubs = Partial<Record<StageId, string>>;

export type PipelineEvalCase = EvalCase & {
  brief: string;
  /** stakes, depth, topology, gateOptions — whatever the run should be given. */
  context?: Record<string, unknown>;
  stubs?: StageStubs;
};

/**
 * Routes on the frozen stage templates.
 *
 * Kept in one place rather than duplicated per test, because the previous copy of this
 * logic lived in a test file and a second one drifting from it would silently mis-attribute
 * a reply to the wrong stage — a suite would still run, and every case would measure
 * something other than what it named.
 */
export function stageOf(req: GenerationRequest): StageId {
  const text = req.messages[0]?.content ?? "";
  const system = req.system ?? "";
  if (text.includes("STEP 1 — ANALYSIS")) return "deconstruct";
  if (text.includes("TEMPERATURE CALIBRATION")) return "calibrate";
  if (text.includes("STEP 2 — SCAFFOLDING")) return "compile";
  if (text.includes("GUARDRAILING")) return "harden";
  if (text.includes("strict reviewer") || system.includes("strict reviewer")) return "critique";
  if (text.includes("STEP 4 — REFINEMENT")) return "refine";
  if (system.includes("Critic in a Drafter")) return "critic";
  if (text.includes("VOICE & TONE AUDIT")) return "tone_check";
  return "preview";
}

class StagedProvider implements ProviderTransport {
  readonly provider_id = "staged-stub";
  calls = 0;
  constructor(private stubs: StageStubs) {}
  setStubs(stubs: StageStubs) { this.stubs = stubs; }

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    this.calls++;
    const stage = stageOf(req);
    const content = this.stubs[stage];
    if (content === undefined) {
      // No stub is a declared degradation, not an oversight. It is how a case says "this
      // stage could not reach a model" without needing a live outage.
      return {
        request_id: req.request_id, category: "UNAVAILABLE", retriable: false,
        reason_code: "no_stub_for_stage",
        safe_message: `The suite pinned no response for stage "${stage}".`,
        retry_after_ms: null, attempt: 1, provider_id: this.provider_id,
      };
    }
    return {
      request_id: req.request_id, content, provider_id: this.provider_id,
      model_id: "staged", finish_reason: "end_turn",
    };
  }

  async healthCheck() {
    return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "NONE" as const, failing_dependency: null };
  }
}

class EphemeralStore implements RevisionStore {
  readonly runs = new Map<string, RevisionEntry[]>();
  async append(e: RevisionEntry) { this.runs.set(e.run_id, [...(this.runs.get(e.run_id) ?? []), e]); }
  async getRun(id: string) { return this.runs.get(id) ?? []; }
  async listRecent() { return []; }
  async markStale() { /* an evaluation run has no history to invalidate */ }
}

/**
 * Project an eleven-stage run into the single-stage shape the detectors score.
 *
 * The compiled prompt is the run's output, `lint` supplies the gate verdicts, and
 * `demo_mode` is true when ANY stage degraded — one unlabelled degraded stage taints the
 * run, which is the same rule `PipelineRunResult` already applies.
 */
export function projectOutcome(result: PipelineRunResult, command_id: string): PipelineOutcome {
  return {
    command_id,
    run_id: result.run_id,
    stage_id: "compile",
    output: { text: result.context.prompt ?? "" },
    gate_results: result.gate_results,
    demo_mode: result.demo_mode,
    revision_id: result.revision_ids[result.revision_ids.length - 1] ?? "",
    execution_provenance: {
      core_build_hash: "pipeline-eval",
      contract_versions: CONTRACT_VERSIONS,
      provider_model_fingerprint: result.demo_mode ? null : "staged-stub:staged",
      config_fingerprint: null,
    },
  };
}

export interface PipelineCaseResult {
  case_id: string;
  passed: boolean;
  failure_mode: string;
  scores: Score[];
  /** Pipeline-level facts no single-stage suite could report. */
  stages: PipelineRunResult["stages"];
  /**
   * What the PROJECTION claims about degradation, kept separate from `stages`.
   *
   * A probe found that a projection reporting `demo_mode: false` on a degraded run broke
   * nothing: `demo-labelled-when-degraded` is conditional on that flag, so every detector
   * passed VACUOUSLY. Reporting the projected value beside the stage statuses is what lets
   * a test assert the two agree — a detector that only fires when a flag is set cannot
   * also be what verifies the flag.
   */
  demoMode: boolean;
  feedbackRounds: number;
  providerCalls: number;
}

export async function runPipelineSuite(opts: {
  cases: PipelineEvalCase[];
  coreBuildHash?: string;
}): Promise<{ perCase: PipelineCaseResult[]; passed: number }> {
  const perCase: PipelineCaseResult[] = [];

  for (const kase of opts.cases) {
    const provider = new StagedProvider(kase.stubs ?? {});
    let tick = 0;
    const result = await runPipeline(
      {
        command_id: `pipeline-eval-${kase.case_id}`,
        run_id: `pipeline-eval-${kase.case_id}`,
        stage_id: "deconstruct",
        input: { brief: kase.brief },
        context: kase.context ?? {},
      },
      {
        provider,
        store: new EphemeralStore(),
        sink: { emit: () => {} },
        // Injected clock and no sleeping: an evaluation run must be reproducible and fast.
        now: () => new Date(1_760_000_000_000 + tick++ * 10),
        sleep: async () => {},
        coreBuildHash: opts.coreBuildHash ?? "pipeline-eval",
      },
    );

    const outcome = projectOutcome(result, `pipeline-eval-${kase.case_id}`);
    const scores = scoreCase(kase, outcome);
    perCase.push({
      case_id: kase.case_id,
      passed: casePassed(scores),
      failure_mode: kase.failure_mode,
      scores,
      stages: result.stages,
      demoMode: outcome.demo_mode,
      feedbackRounds: result.context.feedbackRounds ?? 0,
      providerCalls: provider.calls,
    });
  }

  return { perCase, passed: perCase.filter((c) => c.passed).length };
}

/** Exported so a caller can build a run id without importing crypto. */
export const newRunId = () => randomUUID().replace(/-/g, "").slice(0, 16);
