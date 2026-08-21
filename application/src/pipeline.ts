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
  planFor, type PipelineContext, type PipelineStage,
} from "../../core/src/stages/pipeline.js";
import { isFailure } from "../../contracts/index.js";
import { invokeWithRetry } from "./invoke.js";
import type {
  EventSink, ExecutionProvenance, GenerationResult, PipelineCommand, ProviderFailure,
  ProviderTransport, RevisionEntry, RevisionStore, StageId, GateResult, ObservabilityEvent, EventType,
} from "../../contracts/index.js";

const CONTRACT_VERSIONS = {
  "gate-result": "1.3.0",
  "provider-failure": "1.0.0",
  "pipeline-outcome": "1.0.0",
  "revision-entry": "1.1.0",
  "observability-event": "1.1.0",
};

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
  status: "SUCCEEDED" | "DEMO" | "SKIPPED";
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
      schema_version: "1.1.0",
      ...detail,
    });

  emit("PIPELINE_COMMAND_RECEIVED", { component: "application/pipeline" });

  for (const stage of planFor(ctx.depth)) {
    const inputHash = sha256(JSON.stringify({ id: stage.id, ctx: redactForHash(ctx) }));

    // ── skip: a decision, recorded, not an absence ──────────────────────────
    if (stage.shouldSkip?.(ctx)) {
      ctx = { ...ctx, ...(stage.reduceSkipped?.(ctx) ?? {}) };
      stages.push({ stage_id: stage.id, status: "SKIPPED", revision_id: null, output_hash: null });
      emit("STAGE_SKIPPED", { component: `core/stages/${stage.id}`, input_hash: inputHash });
      continue;
    }

    // ── deterministic: no request, no provider, no outcome to classify ──────
    if (stage.kind === "deterministic") {
      ctx = { ...ctx, ...(stage.run?.(ctx) ?? {}) };
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: summarize(stage.id, ctx), status: "SUCCEEDED", provider: null,
        gate_results: stage.id === "lint" ? (ctx.gate_results ?? []) : [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null,
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "SUCCEEDED", revision_id: revision.revision_id, output_hash: revision.output_hash });
      emit("REVISION_PERSISTED", { component: `core/stages/${stage.id}`, output_hash: revision.output_hash });
      continue;
    }

    // ── decide (Core, pure) → invoke (here) → reduce (Core, pure) ───────────
    const request = stage.decide!(ctx, run_id);
    emit("STAGE_DECISION", { component: `core/stages/${stage.id}`, input_hash: inputHash });

    // Shared with the Orchestrator. Calling `provider.generate` directly here meant an
    // eleven-stage run degraded on the first transient timeout while the single-stage path
    // recovered from the identical failure.
    const { outcome, attempts } = await invokeWithRetry(request, {
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
    const degraded = isFailure(outcome);
    if (degraded) anyDemo = true;

    ctx = { ...ctx, ...(stage.reduce!(ctx, outcome) ?? {}) };

    const revision = buildRevision({
      run_id, stage_id: stage.id, inputHash,
      outputText: summarize(stage.id, ctx),
      attempts,
      status: degraded ? "DEMO" : "SUCCEEDED",
      provider: degraded ? null : (outcome as GenerationResult).provider_id,
      fingerprint: degraded ? null : `${(outcome as GenerationResult).provider_id}:${(outcome as GenerationResult).model_id}`,
      gate_results: [],
      now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null,
    });
    await opts.store.append(revision);
    revision_ids.push(revision.revision_id);
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
    // The real count. Hardcoding 1 made a revision claim one attempt and mean three.
    stage_attempt: a.attempts ?? 1,
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
