/**
 * Bearer auth and a request-rate ceiling, both hand-rolled against `node:crypto` and a Map.
 *
 * No new dependencies, deliberately. ADR-0012 states as a load-bearing claim that
 * `shells/api` has exactly two runtime dependencies — `fastify` and `@fastify/sensible` —
 * and that sentence is quoted across the documentation set. `@fastify/bearer-auth` and
 * `@fastify/rate-limit` are both good and both would have cost an amendment to it. A token
 * comparison and a fixed window are small enough to own.
 *
 * ── The two controls have different defaults, on purpose ─────────────────────
 *
 * Auth is OPT-IN: absent `NEXUSPROMPT_API_TOKEN`, every route stays open and the server says
 * so at startup. Rate limiting is ALWAYS ON. That asymmetry is the point — a rate limit needs
 * no secret to configure, so there is no deployment it cannot protect, and it is the half
 * that bounds what an unauthenticated caller can spend at a provider.
 *
 * ── What this does not do ────────────────────────────────────────────────────
 *
 * The window is per PROCESS and held in memory. Two instances behind a load balancer enforce
 * the ceiling twice, once each, rather than once between them. Saying so here is cheaper than
 * someone discovering it from a bill: a shared store is what a real multi-instance deployment
 * needs, and it is an adapter, not forty lines in a Shell.
 *
 * The client key is `request.ip`, and `trustProxy` is deliberately NOT enabled. Behind a
 * reverse proxy that makes every caller look like the proxy and the limit becomes global.
 * The alternative is worse: honouring `X-Forwarded-For` without knowing the proxy is real
 * lets any caller mint a fresh identity per request, which is a rate limiter that cannot
 * limit. Enabling it is a deployment decision that needs the proxy's address, not a default.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SecurityConfig {
  /** Absent means auth is off and every route is open. */
  readonly token: string | null;
  readonly windowMs: number;
  /** Requests per window per client, for routes that do no external work. */
  readonly generalLimit: number;
  /** Requests per window per client, for routes that reach a provider. */
  readonly providerLimit: number;
}

/**
 * Routes exempt from both controls.
 *
 * Health is what a liveness probe calls, so requiring a credential for it makes the probe
 * a place to put one, and rate-limiting it means a one-second probe interval eats the
 * general allowance. It returns a static object and reaches nothing.
 */
const OPEN_PATHS = new Set(["/api/v1/health"]);

/**
 * Routes that reach a provider, and therefore cost money rather than microseconds.
 *
 * A single ceiling cannot serve both kinds: generous enough for `/gates` is far too
 * generous for a compile, and tight enough for a compile makes the cheap reads unusable.
 */
const PROVIDER_PATHS = new Set(["/api/v1/compiler/compile", "/api/v1/provider/health"]);

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  // Rejecting rather than clamping: a caller who wrote RATE_LIMIT=0 meant something, and
  // silently substituting a default would enforce a ceiling they think they removed.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Refusing to start: "${raw}" is not a positive integer. A rate limit that cannot be ` +
        `parsed must not fall back to a default the operator did not choose.`,
    );
  }
  return n;
};

export function securityFromEnv(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const token = env.NEXUSPROMPT_API_TOKEN?.trim();
  return {
    token: token ? token : null,
    windowMs: positiveInt(env.NEXUSPROMPT_RATE_WINDOW_MS, 60_000),
    generalLimit: positiveInt(env.NEXUSPROMPT_RATE_LIMIT, 120),
    providerLimit: positiveInt(env.NEXUSPROMPT_PROVIDER_RATE_LIMIT, 10),
  };
}

/**
 * Constant-time comparison over digests.
 *
 * `timingSafeEqual` throws on length mismatch, so comparing raw tokens would leak length
 * through the exception before it leaked anything through timing. Hashing first makes both
 * sides 32 bytes whatever arrived.
 */
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
export const tokenMatches = (presented: string, expected: string): boolean =>
  timingSafeEqual(sha256(presented), sha256(expected));

/**
 * A fixed window, cleared wholesale when it rolls.
 *
 * Wholesale clearing is why there is no eviction policy and no timer: the Map cannot outlive
 * one window, so it is bounded by the number of distinct clients seen inside it. A sliding
 * window would be more accurate and would need per-key pruning to avoid growing without
 * bound, which is a memory leak wearing a smoothing function.
 */
export class FixedWindow {
  private started = 0;
  private counts = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** Returns null when the caller is inside its allowance, or the seconds to wait. */
  check(key: string, limit: number, nowMs: number): number | null {
    if (nowMs - this.started >= this.windowMs) {
      this.started = nowMs;
      this.counts.clear();
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    if (next <= limit) return null;
    return Math.max(1, Math.ceil((this.started + this.windowMs - nowMs) / 1000));
  }
}

export interface SecurityHooks {
  /** Injected so a test needs no wall clock, matching every other timed path here. */
  readonly now?: () => number;
}

/**
 * Register both controls as one `onRequest` hook.
 *
 * A hook rather than per-route logic, for the reason the redaction wrap is a wrap: a route
 * added later is covered without its author having to remember. Per-route checks are a
 * convention, and a convention is what the observability claim turned out to be.
 */
export function registerSecurity(
  app: FastifyInstance,
  config: SecurityConfig,
  hooks: SecurityHooks = {},
): void {
  const now = hooks.now ?? (() => Date.now());
  const window = new FixedWindow(config.windowMs);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.routeOptions?.url ?? request.url.split("?")[0];
    if (OPEN_PATHS.has(path)) return;

    /**
     * Each tier counts in its OWN bucket, which is why the key carries the tier.
     *
     * Keyed on the client alone, the two ceilings share one counter and the tighter one wins
     * for everybody: four `/gates` reads put the count at four, and the next provider-backed
     * request is compared against a limit of ten with a count of five and refused, having
     * never reached a provider. Measured against a real socket — `inject()` tests that used
     * one route at a time all passed, because none of them mixed the tiers in one window.
     *
     * Separate buckets mean a client may spend its general allowance and its provider
     * allowance in the same window. That is the intent: they bound different things.
     */
    const tier = PROVIDER_PATHS.has(path) ? "provider" : "general";
    const limit = tier === "provider" ? config.providerLimit : config.generalLimit;
    const retryAfter = window.check(`${tier}:${request.ip}`, limit, now());
    if (retryAfter !== null) {
      reply.header("retry-after", String(retryAfter));
      return reply.tooManyRequests("rate limit exceeded");
    }

    if (config.token === null) return;

    const header = request.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : null;
    // One message for every failure shape. Distinguishing "no header" from "wrong token"
    // tells an unauthenticated caller which half they got right.
    if (presented === null || !tokenMatches(presented, config.token)) {
      return reply.unauthorized("a valid bearer token is required");
    }
  });
}
