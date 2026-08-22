import { describe, it, expect } from "vitest";
import {
  RoutingPolicyInvalid, admitCostJustification, decideRoute, reduceRouteOutcome,
  routingDistribution, tierCost, validateRoutingPolicy,
} from "../src/routing/policy.js";
import type { RoutingPolicy } from "../src/routing/policy.js";

const cheap = { model_id: "small-1", family: "vendor-a", usd_per_mtok_in: 0.25, usd_per_mtok_out: 1.25 };
const mid = { model_id: "medium-1", family: "vendor-a", usd_per_mtok_in: 3, usd_per_mtok_out: 15 };
const big = { model_id: "large-1", family: "vendor-b", usd_per_mtok_in: 15, usd_per_mtok_out: 75 };

const cascade = (over: Partial<RoutingPolicy> = {}): RoutingPolicy => ({
  method: "cascade",
  tiers: [cheap, mid, big],
  escalate_on: ["gate-fail"],
  max_escalations: 2,
  ...over,
});

describe("a routing policy is validated before it can route", () => {
  it("refuses a cascade with one tier", () => {
    /**
     * The case worth naming: it validates as data, runs, never escalates, and reports itself
     * as a cascade. Nothing downstream can then distinguish "the cheap model was always
     * enough" from "there was nothing to escalate to" — which is the difference between a
     * measured result and an artifact of the ladder's length.
     */
    expect(() => validateRoutingPolicy(cascade({ tiers: [cheap] })))
      .toThrow(/can never escalate/);
  });

  it("refuses a cascade with no termination rule", () => {
    // The same hazard `topology.max_iterations` guards for the reflexive pipeline: an
    // undeclared cap is an unbounded one.
    const { max_escalations: _drop, ...rest } = cascade();
    // Asserting on /max_escalations/ alone was too loose: with this rule removed the type
    // check below still throws a message containing that word, so the test passed against a
    // policy object that had lost its termination rule entirely.
    expect(() => validateRoutingPolicy(rest as RoutingPolicy)).toThrow(/must declare max_escalations/);
  });

  it("refuses a cap the ladder cannot reach", () => {
    // Three tiers allow two escalations. A cap of five never binds, so it reads as a limit
    // while being none — the shape of a guard narrower than its name, inverted.
    expect(() => validateRoutingPolicy(cascade({ max_escalations: 5 }))).toThrow(/never binds/);
  });

  it("refuses the same model in two tiers", () => {
    expect(() => validateRoutingPolicy(cascade({ tiers: [cheap, cheap, big] })))
      .toThrow(/two tiers/);
  });

  it("refuses a cascade that declares nothing to escalate on", () => {
    expect(() => validateRoutingPolicy(cascade({ escalate_on: [] }))).toThrow(/what escalates it/);
  });

  it("accepts a fixed policy with a single tier", () => {
    expect(() => validateRoutingPolicy({ method: "fixed", tiers: [cheap] })).not.toThrow();
  });

  it("throws a named error type, not a bare Error", () => {
    expect(() => validateRoutingPolicy({ method: "fixed", tiers: [] })).toThrow(RoutingPolicyInvalid);
  });
});

describe("decide → invoke → reduce, over models", () => {
  it("starts at the cheapest tier and says so", () => {
    const d = decideRoute(cascade());
    expect(d.model_id).toBe("small-1");
    expect(d.tier_index).toBe(0);
    expect(d.escalations_used).toBe(0);
    expect(d.reason).toContain("cheapest");
  });

  it("escalates one tier on the declared signal", () => {
    const first = decideRoute(cascade());
    const next = reduceRouteOutcome(cascade(), first, { kind: "gate-fail" })!;
    expect(next.model_id).toBe("medium-1");
    expect(next.escalations_used).toBe(1);
    expect(next.reason).toContain("escalated on gate-fail");
  });

  it("does not escalate on a signal the policy did not declare", () => {
    // `escalate_on: ["gate-fail"]` only. A provider failure is a different event with a
    // different remedy, and treating every bad outcome as an escalation trigger is how a
    // cascade turns an outage into a bill.
    const first = decideRoute(cascade());
    expect(reduceRouteOutcome(cascade(), first, { kind: "provider-failure" })).toBeNull();
  });

  it("stops at the declared cap even with tiers left", () => {
    const p = cascade({ max_escalations: 1 });
    const first = decideRoute(p);
    const second = reduceRouteOutcome(p, first, { kind: "gate-fail" })!;
    expect(second.tier_index).toBe(1);
    // A third tier exists and is not reached: the cap binds before the ladder ends.
    expect(reduceRouteOutcome(p, second, { kind: "gate-fail" })).toBeNull();
  });

  it("stops at the top of the ladder", () => {
    const p = cascade();
    let d = decideRoute(p);
    for (let i = 0; i < 2; i++) d = reduceRouteOutcome(p, d, { kind: "gate-fail" })!;
    expect(d.tier_index).toBe(2);
    expect(reduceRouteOutcome(p, d, { kind: "gate-fail" })).toBeNull();
  });

  it("returns null on success rather than the same decision again", () => {
    // A terminal null the type system forces the caller to handle. Returning the current
    // decision would let a `while (decision)` loop spin forever.
    const first = decideRoute(cascade());
    expect(reduceRouteOutcome(cascade(), first, { kind: "ok" })).toBeNull();
  });

  it("never escalates a fixed policy", () => {
    const p: RoutingPolicy = { method: "fixed", tiers: [cheap, big] };
    const first = decideRoute(p);
    expect(first.model_id).toBe("small-1");
    expect(reduceRouteOutcome(p, first, { kind: "gate-fail" })).toBeNull();
  });

  it("refuses a fixed policy that carries escalation settings", () => {
    /**
     * Found by a probe, and it changed the code rather than the test.
     *
     * There was a `method === "fixed"` early return in `reduceRouteOutcome`; deleting it broke
     * nothing, because a fixed policy has no `escalate_on` for the next line to match. The
     * guard was unreachable. Rather than write a test to reach dead code, the validator now
     * refuses the configuration that would have needed it — a fixed policy declaring
     * escalation settings describes behaviour it does not have.
     */
    expect(() => validateRoutingPolicy({
      method: "fixed", tiers: [cheap, big], escalate_on: ["gate-fail"], max_escalations: 1,
    })).toThrow(/can never use/);
  });
});

describe("what a routed run has to report", () => {
  it("prices a request at the tier that answered it", () => {
    expect(tierCost(cascade(), 0, 1e6, 1e6)).toBeCloseTo(1.5, 6);
    expect(tierCost(cascade(), 2, 1e6, 1e6)).toBeCloseTo(90, 6);
  });

  it("reports the distribution, not just the mean", () => {
    /**
     * Two cascades with the same average cost and different shapes. 99% at tier 0 with a
     * rare jump to tier 2 is a different system from a 60/40 split, with different failure
     * modes, and a single averaged figure cannot tell them apart. The distribution is what
     * lets someone later ask whether the cheap tier was sufficient or merely never checked.
     */
    const finals = [
      ...Array.from({ length: 8 }, () => ({ tier_index: 0, escalations_used: 0 })),
      { tier_index: 1, escalations_used: 1 },
      { tier_index: 2, escalations_used: 2 },
    ];
    const d = routingDistribution(3, finals);
    expect(d.by_tier).toEqual([8, 1, 1]);
    expect(d.escalations).toBe(3);
    expect(d.cheapest_share).toBeCloseTo(0.8, 6);
  });

  it("reports an empty run as zero share, not as a perfect one", () => {
    const d = routingDistribution(3, []);
    expect(d.cheapest_share).toBe(0);
    expect(d.by_tier).toEqual([0, 0, 0]);
  });
});

describe("a promotion may not be justified by cost", () => {
  it("refuses a cost claim resting on an inconclusive quality comparison", () => {
    /**
     * The routing-specific guard, and the reason this module carries a refusal at all.
     *
     * "The comparison was inconclusive, so quality held" is the argument a router is adopted
     * on, and it is invalid. Inconclusive means the suite could not separate the two
     * configurations — with the suites here, none of which resolves below about fifty
     * percentage points, it means very little indeed. Establishing equivalence is a
     * different procedure with a different null hypothesis.
     */
    const a = admitCostJustification({ justification: "cost", qualityVerdict: "inconclusive" });
    expect(a.admit).toBe(false);
    expect(a.code).toBe("no-non-inferiority-test");
    expect(a.reason).toContain("not that they are equivalent");
  });

  it("refuses a cost claim even when quality improved", () => {
    // Cheaper AND better is the happy case, and it is still refused as a COST justification:
    // promote it on the quality result, which the system can actually certify. Accepting it
    // here would establish the cost path as promotable and the next one would not be better.
    const a = admitCostJustification({ justification: "cost", qualityVerdict: "improved" });
    expect(a.admit).toBe(false);
    expect(a.code).toBe("no-non-inferiority-test");
  });

  it("names a measured regression as its own refusal, not as a missing test", () => {
    // A different reason deserves a different code: here the evidence exists and says no.
    const a = admitCostJustification({ justification: "cost", qualityVerdict: "regressed" });
    expect(a.code).toBe("quality-regressed");
    expect(a.reason).toContain("not a promotion");
  });

  it("passes a quality-justified promotion through untouched", () => {
    const a = admitCostJustification({ justification: "quality", qualityVerdict: "improved" });
    expect(a.admit).toBe(true);
    expect(a.code).toBe("ok");
  });

  it("does not become admissible by declaring a margin without implementing the test", () => {
    const a = admitCostJustification({
      justification: "cost", qualityVerdict: "inconclusive", nonInferiorityMargin: 0.02,
    });
    expect(a.admit).toBe(false);
    expect(a.reason).toContain("none is implemented");
  });
});
