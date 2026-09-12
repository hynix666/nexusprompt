/**
 * Provider invocation with retry — the Application layer's single implementation.
 *
 * It lived as a private method on `Orchestrator`, whose own comment says "Retry policy
 * lives here and nowhere else." Then the pipeline runner was written and called
 * `provider.generate()` directly, so there were two invocation paths and only one of them
 * retried: a transient TIMEOUT or RATE_LIMIT degraded an eleven-stage run's stage on the
 * first attempt, while the single-stage path recovered from the identical failure.
 *
 * Extracted rather than copied. Two implementations of one rule is a drift bug with a delay
 * fuse, and the harness someone eventually builds to detect the drift is more code than the
 * deduplication would have been.
 *
 * An adapter that retried internally would be worse still: the attempt count would be
 * invisible to this layer and the event stream would under-report what actually happened.
 * Retries are visible here or they are not visible at all.
 */

import { isFailure } from "../../contracts/index.js";
import type {
  GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport,
} from "../../contracts/index.js";

export interface InvokeOptions {
  provider: ProviderTransport;
  /** Attempts INCLUDING the first. 1 disables retry without disabling the call. */
  maxAttempts: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /**
   * Called per attempt so the caller can emit its own events without duplicating policy.
   *
   * A union discriminated on `phase`, not one shape with a nullable outcome — otherwise
   * every caller writes `e.outcome as GenerationResult`, and this file's history is that a
   * cast hid three contract violations at once.
   */
  onAttempt?: (e: AttemptEvent) => void;
}

export type AttemptEvent =
  | { phase: "started"; attempt: number; duration_ms: number }
  | { phase: "succeeded"; attempt: number; duration_ms: number; outcome: GenerationResult }
  | { phase: "failed"; attempt: number; duration_ms: number; outcome: ProviderFailure };

export interface InvokeResult {
  outcome: GenerationResult | ProviderFailure;
  /** How many attempts were actually made. Recorded so a revision cannot claim 1 and mean 3. */
  attempts: number;
}

/**
 * A ceiling on honoured backoff.
 *
 * `retry_after_ms` comes from the provider, and an uncapped one stalls a run for as long as
 * the far end says. Two minutes is well past any real rate-limit window and still bounded.
 */
const MAX_BACKOFF_MS = 120_000;

/**
 * A failure this function made up, rather than one an adapter classified.
 *
 * `attempt: 1` because nothing was attempted at the provider — the count is of provider calls,
 * and claiming more would misreport what a run cost.
 */
const refuse = (
  request: GenerationRequest,
  category: ProviderFailure["category"],
  reason_code: string,
  safe_message: string,
): ProviderFailure => ({
  request_id: request.request_id,
  category,
  reason_code,
  safe_message,
  retriable: false,
  retry_after_ms: null,
  attempt: 1,
  provider_id: "application",
});

export async function invokeWithRetry(
  request: GenerationRequest,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  /**
   * Fallback is refused here rather than implemented anywhere (Phase 8 spec §7).
   *
   * Choosing a second model on failure needs retry classification, aggregate call-budget
   * accounting, idempotency, deterministic ordering, and provenance recording WHICH model
   * answered. None of that exists. An adapter silently taking `preferred_models[0]` would
   * report a run against a model the caller did not get, which is the failure this repository
   * exists to prevent — so the request is refused before a provider is asked.
   *
   * Unreachable from a Shell today: `core/src/stages/stage-kit.ts` is the only producer of a
   * `model_policy` and always names one model. The guard is at the boundary such a request
   * would arrive through, which is what stays true when a Shell starts accepting one.
   */
  if (request.model_policy.preferred_models.length > 1 && request.model_policy.allow_fallback) {
    const outcome = refuse(
      request,
      "INVALID_REQUEST",
      "fallback_not_implemented",
      `This deployment executes one model per request. ${request.model_policy.preferred_models.length} ` +
      "preferred models were named with allow_fallback set, and falling back is not implemented: " +
      "name one model, or clear allow_fallback and accept that only the first is used.",
    );
    opts.onAttempt?.({ phase: "failed", attempt: 1, duration_ms: 0, outcome });
    return { outcome, attempts: 1 };
  }

  // `maxAttempts: 0` made the loop body never run and `last!` throw a TypeError — a config
  // mistake surfacing as a crash in unrelated code. One attempt is the floor: "do not call
  // the provider" is not something this function can express, and should not pretend to.
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
  let last: ProviderFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = opts.now().getTime();
    opts.onAttempt?.({ phase: "started", attempt, duration_ms: 0 });

    /**
     * An adapter that throws becomes a value here (Phase 8 spec, exception normalization).
     *
     * Every first-party adapter returns a typed failure from every catch, so this is a guard
     * on the port rather than a fix for a known bug: `ProviderTransport` is a plugin seam, and
     * an exception crossing it bypasses retry classification entirely — `pipeline.ts` catches
     * it outside the loop and marks the stage failed with no category, while `orchestrator.ts`
     * does not catch it at all.
     *
     * Non-retriable, and INTERNAL rather than UNAVAILABLE: an adapter that throws has not told
     * us whether anything reached the far end, so a retry might duplicate a side effect, and
     * re-running an unclassified defect three times only hides it. The exception's own text is
     * dropped rather than reported — it is the likeliest place for a host, a path or a key
     * fragment to appear (#169).
     */
    let outcome: GenerationResult | ProviderFailure;
    try {
      outcome = await opts.provider.generate(request);
    } catch {
      outcome = refuse(
        request,
        "INTERNAL",
        "adapter_threw",
        `The provider adapter threw instead of returning a classified failure. ` +
        "Its message is withheld deliberately; the adapter is the place to classify this.",
      );
    }
    const duration_ms = opts.now().getTime() - started;

    if (!isFailure(outcome)) {
      opts.onAttempt?.({ phase: "succeeded", attempt, duration_ms, outcome });
      return { outcome, attempts: attempt };
    }

    // The failure carries the attempt it happened on, so a caller reading only the final
    // outcome still learns how many were made.
    last = { ...outcome, attempt };
    opts.onAttempt?.({ phase: "failed", attempt, duration_ms, outcome: last });

    // Only retriable failures are retried. An AUTH or INVALID_REQUEST failure repeated three
    // times is three identical failures and two wasted calls.
    if (!outcome.retriable || attempt === maxAttempts) break;
    await opts.sleep(Math.min(outcome.retry_after_ms ?? 100 * attempt, MAX_BACKOFF_MS));
  }

  return { outcome: last!, attempts: last!.attempt };
}
