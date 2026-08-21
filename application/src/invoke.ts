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
  /** Called per attempt so the caller can emit its own events without duplicating policy. */
  onAttempt?: (e: {
    attempt: number;
    outcome: GenerationResult | ProviderFailure | null;
    duration_ms: number;
    phase: "started" | "succeeded" | "failed";
  }) => void;
}

export interface InvokeResult {
  outcome: GenerationResult | ProviderFailure;
  /** How many attempts were actually made. Recorded so a revision cannot claim 1 and mean 3. */
  attempts: number;
}

export async function invokeWithRetry(
  request: GenerationRequest,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  let last: ProviderFailure | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const started = opts.now().getTime();
    opts.onAttempt?.({ attempt, outcome: null, duration_ms: 0, phase: "started" });

    const outcome = await opts.provider.generate(request);
    const duration_ms = opts.now().getTime() - started;

    if (!isFailure(outcome)) {
      opts.onAttempt?.({ attempt, outcome, duration_ms, phase: "succeeded" });
      return { outcome, attempts: attempt };
    }

    // The failure carries the attempt it happened on, so a caller reading only the final
    // outcome still learns how many were made.
    last = { ...outcome, attempt };
    opts.onAttempt?.({ attempt, outcome: last, duration_ms, phase: "failed" });

    // Only retriable failures are retried. An AUTH or INVALID_REQUEST failure repeated three
    // times is three identical failures and two wasted calls.
    if (!outcome.retriable || attempt === opts.maxAttempts) break;
    await opts.sleep(outcome.retry_after_ms ?? 100 * attempt);
  }

  return { outcome: last!, attempts: last!.attempt };
}
