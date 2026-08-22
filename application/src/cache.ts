/**
 * A caching decorator around a provider, and an in-memory store for it.
 *
 * Placed at the provider boundary rather than inside the suite runner, so the authoring
 * pipeline gets the same behaviour: any caller that can name a stable key for a request
 * stops paying for it twice. Nothing in Core changes — this is an effect wrapping an
 * effect, which is the Application's job.
 *
 * ── The key is supplied, never derived here ──────────────────────────────────
 *
 * A cache that hashed the request would be wrong in the one case that matters. Under
 * stochastic decoding, a hundred trials of one case are a hundred IDENTICAL requests whose
 * whole purpose is to produce different answers. Hashing the request would collapse them to
 * one call and report a variance of zero with a tight interval around it — the protocol
 * would be priced as if it ran and would not have run.
 *
 * So the caller passes `keyFor`, and `core/src/eval/budget.ts` decides what goes in the key:
 * the trial index is included exactly when the configuration is stochastic. `keyFor`
 * returning null means "not cacheable", and an uncacheable request is simply passed through.
 *
 * ── Failures are never cached ───────────────────────────────────────────────
 *
 * A `ProviderFailure` is a statement about the provider at a moment, not about the request.
 * Caching one would turn a transient outage into a permanent answer, and — because demo mode
 * maps a classified failure to a placeholder — would let a single blip pin a run to
 * `⟦WORKFLOW DEMO — no model⟧` for as long as the cache lived.
 */

import { isFailure } from "../../contracts/index.js";
import type {
  CacheStore, GenerationRequest, GenerationResult, ProviderFailure, ProviderHealth, ProviderTransport,
} from "../../contracts/index.js";

/** Bounded only by the run. Evidence lives in the evidence plane; this is scratch. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, GenerationResult>();

  async get(key: string): Promise<GenerationResult | null> {
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: GenerationResult): Promise<void> {
    this.entries.set(key, value);
  }

  get size(): number { return this.entries.size; }
}

export interface CachingProviderOptions {
  /** Null means this request is not cacheable and must be passed straight through. */
  keyFor: (req: GenerationRequest) => string | null;
  cache: CacheStore;
}

export class CachingProvider implements ProviderTransport {
  /** Reads through to the wrapped provider — a cache is not a provider identity. */
  readonly provider_id: string;

  /** Requests answered from the cache. The signal that a warm run was actually warm. */
  hits = 0;
  /** Requests that reached the wrapped provider. What a budget is spent on. */
  misses = 0;

  constructor(
    private readonly inner: ProviderTransport,
    private readonly opts: CachingProviderOptions,
  ) {
    this.provider_id = inner.provider_id;
  }

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    const key = this.opts.keyFor(req);
    if (key === null) {
      this.misses += 1;
      return this.inner.generate(req);
    }

    const cached = await this.opts.cache.get(key);
    if (cached) {
      this.hits += 1;
      // The request_id is this request's, not the cached one's. Returning the old id would
      // make two revisions claim the same request, and provenance is what makes a run
      // readable as evidence.
      return { ...cached, request_id: req.request_id };
    }

    this.misses += 1;
    const outcome = await this.inner.generate(req);
    if (!isFailure(outcome)) await this.opts.cache.put(key, outcome);
    return outcome;
  }

  healthCheck(): Promise<ProviderHealth> {
    // Never cached. A health check exists to report the state right now.
    return this.inner.healthCheck();
  }
}
