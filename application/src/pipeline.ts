/**
 * The pipeline runner — Application layer, owns every effect.
 *
 * Core supplies the plan (`core/src/stages/pipeline.ts`) and performs nothing. This walks
 * it: for each stage, ask Core what to do, do it, hand the classified outcome back to Core,
 * persist the revision. `decide → invoke → reduce`, eleven times, with Core appearing twice
 * per stage and invoking nothing either time.
 *
 * **A run is one bundle.** Every stage appends a `RevisionEntry` under the same `run_id`,
 * so the run reloads through `store.getRun(run_id)` as a unit. That is deliberate and
 * ADR-0004's reasoning: the local store retains eight complete RUNS, kept or evicted whole,
 * because an entry-based cap cannot hold a variable-length run — the source's cap of 8
 * entries could not hold a nine-stage run, and the pipeline is now eleven.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  planForContext, decideGateFeedback, type PipelineContext, type PipelineStage,
} from "../../core/src/stages/pipeline.js";
import { isFailure, CONTRACT_VERSIONS } from "../../contracts/index.js";
import { invokeWithRetry } from "./invoke.js";
import type {
  EventSink, ExecutionProvenance, GenerationResult, PipelineCommand, ProviderFailure,
  ProviderTransport, RevisionEntry, RevisionStore, StageId, GateResult, ObservabilityEvent, EventType,
} from "../../contracts/index.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface PipelineRunOptions {
  provider: ProviderTransport;
  store: RevisionStore;
  sink: EventSink;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts including the first, shared with the Orchestrator. */
  maxAttempts?: number;
  coreBuildHash?: string;
  configFingerprint?: string | null;
}

/** What one stage did. `skipped` is a real outcome, distinct from succeeded and degraded. */
export interface StageRecord {
  stage_id: StageId;
  status: "SUCCEEDED" | "DEMO" | "SKIPPED" | "FAILED";
  revision_id: string | null;
  output_hash: string | null;
}

export interface PipelineRunResult {
  run_id: string;
  context: PipelineContext;
  stages: StageRecord[];
  /** From the `lint` stage — the pipeline's authoritative gate verdicts. */
  gate_results: GateResult[];
  /** True when ANY stage degraded. One unlabelled degraded stage taints the run. */
  demo_mode: boolean;
  /** True when any stage threw. Distinct from demo_mode: a throw is a defect, not an outage. */
  failed: boolean;
  revision_ids: string[];
}

/**
 * Run the pipeline for one command.
 *
 * Stage failures do not abort the run. A provider outage at `harden` degrades that stage
 * into a labelled placeholder and the run continues — which is the whole point of demo
 * mode, and why `reduce` takes a classified outcome rather than throwing. A run that
 * stopped at the first failure would produce no artifact at all and no record of how far
 * it got.
 */
export async function runPipeline(
  command: PipelineCommand & { context?: Partial<PipelineContext> },
  opts: PipelineRunOptions,
): Promise<PipelineRunResult> {
  const now = opts.now ?? (() => new Date());
  const coreBuildHash = opts.coreBuildHash ?? "dev";
  const run_id = command.run_id;

  let ctx: PipelineContext = {
    brief: command.input.brief,
    ...(command.context ?? {}),
  };

  const stages: StageRecord[] = [];
  const revision_ids: string[] = [];
  let anyDemo = false;
  let anyFailed = false;

  /**
   * Emit a fully-formed ObservabilityEvent.
   *
   * This was `opts.sink.emit({ ... } as never)`, and the cast hid three contract violations
   * at once: the field is `event_type` not `type`, five required fields were missing
   * (`layer`, `parent_event_id`, `schema_version` and the nullables), and `STAGE_SKIPPED`
   * was not in the enum at all. The conformance suite validates events, but only ones the
   * Orchestrator produced — so nothing ever looked at these. An escape hatch with no comment
   * justifying it turned out to be silencing exactly what it looked like it might be.
   */
  const emit = (
    event_type: EventType,
    detail: Partial<Omit<ObservabilityEvent, "event_id" | "event_type" | "run_id" | "timestamp" | "layer" | "schema_version">> = {},
  ) =>
    opts.sink.emit({
      event_id: randomUUID(),
      event_type,
      run_id,
      parent_event_id: null,
      timestamp: now().toISOString(),
      layer: "application",
      component: "application/pipeline",
      duration_ms: null,
      attempt: null,
      input_hash: null,
      output_hash: null,
      provider_id: null,
      model_id: null,
      failure_code: null,
      verdict: null,
      schema_version: CONTRACT_VERSIONS["observability-event"],
      ...detail,
    });

  emit("PIPELINE_COMMAND_RECEIVED", { component: "application/pipeline" });

  /**
   * An index walk, not a for-of, because the plan is no longer necessarily walked once.
   *
   * A reflexive topology routes a gate FAIL back to `refine`, so the runner has to be able
   * to move backwards. Core decides whether and where (`decideGateFeedback`); this loop only
   * follows, which is the same division as `shouldSkip` and `planForContext`.
   *
   * `plan` is hoisted out of the loop deliberately. Recomputing it per iteration would let a
   * context patch silently change the plan mid-run, and the depth budget is computed against
   * one plan.
   */
  const plan = planForContext(ctx);

  for (let i = 0; i < plan.length; i++) {
    const stage = plan[i];
    const inputHash = sha256(JSON.stringify({ id: stage.id, ctx: redactForHash(ctx) }));
    const feedbackRound = ctx.feedbackRounds ?? 0;

    /**
     * A skip is persisted, not merely evented.
     *
     * It used to push a `StageRecord` and emit `STAGE_SKIPPED` and store nothing — so a
     * reloaded bundle could not tell "deliberately skipped" from "never reached", which is
     * the exact distinction the `STAGE_SKIPPED` event type was added for. Events are not
     * persisted; revisions are. A run with a clean critique, LOW stakes, or any degradation
     * produced a short bundle with no record of why it was short.
     */
    if (stage.shouldSkip?.(ctx)) {
      ctx = { ...ctx, ...(stage.reduceSkipped?.(ctx) ?? {}) };
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: "", status: "SKIPPED", provider: null, gate_results: [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "SKIPPED", revision_id: revision.revision_id, output_hash: null });
      emit("STAGE_SKIPPED", { component: `core/stages/${stage.id}`, input_hash: inputHash });
      continue;
    }

    /**
     * An unexpected throw is a FAILED stage, not an aborted run.
     *
     * Core stages are pure but not total — `fillTemplate` throws on a template naming an
     * unfillable slot, and a future stage may throw for its own reasons. Letting that
     * escape contradicted this module's own promise that "stage failures do not abort the
     * run": the caller got an unhandled rejection, no result, no event, and a bundle
     * silently truncated at however far it got. `RevisionStatus` already had a `FAILED`
     * member that nothing ever wrote; now something does.
     */
    const failStage = async (err: unknown): Promise<void> => {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: "", status: "FAILED", provider: null, gate_results: [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "FAILED", revision_id: revision.revision_id, output_hash: revision.output_hash });
      emit("DEGRADE", { component: `core/stages/${stage.id}`, failure_code: "stage_threw", verdict: message.slice(0, 200) });
    };

    // ── deterministic: no request, no provider, no outcome to classify ──────
    if (stage.kind === "deterministic") {
      try {
        ctx = { ...ctx, ...stage.run(ctx) };
      } catch (err) {
        await failStage(err);
        continue;
      }
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: summarize(stage.id, ctx), status: "SUCCEEDED", provider: null,
        gate_results: stage.id === "lint" ? (ctx.gate_results ?? []) : [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "SUCCEEDED", revision_id: revision.revision_id, output_hash: revision.output_hash });
      emit("REVISION_PERSISTED", { component: `core/stages/${stage.id}`, output_hash: revision.output_hash });

      /**
       * Gate verdicts as a control signal — ADR-0008 action item 4.
       *
       * The verdicts are already computed, pure and typed; only acting on them was missing.
       * Core owns the whole decision, including the cap and every reason not to loop, so this
       * branch cannot quietly acquire a second policy. The revision above is persisted BEFORE
       * the jump, so a bundle records the failing lint that caused the retry rather than only
       * the passing one that ended it.
       */
      if (stage.id === "lint") {
        const feedback = decideGateFeedback(ctx, plan);
        emit("GATE_FEEDBACK", {
          component: "core/stages/lint",
          verdict: feedback.reason,
          input_hash: inputHash,
        });
        if (feedback.retry) {
          ctx = { ...ctx, ...(feedback.patch ?? {}) };
          const target = plan.findIndex((s) => s.id === feedback.resumeAt);
          // Core already refused to retry when the plan lacks the target, so this is
          // belt-and-braces — but a -1 here would restart the whole run, and a silent
          // infinite loop is the one failure this feature must not introduce.
          if (target >= 0) { i = target - 1; continue; }
        }
      }
      continue;
    }

    // ── decide (Core, pure) → invoke (here) → reduce (Core, pure) ───────────
    let request;
    try {
      request = stage.decide(ctx, run_id);
    } catch (err) {
      await failStage(err);
      continue;
    }
    // The input hash identifies what this stage was ACTUALLY given: the system prompt plus
    // the rendered user turn, already content-hashed into request_id by buildRequest. The
    // previous hash covered only the run's inputs, so nine of eleven stages produced an
    // identical input_hash across runs whose outputs differed — a provenance record
    // contradicting itself, and useless for replay or caching.
    const stageInputHash = sha256(`${request.system ?? ""} ${request.messages[0]?.content ?? ""}`);
    emit("STAGE_DECISION", { component: `core/stages/${stage.id}`, input_hash: stageInputHash });

    // Shared with the Orchestrator. Calling `provider.generate` directly here meant an
    // eleven-stage run degraded on the first transient timeout while the single-stage path
    // recovered from the identical failure.
    // The invoke is guarded too. A ProviderTransport is *supposed* to return a typed
    // failure rather than throw — but an adapter bug or an unexpected exception would
    // otherwise escape here and abort the run, which is the same defect as an unguarded
    // Core throw and just as invisible until it happens.
    let invoked;
    try {
      invoked = await invokeWithRetry(request, {
        provider: opts.provider,
      maxAttempts: opts.maxAttempts ?? 3,
      now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      onAttempt: (e) => {
        if (e.phase === "started") {
          emit("PROVIDER_CALL_STARTED", { component: opts.provider.provider_id, provider_id: opts.provider.provider_id, attempt: e.attempt });
        } else if (e.phase === "succeeded") {
          const r = e.outcome as GenerationResult;
          emit("PROVIDER_CALL_SUCCEEDED", { component: opts.provider.provider_id, provider_id: r.provider_id, model_id: r.model_id, attempt: e.attempt, duration_ms: e.duration_ms });
        } else {
          const f = e.outcome as ProviderFailure;
          emit("PROVIDER_CALL_FAILED", { component: opts.provider.provider_id, provider_id: f.provider_id, attempt: e.attempt, duration_ms: e.duration_ms, failure_code: f.reason_code });
        }
        },
      });
    } catch (err) {
      await failStage(err);
      continue;
    }
    const { outcome, attempts } = invoked;
    const degraded = isFailure(outcome);
    if (degraded) anyDemo = true;

    try {
      ctx = { ...ctx, ...stage.reduce(ctx, outcome) };
    } catch (err) {
      await failStage(err);
      continue;
    }

    const revision = buildRevision({
      run_id, stage_id: stage.id, inputHash: stageInputHash,
      outputText: summarize(stage.id, ctx),
      attempts,
      status: degraded ? "DEMO" : "SUCCEEDED",
      provider: degraded ? null : (outcome as GenerationResult).provider_id,
      fingerprint: degraded ? null : `${(outcome as GenerationResult).provider_id}:${(outcome as GenerationResult).model_id}`,
      gate_results: [],
      now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
    });
    await opts.store.append(revision);
    revision_ids.push(revision.revision_id);
    if (degraded) {
      // The orchestrator emits this and the pipeline did not, so from events alone a
      // consumer could not tell an eleven-stage run degraded eleven times.
      const f = outcome as ProviderFailure;
      emit("DEGRADE", {
        component: `core/stages/${stage.id}`,
        provider_id: f.provider_id, failure_code: f.reason_code, attempt: f.attempt,
      });
    }
    stages.push({
      stage_id: stage.id,
      status: degraded ? "DEMO" : "SUCCEEDED",
      revision_id: revision.revision_id,
      output_hash: revision.output_hash,
    });
    emit("REVISION_PERSISTED", { component: `core/stages/${stage.id}`, output_hash: revision.output_hash });
  }

  return {
    run_id,
    context: ctx,
    stages,
    // Gating is `lint`'s job in the frozen pipeline, and now here too. `compile` also runs
    // gates inline — a vertical-slice artifact kept because the single-stage path and the
    // eval suite read them from there — but the RUN's verdict comes from lint, which uses
    // the full sixteen-gate registry against the final prompt rather than an intermediate.
    gate_results: ctx.gate_results ?? [],
    demo_mode: anyDemo,
    failed: anyFailed,
    revision_ids,
  };
}

/** The text a stage contributed, for hashing and for the revision record. */
function summarize(id: StageId, ctx: PipelineContext): string {
  const byStage: Partial<Record<StageId, string | undefined>> = {
    deconstruct: ctx.spec, calibrate: ctx.calibration,
    compile: ctx.prompt, harden: ctx.prompt, refine: ctx.prompt,
    critique: ctx.critique, lint: ctx.lint, critic: ctx.critic,
    preview: ctx.preview, cost_estimate: ctx.cost, tone_check: ctx.tone,
  };
  return byStage[id] ?? "";
}

/**
 * Hash the context WITHOUT the accumulated outputs.
 *
 * A stage's input hash should identify what it was given, and every stage is given the
 * whole context — so hashing it verbatim would make every input hash change whenever any
 * earlier stage's output changed, including stages that never read it. The brief, stakes,
 * depth and test message are the run's actual inputs.
 */
function redactForHash(ctx: PipelineContext) {
  const { brief, stakes, depth, testMessage } = ctx;
  return { brief, stakes, depth, testMessage };
}

function buildRevision(a: {
  run_id: string; stage_id: StageId; inputHash: string; outputText: string;
  status: RevisionEntry["status"]; provider: string | null; fingerprint?: string | null; attempts?: number;
  gate_results: GateResult[]; now: () => Date; coreBuildHash: string; configFingerprint: string | null;
  feedbackRound?: number;
}): RevisionEntry {
  const provenance: ExecutionProvenance = {
    core_build_hash: a.coreBuildHash,
    contract_versions: CONTRACT_VERSIONS,
    provider_model_fingerprint: a.fingerprint ?? null,
    config_fingerprint: a.configFingerprint,
  };
  return {
    revision_id: randomUUID(),
    run_id: a.run_id,
    stage_id: a.stage_id,
    parent_revision_ids: [],
    timestamp: a.now().toISOString(),
    // Provider attempts within THIS execution. The real count — hardcoding 1 made a
    // revision claim one attempt and mean three. Re-executions are `feedback_round`.
    stage_attempt: a.attempts ?? 1,
    feedback_round: a.feedbackRound ?? 0,
    input_hash: a.inputHash,
    output_hash: sha256(a.outputText),
    gate_results: a.gate_results,
    status: a.status,
    freshness: "FRESH",
    provider_used: a.provider,
    execution_provenance: provenance,
    retention_scope: "LOCAL_BUNDLE",
  };
}
