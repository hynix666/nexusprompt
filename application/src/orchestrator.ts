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
import { decide, reduce, STAGE_ID } from "../../core/src/stages/compile.js";

export interface OrchestratorOptions {
  provider: ProviderTransport;
  store: RevisionStore;
  sink: EventSink;
  /** Attempts including the first. Retries only ever happen on retriable failures. */
  maxAttempts?: number;
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
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly coreBuildHash: string;

  constructor(opts: OrchestratorOptions) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.sink = opts.sink;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.coreBuildHash = opts.coreBuildHash ?? "dev";
  }

  async run(command: PipelineCommand): Promise<PipelineOutcome> {
    const t0 = this.now().getTime();
    const received = this.emit(command.run_id, "PIPELINE_COMMAND_RECEIVED", null, {
      component: "orchestrator",
    });

    // ── decide (Core, pure) ────────────────────────────────────────────────
    const request = decide(command.input, command.run_id);
    this.emit(command.run_id, "STAGE_DECISION", received, {
      component: "core/stages/compile",
      input_hash: sha256(JSON.stringify(command.input)),
    });

    // ── invoke + classify (this layer, effectful) ──────────────────────────
    const outcome = await this.invokeWithRetry(request, command.run_id, received);

    // ── reduce (Core, pure) ────────────────────────────────────────────────
    const reduced = reduce(command.input, outcome);

    // ── persist + report ───────────────────────────────────────────────────
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
      timestamp: this.now().toISOString(),
      stage_attempt: 1,
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
   */
  private async invokeWithRetry(
    request: ReturnType<typeof decide>,
    run_id: string,
    parent: string,
  ): Promise<GenerationResult | ProviderFailure> {
    const { outcome } = await sharedInvoke(request, {
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

    if (isFailure(outcome)) {
      // Retries exhausted or the failure was terminal. Degrade, loudly.
      this.emit(run_id, "DEGRADE", parent, {
        component: "orchestrator",
        provider_id: outcome.provider_id,
        failure_code: outcome.reason_code,
        attempt: outcome.attempt,
      });
    }
    return outcome;
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
