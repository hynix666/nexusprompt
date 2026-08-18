/**
 * The comparator. Pure: given two runs' per-case outcomes, decide whether the
 * candidate is better, worse, or whether the question cannot be answered.
 *
 * Three things here are deliberate and each exists because omitting it manufactures
 * confidence:
 *
 *  1. `inconclusive` is a real verdict. With stochastic decoding a single run pair
 *     cannot separate improvement from noise, and rounding toward a decision is how
 *     a suite starts reporting its own variance as progress.
 *  2. `refused` is a real verdict. Runs measured under different configurations, or
 *     scored by detectors of unequal recall, are not comparable — and an intervention
 *     has already been observed appearing to raise hallucination by 10-15 points purely
 *     because structured output made failures easier to find.
 *  3. Alpha is corrected for multiplicity. An optimizer generates comparisons by
 *     construction: a hundred candidates against one baseline at a nominal 0.05
 *     expects roughly five spurious winners. That is a Goodhart channel distinct from
 *     a writable evaluator and from an undersized anchor, and it is invisible unless
 *     the family size travels with the comparison.
 */

import type { Comparison, EvalSuite } from "../../../contracts/index.js";

export interface CaseOutcome {
  case_id: string;
  passed: boolean;
}

export interface CompareInput {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  candidate: readonly CaseOutcome[];
  baseline: readonly CaseOutcome[];
  suite: Pick<EvalSuite, "resolution">;
  /** How many comparisons this one belongs to. 1 means a standalone comparison. */
  comparisons_in_family: number;
  /** Nominal significance level, before correction. */
  alpha: number;
  detectors_equalized: boolean;
  correction?: "none" | "bonferroni";
}

/** Two-sided exact binomial tail for McNemar: P(X <= min | X ~ Bin(n, 0.5)) * 2. */
function exactTwoSided(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  // Sum the lower tail with logs so large n does not overflow the coefficients.
  let logSum = -Infinity;
  let logCoef = 0; // log C(n,0) = 0
  const logAdd = (x: number, y: number) =>
    x === -Infinity ? y : y === -Infinity ? x : Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y)));
  for (let k = 0; k <= lo; k++) {
    if (k > 0) logCoef += Math.log((n - k + 1) / k);
    logSum = logAdd(logSum, logCoef);
  }
  const p = 2 * Math.exp(logSum + n * Math.log(0.5));
  return Math.min(1, p);
}

/**
 * McNemar on the discordant pairs. Exact binomial throughout: the chi-square form is
 * an approximation that misbehaves exactly where a smoke suite lives — small counts.
 */
export function mcnemar(b: number, c: number): { p: number; discordant: number } {
  return { p: exactTwoSided(b, c), discordant: b + c };
}

export function compare(input: CompareInput): Comparison {
  const {
    comparison_id, candidate_run_id, baseline_id, candidate, baseline,
    suite, comparisons_in_family, alpha, detectors_equalized,
  } = input;
  const correction = input.correction ?? (comparisons_in_family > 1 ? "bonferroni" : "none");
  const correctedAlpha = correction === "bonferroni" ? alpha / comparisons_in_family : alpha;

  const refuse = (reason: string): Comparison => ({
    comparison_id, candidate_run_id, baseline_id,
    verdict: "refused", refusal_reason: reason, delta: null,
    protocol: { test: "none", trials: 1, alpha: correctedAlpha, comparisons_in_family, correction, p_value: null },
    detectors_equalized,
  });

  if (!detectors_equalized) {
    return refuse("detectors were not shown to have comparable recall; the comparison would measure the instrument");
  }
  if (candidate.length === 0 || baseline.length === 0) {
    return refuse("one side has no cases");
  }

  const baseById = new Map(baseline.map((o) => [o.case_id, o.passed]));
  const paired = candidate.filter((o) => baseById.has(o.case_id));
  if (paired.length !== candidate.length || paired.length !== baseline.length) {
    return refuse(
      `case sets differ — ${candidate.length} candidate, ${baseline.length} baseline, ${paired.length} shared; ` +
      `a paired test needs the same cases on both sides`,
    );
  }

  let b = 0; // candidate passed, baseline failed
  let c = 0; // candidate failed, baseline passed
  for (const o of paired) {
    const was = baseById.get(o.case_id)!;
    if (o.passed && !was) b++;
    else if (!o.passed && was) c++;
  }

  const candScore = paired.filter((o) => o.passed).length / paired.length;
  const baseScore = baseline.filter((o) => o.passed).length / baseline.length;
  const delta = candScore - baseScore;

  const { p, discordant } = mcnemar(b, c);
  const protocol = {
    test: "mcnemar" as const,
    trials: 1,
    alpha: correctedAlpha,
    comparisons_in_family,
    correction,
    p_value: p,
  };

  // A suite cannot evidence a difference it was never sized to see. Reporting a
  // significant p over a delta below the declared resolution would be reporting noise
  // that happened to clear a threshold.
  if (Math.abs(delta) > 0 && Math.abs(delta) < suite.resolution.detectable_delta) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: `delta ${delta.toFixed(4)} is below the suite's declared resolution of ${suite.resolution.detectable_delta}`,
      delta, protocol, detectors_equalized,
    };
  }

  if (discordant === 0 || p >= correctedAlpha) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: discordant === 0
        ? "no discordant pairs — the two runs agree on every case"
        : `p=${p.toFixed(4)} does not clear alpha=${correctedAlpha.toFixed(4)}`,
      delta, protocol, detectors_equalized,
    };
  }

  return {
    comparison_id, candidate_run_id, baseline_id,
    verdict: delta > 0 ? "improved" : "regressed",
    refusal_reason: null,
    delta, protocol, detectors_equalized,
  };
}

/**
 * The anchor sizing rule, as a function rather than a remark: resolving a true gap of
 * `delta` at one-sided confidence `1 - epsilon` needs roughly z^2 / (2 delta^2) items.
 * At epsilon 0.05 and two percentage points that is about 3,400 — three orders of
 * magnitude above a suite that runs in seconds, which is why smoke and anchor are
 * different objects rather than the same one at different sizes.
 */
export function requiredAnchorSize(detectableDelta: number, confidence = 0.95): number {
  const z = zOneSided(1 - confidence);
  return Math.ceil((z * z) / (2 * detectableDelta * detectableDelta));
}

/** Inverse normal CDF (Acklam's rational approximation), one-sided upper tail. */
function zOneSided(epsilon: number): number {
  const p = 1 - epsilon;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
