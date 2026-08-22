/**
 * Part 10 — routing. Which model answers, and why.
 *
 * Pure. `decideRoute` returns a decision about a call that has not happened; the Application
 * makes the call, classifies the outcome, and calls `reduceRouteOutcome` to get the next
 * decision. `decide → invoke → reduce`, the third time this shape appears here — after the
 * provider loop and the gate-feedback loop — which is the argument for routing needing no
 * new layer. ADR-0008 left that open ("whether routing belongs in Application or becomes its
 * own layer once more than one model is in play"); it does not.
 *
 * ── What silence does routing break? ─────────────────────────────────────────
 *
 * "This configuration is paying frontier prices for work a cheaper model does identically."
 *
 * And its mirror, which is the dangerous one and the reason this module carries a refusal
 * rather than only a policy: **"this configuration got cheaper and quietly got worse."** A
 * cascade that escalates rarely looks like a clean cost win, and the quality it lost is
 * invisible in an aggregate dominated by easy cases. Cost is legible immediately; the
 * regression is legible a quarter later.
 *
 * ── Routing is a configuration change, not a deployment setting ──────────────
 *
 * `configurationId` hashes the whole `Configuration`, `router_policy_ref` included, so a
 * routed configuration is a different configuration and is measured as one. That is what
 * keeps a router inside the evaluation protocol instead of beside it.
 *
 * ── One router already exists ────────────────────────────────────────────────
 *
 * ADR-0008: "anything a verifier can settle must not reach [a judge] — that partition is the
 * routing rule", and `admitJudge` enforces it. This module is the *second* router, over
 * models rather than graders, and it deliberately mirrors that one: a decision rule with an
 * explicit reason, refusable, checked before the call rather than reported after it.
 */

/** One model a policy may route to, with the cost of using it. */
export interface RoutingTier {
  model_id: string;
  /** Needed so a routed run can still be checked against "the judge is never the model under test". */
  family: string;
  usd_per_mtok_in: number;
  usd_per_mtok_out: number;
}

export type RoutingMethod = "fixed" | "cascade";

export interface RoutingPolicy {
  /**
   * `fixed` always uses tier 0 and exists so an unrouted configuration and a routed one are
   * the same code path — a policy that is bypassed for the common case is a policy whose
   * common case is untested.
   *
   * `cascade` starts at the cheapest tier and escalates on a named signal.
   */
  method: RoutingMethod;
  /** Cheapest first. Order is the policy; the escalation rule does not re-sort. */
  tiers: readonly RoutingTier[];
  /**
   * What escalates. Required for `cascade` and meaningless for `fixed`.
   *
   * `gate-fail` reuses the verdict signal Phase β made a bounded control signal, rather
   * than inventing a second notion of "the output was not good enough".
   */
  escalate_on?: readonly ("gate-fail" | "provider-failure")[];
  /**
   * How many escalations one request may make. Required for `cascade`, for the same reason
   * `topology.max_iterations` is required for a reflexive topology: the recorded hazard for
   * a retry loop is unbounded retry with no termination rule.
   */
  max_escalations?: number;
}

export interface RouteDecision {
  model_id: string;
  tier_index: number;
  /** Present whether or not this was an escalation. "Why this model" is always answerable. */
  reason: string;
  escalations_used: number;
}

export interface RouteOutcome {
  /** What happened to the call the previous decision authorised. */
  kind: "ok" | "gate-fail" | "provider-failure";
}

export class RoutingPolicyInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingPolicyInvalid";
  }
}

/**
 * Reject a policy that cannot be executed, at the point it is read rather than mid-run.
 *
 * A cascade with one tier is the case worth naming: it validates, it runs, it never
 * escalates, and it reports itself as a cascade. Nothing downstream can tell it from a
 * cascade whose escalations never fired — which is the difference between "the cheap model
 * was always enough" and "there was nothing to escalate to".
 */
export function validateRoutingPolicy(policy: RoutingPolicy): void {
  if (policy.tiers.length === 0) {
    throw new RoutingPolicyInvalid("a routing policy needs at least one tier");
  }
  const ids = new Set(policy.tiers.map((t) => t.model_id));
  if (ids.size !== policy.tiers.length) {
    throw new RoutingPolicyInvalid(
      "a routing policy names the same model in two tiers; the tier order IS the policy, so a " +
      "duplicate makes 'which tier answered' unanswerable",
    );
  }
  if (policy.method === "fixed") {
    /**
     * A fixed policy carrying escalation settings reads as a cascade and behaves as a single
     * choice. Accepting it and ignoring the fields is how `router_policy_ref` spent 1.0.0
     * through 1.2.0 as a field that existed and meant nothing — refusing is cheaper than
     * documenting that they are ignored, and it is what lets `reduceRouteOutcome` below
     * derive non-escalation from `escalate_on` alone instead of carrying a second guard.
     */
    if (policy.escalate_on?.length || policy.max_escalations != null) {
      throw new RoutingPolicyInvalid(
        'a "fixed" policy declares escalation settings it can never use. Either it is a ' +
        'cascade, or those fields do not belong on it — a configuration that describes ' +
        'behaviour it does not have is worse than one that describes none.',
      );
    }
  }

  if (policy.method === "cascade") {
    if (policy.tiers.length < 2) {
      throw new RoutingPolicyInvalid(
        "a cascade with one tier can never escalate. It would report itself as a cascade whose " +
        "escalations never fired, which is indistinguishable from a cheap model always sufficing. " +
        "Declare method \"fixed\" instead.",
      );
    }
    if (!policy.escalate_on || policy.escalate_on.length === 0) {
      throw new RoutingPolicyInvalid("a cascade must declare what escalates it");
    }
    if (policy.max_escalations === undefined || policy.max_escalations === null) {
      throw new RoutingPolicyInvalid(
        "a cascade must declare max_escalations. The recorded hazard for a retry loop is " +
        "unbounded retry with no termination rule, and an undeclared cap is unbounded.",
      );
    }
    if (!Number.isInteger(policy.max_escalations) || policy.max_escalations < 1) {
      throw new RoutingPolicyInvalid(`max_escalations must be a positive integer, got ${policy.max_escalations}`);
    }
    if (policy.max_escalations > policy.tiers.length - 1) {
      throw new RoutingPolicyInvalid(
        `max_escalations ${policy.max_escalations} exceeds the ${policy.tiers.length - 1} escalation(s) ` +
        `${policy.tiers.length} tiers allow. A cap above what the ladder permits is a cap that never binds.`,
      );
    }
  }
}

/** The first model to try. Cheapest for a cascade, tier 0 for fixed — which is the same index. */
export function decideRoute(policy: RoutingPolicy): RouteDecision {
  validateRoutingPolicy(policy);
  const tier = policy.tiers[0];
  return {
    model_id: tier.model_id,
    tier_index: 0,
    escalations_used: 0,
    reason: policy.method === "fixed"
      ? `fixed policy, single tier ${tier.model_id}`
      : `cascade start at the cheapest tier ${tier.model_id}`,
  };
}

/**
 * Given what happened, decide whether to escalate.
 *
 * Returns `null` when the run is finished — deliberately, rather than returning the same
 * decision again. A caller that loops until the decision stops changing would spin forever
 * on a policy that always returns its current tier; `null` is a terminal value the type
 * system makes the caller handle.
 */
export function reduceRouteOutcome(
  policy: RoutingPolicy,
  current: RouteDecision,
  outcome: RouteOutcome,
): RouteDecision | null {
  validateRoutingPolicy(policy);
  if (outcome.kind === "ok") return null;

  /**
   * A fixed policy never escalates, and that follows from `escalate_on` being empty rather
   * than from a second check on `method`.
   *
   * There WAS a `method === "fixed"` early return here. A mutation probe deleted it and every
   * test still passed, because validation refuses escalation settings on a fixed policy, so
   * the list is always empty and the line could never be the one that returned. Dead code
   * shaped like a guard is worse than no code: it invites the belief that something is being
   * protected, and it cannot fail in a way anyone would notice.
   */
  const escalates = (policy.escalate_on ?? []).includes(outcome.kind);
  if (!escalates) return null;

  if (current.escalations_used >= (policy.max_escalations ?? 0)) return null;
  const next = current.tier_index + 1;
  if (next >= policy.tiers.length) return null;

  const tier = policy.tiers[next];
  return {
    model_id: tier.model_id,
    tier_index: next,
    escalations_used: current.escalations_used + 1,
    reason:
      `escalated on ${outcome.kind} from ${policy.tiers[current.tier_index].model_id} to ` +
      `${tier.model_id} (escalation ${current.escalations_used + 1} of ${policy.max_escalations})`,
  };
}

/** What one request cost under a policy, given the tier that finally answered. */
export function tierCost(
  policy: RoutingPolicy,
  tier_index: number,
  tokens_in: number,
  tokens_out: number,
): number {
  const t = policy.tiers[tier_index];
  return (tokens_in / 1e6) * t.usd_per_mtok_in + (tokens_out / 1e6) * t.usd_per_mtok_out;
}

export interface RoutingDistribution {
  /** How many requests each tier finally answered, by index. */
  by_tier: number[];
  escalations: number;
  /** Requests answered by the cheapest tier, as a fraction. The number a cost case is made on. */
  cheapest_share: number;
}

/**
 * The distribution a routed run must report.
 *
 * A single averaged cost figure hides the shape that matters: a cascade answering 99% of
 * requests at tier 0 and 1% at tier 3 has the same mean as one splitting 60/40, and they are
 * different systems with different failure modes. Reporting the distribution is what lets
 * anyone later ask whether the cheap tier was actually sufficient or merely never checked.
 */
export function routingDistribution(
  tierCount: number,
  finals: readonly { tier_index: number; escalations_used: number }[],
): RoutingDistribution {
  const by_tier = new Array(tierCount).fill(0) as number[];
  let escalations = 0;
  for (const f of finals) {
    by_tier[f.tier_index] = (by_tier[f.tier_index] ?? 0) + 1;
    escalations += f.escalations_used;
  }
  return {
    by_tier,
    escalations,
    cheapest_share: finals.length === 0 ? 0 : (by_tier[0] ?? 0) / finals.length,
  };
}

/* ── The refusal that matters more than the policy ────────────────────────── */

export type CostJustification = "quality" | "cost";

export interface CostAdmission {
  admit: boolean;
  reason: string;
  code: "ok" | "no-non-inferiority-test" | "quality-regressed";
}

/**
 * May a promotion be justified by cost rather than by quality?
 *
 * **No, and this is the routing-specific guard.** A router is adopted on a cost number, and
 * the quality argument accompanying it is almost always "the comparison was inconclusive, so
 * quality held". That inference is invalid, and invalid in the direction this whole
 * repository exists to catch.
 *
 * `inconclusive` means the suite could not separate the two configurations. It does not mean
 * they are equivalent. Establishing equivalence is a *different procedure* — a
 * non-inferiority test against a declared margin, where the null hypothesis is that the
 * candidate is worse by at least the margin and rejecting it is what licenses the claim.
 * Superiority tests cannot be read backwards: failing to reject "no difference" is not
 * evidence for "no difference", and with the suites here — none of which can resolve
 * anything below about fifty percentage points — it is barely evidence of anything at all.
 *
 * So this refuses, and names the missing procedure rather than substituting the one that
 * exists. Exactly the shape of the comparator's `bootstrap-ci` refusal: the test is declared,
 * unimplemented, and refused rather than silently swapped for a test of a different question.
 */
export function admitCostJustification(input: {
  justification: CostJustification;
  /** The quality comparison's verdict, for the same two configurations. */
  qualityVerdict: "improved" | "regressed" | "inconclusive" | "refused";
  /** Declared non-inferiority margin, if the suite carries one. None do yet. */
  nonInferiorityMargin?: number | null;
}): CostAdmission {
  if (input.justification === "quality") {
    return { admit: true, code: "ok", reason: "justified on quality; cost is not the claim" };
  }

  if (input.qualityVerdict === "regressed") {
    return {
      admit: false,
      code: "quality-regressed",
      reason:
        "the cheaper configuration measurably regressed on quality. A cost saving bought with a " +
        "measured quality loss is a trade someone may want to make, but it is not a promotion — " +
        "it is a different product decision, and it must not be recorded as an improvement.",
    };
  }

  return {
    admit: false,
    code: "no-non-inferiority-test",
    reason:
      `a cost-justified promotion needs a non-inferiority test against a declared margin, and ` +
      `none is implemented (margin ${input.nonInferiorityMargin ?? "undeclared"}). The quality ` +
      `comparison returned "${input.qualityVerdict}", which says the suite could not separate the ` +
      `two configurations — not that they are equivalent. Reading a superiority test backwards is ` +
      `how a router gets adopted on a cost number while the regression it bought stays invisible.`,
  };
}
