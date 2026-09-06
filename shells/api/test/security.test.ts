import { describe, expect, it } from "vitest";
import { buildApi, type ApiDependencies } from "../src/app.js";
import { startupWarning } from "../src/index.js";
import {
  securityFromEnv, tokenMatches, FixedWindow, providerCallBudgetFromEnv, type SecurityConfig,
} from "../src/security.js";
import type { Orchestrator } from "../../../application/src/orchestrator.js";
import type { ProviderTransport } from "../../../contracts/index.js";

const provider: ProviderTransport = {
  provider_id: "test",
  async generate() {
    throw new Error("not used");
  },
  async healthCheck() {
    return {
      ok: true, checked_at: "2026-09-06T00:00:00.000Z", latency_ms: 1,
      degradation_state: "NONE" as const, failing_dependency: null,
    };
  },
};

const deps: ApiDependencies = { provider, orchestrator: {} as Orchestrator, coreBuildHash: "test" };

const config = (over: Partial<SecurityConfig> = {}): SecurityConfig => ({
  // Generous by default so existing per-tier tests never brush the aggregate ceiling;
  // tests of the ceiling itself override it explicitly.
  token: null, windowMs: 60_000, generalLimit: 120, providerLimit: 10, globalProviderLimit: 1000, ...over,
});

/** A clock the test moves, so a window test needs no sleeping. */
const clock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe("bearer auth", () => {
  it("is off when no token is configured — the documented default", async () => {
    const app = buildApi(deps, config());
    const r = await app.inject({ method: "GET", url: "/api/v1/gates" });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("refuses every shape of missing or wrong credential once a token is set", async () => {
    const app = buildApi(deps, config({ token: "s3cret-token" }));
    for (const headers of [
      undefined,
      { authorization: "s3cret-token" },        // no scheme
      { authorization: "Basic s3cret-token" },  // wrong scheme
      { authorization: "Bearer " },             // empty
      { authorization: "Bearer wrong-token" },
    ]) {
      const r = await app.inject({ method: "GET", url: "/api/v1/gates", headers });
      expect(r.statusCode, `expected 401 for ${JSON.stringify(headers)}`).toBe(401);
    }
    await app.close();
  });

  it("admits the correct token", async () => {
    const app = buildApi(deps, config({ token: "s3cret-token" }));
    const r = await app.inject({
      method: "GET", url: "/api/v1/gates", headers: { authorization: "Bearer s3cret-token" },
    });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("says the same thing however the credential was wrong", async () => {
    // Distinguishing "no header" from "wrong token" tells an unauthenticated caller which
    // half they got right, which is a free hint nobody legitimate needs.
    const app = buildApi(deps, config({ token: "s3cret-token" }));
    const missing = await app.inject({ method: "GET", url: "/api/v1/gates" });
    const wrong = await app.inject({
      method: "GET", url: "/api/v1/gates", headers: { authorization: "Bearer nope" },
    });
    expect(missing.json()).toEqual(wrong.json());
    await app.close();
  });

  it("leaves /api/v1/health open, because a liveness probe is not a place for a credential", async () => {
    const app = buildApi(deps, config({ token: "s3cret-token" }));
    const r = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(r.statusCode).toBe(200);
    await app.close();
  });
});

describe("tokenMatches", () => {
  it("compares without throwing on a length mismatch", () => {
    // timingSafeEqual throws on unequal lengths, so a raw comparison would leak the token's
    // length through an exception before it leaked anything through timing.
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(() => tokenMatches("a", "a-much-longer-token")).not.toThrow();
    expect(tokenMatches("a", "a-much-longer-token")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });
});

describe("rate limiting", () => {
  it("is on even with no token, which is the point of it being separate from auth", async () => {
    const app = buildApi(deps, config({ generalLimit: 2 }));
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });

  it("answers 429 with a retry-after the caller can act on", async () => {
    const c = clock();
    const app = buildApi(deps, config({ generalLimit: 1, windowMs: 30_000 }), { now: c.now });
    await app.inject({ method: "GET", url: "/api/v1/gates" });
    const limited = await app.inject({ method: "GET", url: "/api/v1/gates" });

    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBe(30);
    await app.close();
  });

  it("holds provider-backed routes to a tighter ceiling than cheap reads", async () => {
    /**
     * The finding this closes is that any caller could trigger a full compile against a
     * provider. One ceiling cannot serve both kinds — generous enough for /gates is far too
     * generous for work that costs money.
     */
    const app = buildApi(deps, config({ generalLimit: 50, providerLimit: 2 }));
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ method: "GET", url: "/api/v1/provider/health" })).statusCode);
    }
    expect(codes.slice(0, 2)).toEqual([200, 200]);
    expect(codes[2]).toBe(429);

    // The cheap route is untouched by the provider route exhausting its own allowance.
    expect((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode).toBe(200);
    await app.close();
  });

  it("does not let cheap reads consume the provider allowance", async () => {
    /**
     * The regression a real socket found and `inject()` did not.
     *
     * Keyed on the client alone, both ceilings share one counter and the tighter one wins for
     * everybody: a few `/gates` reads put the count above the provider limit, and the next
     * provider-backed request is refused having never reached a provider. Every test above
     * passed through that bug, because each used one route at a time and none mixed the two
     * tiers inside a single window.
     */
    const app = buildApi(deps, config({ generalLimit: 50, providerLimit: 2 }));
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode).toBe(200);
    }
    // The provider allowance is untouched by the five reads above.
    expect((await app.inject({ method: "GET", url: "/api/v1/provider/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/provider/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/provider/health" })).statusCode).toBe(429);
    // And exhausting it does not close the cheap route either.
    expect((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode).toBe(200);
    await app.close();
  });

  it("exempts health, so a one-second probe cannot eat the allowance", async () => {
    const app = buildApi(deps, config({ generalLimit: 1 }));
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("restores the allowance when the window rolls", async () => {
    const c = clock();
    const app = buildApi(deps, config({ generalLimit: 1, windowMs: 1_000 }), { now: c.now });

    expect((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode).toBe(429);
    c.advance(1_000);
    expect((await app.inject({ method: "GET", url: "/api/v1/gates" })).statusCode).toBe(200);
    await app.close();
  });
});

/**
 * The residual ADR-0018 named: "the rate limit bounds requests, not spend." `providerLimit`
 * bounds one client; nothing bounded what every client spent together until this.
 */
describe("the aggregate provider ceiling", () => {
  it("refuses once the SUM across clients passes the ceiling, even though no one client does", async () => {
    const app = buildApi(deps, config({ providerLimit: 100, globalProviderLimit: 3 }));
    // Three different callers, one request each — the per-client ceiling never fires.
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      const r = await app.inject({
        method: "GET", url: "/api/v1/provider/health", remoteAddress: ip,
      });
      expect(r.statusCode, `client ${ip} should have been admitted`).toBe(200);
    }
    // A fourth caller, previously unseen, is refused — the shared budget is what is empty.
    const fourth = await app.inject({
      method: "GET", url: "/api/v1/provider/health", remoteAddress: "10.0.0.4",
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({ error: "provider budget exceeded for this window" });
    await app.close();
  });

  it("does not spend the shared budget on a request its own client-ceiling already refused", async () => {
    /**
     * Ordering matters: if a refused request still incremented the global counter, one
     * hostile client hammering past its OWN ceiling would exhaust the aggregate budget for
     * every well-behaved client too — the opposite of what an aggregate ceiling is for.
     */
    const app = buildApi(deps, config({ providerLimit: 1, globalProviderLimit: 5 }));
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: "GET", url: "/api/v1/provider/health", remoteAddress: "10.0.0.9" });
    }
    // Nine of those ten were refused by the PER-CLIENT ceiling. A fresh client still has its
    // full share of the aggregate budget, which it would not if those nine had spent it.
    const fresh = await app.inject({
      method: "GET", url: "/api/v1/provider/health", remoteAddress: "10.0.0.10",
    });
    expect(fresh.statusCode).toBe(200);
    await app.close();
  });

  it("does not apply to the general tier at all", async () => {
    // The must-not-fire half. A cheap read is not a spend, so it must never be measured
    // against a ceiling that exists to bound spend.
    const app = buildApi(deps, config({ generalLimit: 100, globalProviderLimit: 2 }));
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: "GET", url: "/api/v1/gates", remoteAddress: `10.0.1.${i}` });
      expect(r.statusCode).toBe(200);
    }
    await app.close();
  });

  it("does not spend the shared budget on a request that never had a valid credential", async () => {
    // The bug this pins: auth used to run AFTER both rate-limit checks, so an unauthenticated
    // caller — no credential needed, so no per-client ceiling protects the pool from it —
    // could exhaust `globalProviderLimit` before ever being told "no". A caller with no token
    // was never going to reach a provider, so it must never spend the budget provider calls
    // are rationed against.
    const app = buildApi(deps, config({
      token: "s3cret-token", providerLimit: 100, globalProviderLimit: 3,
    }));
    // More failed-auth attempts than the shared ceiling, each from a different address so the
    // per-client bucket (still checked first, and still a real throttle) never intervenes.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "GET", url: "/api/v1/provider/health", remoteAddress: `10.0.2.${i}`,
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(r.statusCode).toBe(401);
    }
    // The shared budget must still be full: three authenticated callers are all admitted.
    for (const ip of ["10.0.3.1", "10.0.3.2", "10.0.3.3"]) {
      const r = await app.inject({
        method: "GET", url: "/api/v1/provider/health", remoteAddress: ip,
        headers: { authorization: "Bearer s3cret-token" },
      });
      expect(r.statusCode, `client ${ip} should have been admitted`).toBe(200);
    }
    await app.close();
  });

  it("still throttles a single client's unauthenticated attempts via the per-client ceiling", async () => {
    // Moving auth ahead of the SHARED ceiling must not remove the PER-CLIENT ceiling's
    // protection against one address hammering the auth check itself — that check still runs
    // first, unauthenticated or not.
    const app = buildApi(deps, config({
      token: "s3cret-token", providerLimit: 2, globalProviderLimit: 1000,
    }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/api/v1/provider/health", remoteAddress: "10.0.4.1" });
      statuses.push(r.statusCode);
    }
    expect(statuses.slice(0, 2)).toEqual([401, 401]);
    expect(statuses.slice(2)).toEqual([429, 429, 429]);
    await app.close();
  });
});

describe("FixedWindow", () => {
  it("clears wholesale rather than pruning, so it cannot outlive one window", () => {
    // Why there is no eviction policy and no timer: the map is bounded by the clients seen
    // inside a single window. A sliding window would need per-key pruning to say the same.
    const w = new FixedWindow(1_000);
    expect(w.check("a", 1, 0)).toBeNull();
    expect(w.check("a", 1, 0)).not.toBeNull();
    expect(w.check("b", 1, 0)).toBeNull(); // a different client has its own allowance
    expect(w.check("a", 1, 1_000)).toBeNull();
  });
});

describe("securityFromEnv", () => {
  it("reads a token, and treats whitespace as absent", () => {
    expect(securityFromEnv({ NEXUSPROMPT_API_TOKEN: "abc" } as NodeJS.ProcessEnv).token).toBe("abc");
    expect(securityFromEnv({ NEXUSPROMPT_API_TOKEN: "   " } as NodeJS.ProcessEnv).token).toBeNull();
    expect(securityFromEnv({} as NodeJS.ProcessEnv).token).toBeNull();
  });

  it("refuses an unparseable limit rather than substituting a default", () => {
    // A caller who wrote RATE_LIMIT=0 meant something. Falling back would enforce a ceiling
    // they think they removed, which is the failure mode `naiveTokens || 400` already had.
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      expect(
        () => securityFromEnv({ NEXUSPROMPT_RATE_LIMIT: bad } as NodeJS.ProcessEnv),
        `expected "${bad}" to be refused`,
      ).toThrow(/positive integer/);
    }
    expect(securityFromEnv({} as NodeJS.ProcessEnv).generalLimit).toBe(120);
  });
});

describe("providerCallBudgetFromEnv", () => {
  it("declares no budget when the variable is unset, matching admitRun's default", () => {
    expect(providerCallBudgetFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("builds a refuse-on-exceed Budget from a positive integer", () => {
    expect(providerCallBudgetFromEnv({ NEXUSPROMPT_MAX_PROVIDER_CALLS: "5" } as NodeJS.ProcessEnv))
      .toEqual({ max_provider_calls: 5, max_usd: null, on_exceed: "refuse" });
  });

  it("refuses an unparseable value, the same way the rate limits do", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      expect(
        () => providerCallBudgetFromEnv({ NEXUSPROMPT_MAX_PROVIDER_CALLS: bad } as NodeJS.ProcessEnv),
        `expected "${bad}" to be refused`,
      ).toThrow(/positive integer/);
    }
  });
});

describe("startupWarning", () => {
  it("says nothing when a token is configured", () => {
    expect(startupWarning(config({ token: "abc" }), "0.0.0.0")).toBeNull();
  });

  it("warns on loopback, and names the exposure on a non-loopback bind", () => {
    const local = startupWarning(config(), "127.0.0.1");
    expect(local).toContain("NEXUSPROMPT_API_TOKEN is not set");
    expect(local).not.toContain("NON-LOOPBACK");

    const exposed = startupWarning(config(), "0.0.0.0");
    expect(exposed).toContain("NON-LOOPBACK");
    // The number an operator needs to judge the exposure, not just the fact of it.
    expect(exposed).toContain("10 provider-backed request(s)");
  });
});
