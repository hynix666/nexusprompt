/**
 * The Application layer.
 *
 * Owns every live effect in the system: it invokes the provider, classifies the
 * outcome, drives retries, persists the revision, and emits events. Core does
 * none of that, which is what makes Core testable without any of it.
 *
 * The loop is: decide → invoke → classify → reduce. Core appears twice and
 * performs nothing either time.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  EventSink,
  ExecutionProvenance,
  GenerationResult,
  ObservabilityEvent,
  PipelineCommand,
  PipelineOutcome,
  ProviderFailure,
  ProviderTransport,
  RevisionEntry,
  RevisionStore,
} from "../../contracts/index.js";
import { isFailure, CONTRACT_VERSIONS } from "../../contracts/index.js";
import { invokeWithRetry as sharedInvoke } from "./invoke.js";
import { refuseForgedMarker } from "../../core/src/stages/stage-kit.js";
import { decide, reduce } from "../../core/src/stages/compile.js";
import { admitRun, type Budget } from "../../core/src/eval/budget.js";

export interface OrchestratorOptions {
  provider: ProviderTransport;
  store: RevisionStore;
  sink: EventSink;
  /** Attempts including the first. Retries only ever happen on retriable failures. */
  maxAttempts?: number;
  /**
   * What this single-stage run may spend. Absent means no budget was declared, which
   * `admitRun` admits — the same rule the pipeline and evaluation paths follow.
   */
  budget?: Budget | null;
  /** Injected so tests need no wall clock and no sleeping. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  coreBuildHash?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export class Orchestrator {
  private readonly provider: ProviderTransport;
  private readonly store: RevisionStore;
  private readonly sink: EventSink;
  private readonly maxAttempts: number;
  private readonly budget: Budget | null;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly coreBuildHash: string;

  constructor(opts: OrchestratorOptions) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.sink = opts.sink;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.budget = opts.budget ?? null;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.coreBuildHash = opts.coreBuildHash ?? "dev";
  }

  async run(command: PipelineCommand): Promise<PipelineOutcome> {
    const t0 = this.now().getTime();
    const received = this.emit(command.run_id, "PIPELINE_COMMAND_RECEIVED", null, {
      component: "orchestrator",
    });

    /**
     * Admission, before the first provider call.
     *
     * The single-stage path is small — one stage, so at most `maxAttempts` calls — but "small"
     * is not "bounded", and until sweep twelve it was the last path that could reach a provider
     * with no budget expressible at all. The pipeline path had the same gap and it was closed
     * in #40; leaving this one open kept the guarantee uneven for no reason a caller could see.
     */
    const admission = admitRun({ budget: this.budget, plannedCalls: this.maxAttempts });
    if (!admission.admit) {
      throw new Error(
        `Run "${command.run_id}" ${admission.reason}
` +
          `  Raise the budget or run without one. Nothing was spent.`,
      );
    }

    // ── decide (Core, pure) ────────────────────────────────────────────────
    const request = decide(command.input, command.run_id);
    this.emit(command.run_id, "STAGE_DECISION", received, {
      component: "core/stages/compile",
      input_hash: sha256(JSON.stringify(command.input)),
    });

    // ── invoke + classify (this layer, effectful) ──────────────────────────
    // `outcome` is already settled through `refuseForgedMarker` — see `invokeWithRetry`.
    const { outcome, attempts } = await this.invokeWithRetry(request, command.run_id, received);

    // ── reduce (Core, pure) ────────────────────────────────────────────────
    const reduced = reduce(command.input, outcome);

    // ── persist + report ───────────────────────────────────────────────────
    /**
     * Computed from the SETTLED outcome, so the revision cannot contradict its own status.
     *
     * These two fields read the RAW outcome, and `reduce` settles the forged-marker case
     * inside itself — so a completion carrying one of this pipeline's placeholder markers
     * produced `status: "DEMO"` beside `provider_used: "flaky-provider"` and a
     * `provider_model_fingerprint` naming the model. Measured, exactly that.
     *
     * `application/src/pipeline.ts` makes DEMO imply both are null, so the two writers of
     * `RevisionEntry` disagreed about what a DEMO record looks like — and `check:fingerprint`
     * would read a fingerprint stamped on a revision the same record calls degraded. The
     * commit that closed this on the pipeline path said the two must "agree by construction
     * rather than by both being remembered"; this is the other half of that.
     */
    const provenance: ExecutionProvenance = {
      core_build_hash: this.coreBuildHash,
      contract_versions: CONTRACT_VERSIONS,
      provider_model_fingerprint: isFailure(outcome)
        ? null
        : `${outcome.provider_id}:${outcome.model_id}`,
      config_fingerprint: command.config_fingerprint ?? null,
    };

    const revision: RevisionEntry = {
      revision_id: randomUUID(),
      run_id: command.run_id,
      stage_id: command.stage_id,
      parent_revision_ids: [],
      // Content retention (revision-entry 1.4.0) is not wired into the single-stage
      // orchestrator yet — null is the honest "not retained here".
      input_ref: null,
      output_ref: null,
      timestamp: this.now().toISOString(),
      /**
       * What actually happened, not the literal 1.
       *
       * `sharedInvoke` has returned `{ outcome, attempts }` since the retry policy was
       * extracted, and this path destructured only `outcome` — so a revision that took three
       * provider attempts recorded one, and the retry cost was invisible in stored
       * provenance. The commit that extracted the policy fixed the count in
       * `application/src/pipeline.ts` and claimed the defect closed; it survived here, on the
       * path `nexusprompt run` uses.
       */
      stage_attempt: attempts,
      input_hash: sha256(JSON.stringify(command.input)),
      output_hash: sha256(reduced.output.text),
      gate_results: reduced.gate_results,
      // A demo result is not a failure — the run completed and produced a
      // labelled artifact. Conflating the two would lose the distinction the
      // whole mechanism exists to preserve.
      status: reduced.demo_mode ? "DEMO" : "SUCCEEDED",
      freshness: "FRESH",
      provider_used: isFailure(outcome) ? null : outcome.provider_id,
      execution_provenance: provenance,
      retention_scope: "LOCAL_BUNDLE",
    };

    await this.store.append(revision);
    this.emit(command.run_id, "REVISION_PERSISTED", received, {
      component: "adapters/storage-local",
      output_hash: revision.output_hash,
      duration_ms: this.now().getTime() - t0,
    });

    return {
      command_id: command.command_id,
      run_id: command.run_id,
      stage_id: command.stage_id,
      output: reduced.output,
      gate_results: reduced.gate_results,
      demo_mode: reduced.demo_mode,
      revision_id: revision.revision_id,
      execution_provenance: provenance,
    };
  }

  /**
   * Invoke the provider, retrying only where the failure says it is safe to.
   *
   * The policy now lives in `invoke.ts` and this delegates to it. It used to live here,
   * under a comment claiming "retry policy lives here and nowhere else" — which stopped
   * being true the moment the pipeline runner called `provider.generate` directly and
   * retried nothing, so an eleven-stage run degraded on a transient timeout that this path
   * recovered from. Extracted rather than copied: two implementations of one rule is a
   * drift bug with a delay fuse.
   *
   * What to EMIT stays here, because that is this class's business; WHEN to retry is not.
   * An adapter that retried internally would still be wrong — the attempt count would be
   * invisible to this layer and the event stream would under-report what happened.
   *
   * Returns the attempt count alongside the outcome, because the caller records it. It was
   * dropped on the floor here while `stage_attempt` was hardcoded to 1.
   */
  private async invokeWithRetry(
    request: ReturnType<typeof decide>,
    run_id: string,
    parent: string,
  ): Promise<{ outcome: GenerationResult | ProviderFailure; attempts: number }> {
    const { outcome: raw, attempts } = await sharedInvoke(request, {
      provider: this.provider,
      maxAttempts: this.maxAttempts,
      now: this.now,
      sleep: this.sleep,
      onAttempt: (e) => {
        if (e.phase === "started") {
          this.emit(run_id, "PROVIDER_CALL_STARTED", parent, {
            component: this.provider.provider_id,
            provider_id: this.provider.provider_id,
            attempt: e.attempt,
          });
        } else if (e.phase === "succeeded") {
          const r = e.outcome;
          this.emit(run_id, "PROVIDER_CALL_SUCCEEDED", parent, {
            component: this.provider.provider_id,
            provider_id: r.provider_id,
            model_id: r.model_id,
            attempt: e.attempt,
            duration_ms: e.duration_ms,
          });
        } else {
          const f = e.outcome;
          this.emit(run_id, "PROVIDER_CALL_FAILED", parent, {
            component: this.provider.provider_id,
            provider_id: f.provider_id,
            attempt: e.attempt,
            duration_ms: e.duration_ms,
            failure_code: f.reason_code,
          });
        }
      },
    });

    /**
     * Settled HERE, so the event stream and the revision see the same outcome.
     *
     * `refuseForgedMarker` reclassifies a completion carrying one of this pipeline's own
     * placeholder markers as `MALFORMED_RESPONSE` — the provider answered, and the answer
     * cannot be used. Settling at the point of classification means the DEGRADE below fires
     * for that case too, rather than a run reporting `status: "DEMO"` with no degradation
     * anywhere in its events.
     */
    const outcome = refuseForgedMarker(raw);

    if (isFailure(outcome)) {
      // Retries exhausted, the failure was terminal, or the answer was unusable. Degrade, loudly.
      this.emit(run_id, "DEGRADE", parent, {
        component: "orchestrator",
        provider_id: outcome.provider_id,
        failure_code: outcome.reason_code,
        // The real count. A forged marker synthesises a failure carrying `attempt: 1`
        // regardless of how many attempts preceded it, so the failure's own field would
        // under-report exactly where this path already did.
        attempt: attempts,
      });
    }
    return { outcome, attempts };
  }

  private emit(
    run_id: string,
    event_type: ObservabilityEvent["event_type"],
    parent_event_id: string | null,
    fields: Partial<ObservabilityEvent> & { component: string },
  ): string {
    const event_id = randomUUID();
    this.sink.emit({
      event_id,
      event_type,
      run_id,
      parent_event_id,
      timestamp: this.now().toISOString(),
      layer: "application",
      duration_ms: null,
      attempt: null,
      input_hash: null,
      output_hash: null,
      provider_id: null,
      model_id: null,
      failure_code: null,
      verdict: null,
      schema_version: "1.0.0",
      ...fields,
    });
    return event_id;
  }
}
