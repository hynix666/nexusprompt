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
 *
 * ── ADR-0018's residual, closed in ADR-0019 ──────────────────────────────────
 *
 * ADR-0018 named two things this file did not yet do: "a deployment that never sets the
 * token is unauthenticated, and nothing stops it", and "the rate limit bounds requests, not
 * spend." `createApiServer` (in `index.ts`, the only place that knows the host) now refuses to
 * start on a non-loopback bind with no token, and
 * `globalProviderLimit` below is a SECOND, aggregate ceiling on provider-tier requests —
 * `providerLimit` bounds one client, `globalProviderLimit` bounds all of them added
 * together, which a per-client-only ceiling cannot: N different source addresses each
 * spending their own allowance has no aggregate limit without it.
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
  /**
   * Provider-tier requests per window, summed across every client.
   *
   * `providerLimit` bounds what ONE client can spend; nothing bounded what all of them
   * spend together until this. Only incremented for a request `providerLimit` already
   * admitted, so a client refused by its own ceiling never counts against this one too.
   */
  readonly globalProviderLimit: number;
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

/**
 * The bucket every client's admitted provider-tier request counts against, together.
 *
 * `request.ip` can never literally be the string "*" — `trustProxy` is off, so Fastify
 * derives it from the socket's own remote address, never from a header a client controls.
 */
const GLOBAL_PROVIDER_KEY = "provider:*";

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
    globalProviderLimit: positiveInt(env.NEXUSPROMPT_GLOBAL_PROVIDER_LIMIT, 50),
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

    /**
     * Auth, checked before the SHARED ceiling but after the per-client one.
     *
     * The per-client bucket above still throttles an unauthenticated caller — brute-forcing
     * the token from one address is still bounded by `providerLimit`/`generalLimit`, keyed
     * per IP, so this ordering does not remove that protection. What it removes is the global
     * ceiling counting a request that was never going to be admitted anyway: `providerLimit`
     * bounds one client's spend, but `globalProviderLimit` is the budget every *legitimate*
     * client shares, and a caller with no credential at all is not one of them. Checking auth
     * first means credential-less traffic can only ever exhaust its own per-client allowance,
     * never the pool every authenticated caller draws from.
     */
    if (config.token !== null) {
      const header = request.headers.authorization;
      const presented = typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : null;
      // One message for every failure shape. Distinguishing "no header" from "wrong token"
      // tells an unauthenticated caller which half they got right.
      if (presented === null || !tokenMatches(presented, config.token)) {
        return reply.unauthorized("a valid bearer token is required");
      }
    }

    /**
     * The aggregate ceiling, checked only once the per-client one — and auth — have admitted.
     *
     * Ordering matters twice here: a request the per-client check would have refused anyway
     * must not also spend a unit of the shared budget, or one hostile client could exhaust the
     * global ceiling for every well-behaved one purely by being refused over and over. The same
     * argument is why auth runs first — an unauthenticated request was never going to reach a
     * provider, so it must not spend the budget provider calls are rationed against either.
     *
     * `GLOBAL_PROVIDER_KEY` shares `window` with the per-tier buckets above — one Map, one
     * roll — because a second `FixedWindow` instance would roll on its own schedule and the
     * two ceilings could disagree about which window a request fell in.
     */
    if (tier === "provider") {
      const globalRetryAfter = window.check(GLOBAL_PROVIDER_KEY, config.globalProviderLimit, now());
      if (globalRetryAfter !== null) {
        reply.header("retry-after", String(globalRetryAfter));
        return reply.tooManyRequests("provider budget exceeded for this window");
      }
    }
  });
}

/**
 * The Orchestrator's own `Budget`, from the environment. Not a Core import: `shells` may not
 * import `core/` directly (ADR-0001, amended by ADR-0005), so this returns an object shaped
 * to satisfy `Budget` structurally, the same way `shells/cli` constructs one inline.
 *
 * `undefined` means no budget declared, which `admitRun` treats as "admit everything" — the
 * default every other budget-checked path in this repository uses.
 *
 * This is NOT the spend control; `globalProviderLimit` above is. `Orchestrator.run()` always
 * attempts `maxAttempts` (a constant, currently 3) provider calls for the one stage the API's
 * compile route runs, so `max_provider_calls` here can only ever admit every request or
 * refuse every request — there is no request volume it modulates, because nothing about a
 * single request varies the count `admitRun` compares it against. Setting it below 3 refuses
 * every compile permanently, which is a real and intentional use — "disable this route
 * without touching auth" — not a misconfiguration this function tries to prevent. It exists
 * so the API is not the one path where `admitRun` is unarmed, not because it modulates spend.
 */
export function providerCallBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { max_provider_calls: number; max_usd: null; on_exceed: "refuse" } | null {
  if (env.NEXUSPROMPT_MAX_PROVIDER_CALLS === undefined) return null;
  return {
    // positiveInt's fallback branch is unreachable here: the undefined case already returned.
    max_provider_calls: positiveInt(env.NEXUSPROMPT_MAX_PROVIDER_CALLS, -1),
    max_usd: null,
    on_exceed: "refuse",
  };
}
