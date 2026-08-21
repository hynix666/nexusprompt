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

export async function invokeWithRetry(
  request: GenerationRequest,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  // `maxAttempts: 0` made the loop body never run and `last!` throw a TypeError — a config
  // mistake surfacing as a crash in unrelated code. One attempt is the floor: "do not call
  // the provider" is not something this function can express, and should not pretend to.
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
  let last: ProviderFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = opts.now().getTime();
    opts.onAttempt?.({ phase: "started", attempt, duration_ms: 0 });

    const outcome = await opts.provider.generate(request);
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
