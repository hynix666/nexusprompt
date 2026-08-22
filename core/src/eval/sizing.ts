/**
 * How large a suite must be, and what a comparison could have shown.
 *
 * Pure. Every function here is arithmetic over a design, not over an outcome.
 *
 * ── The defect this module corrects ──────────────────────────────────────────
 *
 * `requiredAnchorSize` (still exported from `compare.ts`, now delegating here) implements
 * `n ≳ z² / (2Δ²)`. That is the conditional McNemar sizing rule with two parameters
 * silently pinned:
 *
 *   - **power fixed at 50%.** The general form carries `(z_α + z_β)²`; setting `z_β = 0`
 *     means 1 − β = 0.5. A suite sized this way misses a real effect of exactly the size it
 *     was built for half the time, and reports that miss as "no difference".
 *   - **discordance fixed at 50%.** Only discordant pairs carry information in a paired
 *     binary test, so the informative sample size is `n · p_d`, not `n`. Two configurations
 *     of the same system typically agree on most cases; `p_d = 0.5` is the most favourable
 *     value the rule could have assumed.
 *
 * Neither assumption was stated, and both are optimistic. The corrected form is
 *
 *     n ≳ (z_α + z_β)² · p_d / Δ²
 *
 * which reduces to the old rule exactly when `p_d = 0.5` and `z_β = 0`.
 *
 * The gap is not academic. At Δ = 0.15 the old rule returns 61 items; τ²-bench reports its
 * 114 paired tasks as resolving roughly 15 percentage points, and the corrected rule
 * reproduces that count at a discordance rate near 0.33. The figure quoted throughout this
 * repository — "≈3,400 items for two percentage points" — is ≈9,800 at 80% power, and the
 * old number is recoverable only by also assuming the most generous discordance rate
 * available. Both figures are exported below so a document can pin either one and say which.
 *
 * ── Why an exact floor rather than a power curve ─────────────────────────────
 *
 * `floorDiscordant` is the sharper instrument and the one the comparator enforces, because
 * it needs no assumption at all. Under McNemar the test statistic is binomial(d, 0.5), so
 * the smallest two-sided p-value ANY arrangement of d discordant pairs can produce is
 * `2 · 0.5^d`. At α = 0.05 that clears only from d = 6 upward. Five discordant pairs bottom
 * out at 0.0625: the test cannot reject, whatever the data say.
 *
 * This is a statement about the support of the statistic — a property of the design — and is
 * therefore NOT the discredited post-hoc power calculation, which is a monotone function of
 * the observed p-value and adds nothing to it. Nothing here is computed from the p-value.
 *
 * `eval/compile-smoke.json` has carried the sentence "resolving a difference takes six
 * flips, not one" in its comment block since it was written. Six is exactly right. No code
 * knew it until this module.
 */

/** Two-sided normal quantile, |z| such that P(|Z| > z) = p. */
const Z_TWO_SIDED_05 = 1.959963984540054;
/** One-sided normal quantile at 0.05, kept for the legacy rule's arithmetic. */
const Z_ONE_SIDED_05 = 1.6448536269514722;
/** Normal quantile at 80% power. */
const Z_POWER_80 = 0.8416212335729143;

export interface SizingAssumptions {
  /** Significance level, after any multiplicity correction. */
  alpha: number;
  /**
   * Probability of rejecting a true effect of the target size. Required, not defaulted:
   * the whole defect corrected here was a power assumption nobody could see.
   */
  power: number;
  /**
   * Expected fraction of cases on which the two configurations disagree. Only these carry
   * information. Required for the same reason — the old rule's implicit 0.5 was its most
   * optimistic possible value.
   */
  discordanceRate: number;
}

/**
 * The smallest number of discordant pairs at which the exact two-sided binomial test can
 * attain significance. Below this, no arrangement of outcomes rejects.
 *
 * Exact and assumption-free: solves `2 · 0.5^d ≤ alpha` for the least integer d. Returns
 * `Infinity` for alpha ≤ 0, which no caller should reach but which must not silently
 * become a small number.
 */
export function floorDiscordant(alpha: number): number {
  if (!(alpha > 0)) return Infinity;
  if (alpha >= 1) return 0;
  let d = 0;
  // At most ~60 iterations for any representable alpha; a loop rather than a log so the
  // boundary case is decided by the same arithmetic the comparator uses, not by rounding.
  while (minAttainableP(d) > alpha) {
    d += 1;
    if (d > 4096) return Infinity;
  }
  return d;
}

/**
 * The smallest two-sided p-value a design with this many discordant pairs could produce.
 *
 * Depends on the discordant count alone. Zero discordant pairs give 1: the two runs agreed
 * everywhere, and agreement is not evidence of equivalence.
 */
export function minAttainableP(discordant: number): number {
  if (discordant <= 0) return 1;
  return Math.min(1, 2 * Math.pow(0.5, discordant));
}

/** Whether a design with this many discordant pairs could have produced a significant result. */
export const attainable = (discordant: number, alpha: number): boolean =>
  minAttainableP(discordant) <= alpha;

/** Normal quantile via Acklam's rational approximation. Accurate to ~1.15e-9 across the range. */
function normalQuantile(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
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

/** z at a two-sided alpha. */
const zAlpha = (alpha: number): number => normalQuantile(1 - alpha / 2);
/** z at a given power. 50% power gives 0, which is the legacy rule's implicit value. */
const zPower = (power: number): number => normalQuantile(power);

/**
 * Items needed to resolve a true difference of `delta`, with power and discordance stated.
 *
 * `n ≳ (z_α + z_β)² · p_d / Δ²`. Every term is an argument, so a caller cannot inherit an
 * assumption without writing it down. The result is the TOTAL item count; multiply by
 * `discordanceRate` for the informative subset the test actually runs on.
 */
export function requiredPairedSize(delta: number, assumptions: SizingAssumptions): number {
  const { alpha, power, discordanceRate } = assumptions;
  if (!(delta > 0)) throw new Error(`requiredPairedSize needs a positive delta, got ${delta}.`);
  if (!(discordanceRate > 0 && discordanceRate <= 1)) {
    throw new Error(
      `discordanceRate must be in (0, 1], got ${discordanceRate}. Zero discordance means the ` +
      `two configurations never disagree, and no sample size makes that test informative.`,
    );
  }
  const z = zAlpha(alpha) + zPower(power);
  return Math.ceil((z * z * discordanceRate) / (delta * delta));
}

/**
 * The inverse: the smallest delta a suite of `n` items can resolve under these assumptions.
 *
 * This is the number a suite may honestly claim. It is what `detectable_delta` was described
 * as in `eval-suite` 2.0.0 and never was in any instance — the smoke suite declares 0.0714
 * and resolves 0.53.
 */
export function resolvableDelta(n: number, assumptions: SizingAssumptions): number {
  const { alpha, power, discordanceRate } = assumptions;
  if (!(n > 0)) return Infinity;
  const z = zAlpha(alpha) + zPower(power);
  return z * Math.sqrt(discordanceRate / n);
}

/**
 * The legacy rule, preserved exactly, with its hidden parameters named.
 *
 * Kept because three documents and a test cite its output. Calling it is not wrong; citing
 * it without its assumptions is. `requiredPairedSize(delta, LEGACY_ASSUMPTIONS)` returns the
 * same value up to the one-sided/two-sided z difference, and that equivalence is pinned by a
 * test so the two rules cannot drift apart.
 */
export const LEGACY_ASSUMPTIONS: SizingAssumptions = {
  alpha: 0.05,
  /** z_β = 0. The rule's `z²` carries no power term at all. */
  power: 0.5,
  /** The `2` in the denominator is `1 / p_d` at `p_d = 0.5`. */
  discordanceRate: 0.5,
};

/** Assumptions this repository quotes as honest: 80% power, and the same generous discordance. */
export const STATED_ASSUMPTIONS: SizingAssumptions = {
  alpha: 0.05,
  power: 0.8,
  discordanceRate: 0.5,
};

/** The old rule's own arithmetic, so `compare.ts` keeps one implementation and one meaning. */
export function legacyAnchorSize(detectableDelta: number, confidence = 0.95): number {
  const z = confidence === 0.95 ? Z_ONE_SIDED_05 : normalQuantile(confidence);
  return Math.ceil((z * z) / (2 * detectableDelta * detectableDelta));
}

/** Exported so a test can assert the constants are the ones the comments claim. */
export const QUANTILES = { Z_TWO_SIDED_05, Z_ONE_SIDED_05, Z_POWER_80 } as const;
