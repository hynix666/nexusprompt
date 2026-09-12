/**
 * The exact (Clopper-Pearson) interval for a gate's precision — pure, like everything in Core.
 *
 * Precision is TP / firings, and the firings this is built for are few: in the first corpus the
 * per-gate counts run from 1 to 84. At those sizes the usual normal approximation is not merely
 * imprecise, it is wrong in the direction that flatters: a Wald interval on 1 of 1 is [1, 1],
 * which reports certainty from a single observation. The exact interval returns [0.025, 1]
 * there, which is the honest reading of one firing.
 *
 * Nothing in Core exported an interval before this. `compare.ts` has `exactTwoSided`, but that
 * is a tail probability for McNemar's test and answers a different question; it is private, and
 * it stays private.
 *
 * `null` for n = 0 is the "two zeros" discipline the rest of the evaluation plane already
 * keeps: a gate that never fired has no precision, which is not a precision of 0, and not of 1.
 */

export interface PrecisionInterval {
  /** Firings judged a real defect. */
  tp: number;
  /** Firings judged at all. */
  n: number;
  /** tp / n. Never report it without the bounds and `n` beside it. */
  point: number;
  lower: number;
  upper: number;
  confidence: number;
}

/**
 * P(X <= k | X ~ Bin(n, p)), summed in log space.
 *
 * Same reason as `exactTwoSided`: the coefficients overflow a double long before the counts
 * here become interesting, and a sum that overflows silently returns a bound nobody can check.
 */
function binomialCdf(k: number, n: number, p: number): number {
  if (k >= n) return 1;
  if (k < 0) return 0;
  if (p <= 0) return 1;
  if (p >= 1) return 0;

  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  const logAdd = (x: number, y: number) =>
    x === -Infinity ? y : y === -Infinity ? x : Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y)));

  let logCoef = 0; // log C(n, 0)
  let logSum = -Infinity;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logCoef += Math.log((n - i + 1) / i);
    logSum = logAdd(logSum, logCoef + i * logP + (n - i) * logQ);
  }
  return Math.min(1, Math.exp(logSum));
}

/**
 * Bisection, not a closed form: the beta quantile this needs has no elementary inverse, and a
 * rational approximation to it would put an unverifiable constant table in Core. 200 halvings
 * take a double past its own precision, so the loop is bounded by arithmetic, not by a guess.
 */
function solve(target: number, decreasing: (p: number) => number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (decreasing(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function precisionInterval(tp: number, n: number, confidence: number): PrecisionInterval | null {
  if (!Number.isInteger(tp) || !Number.isInteger(n)) throw new RangeError("precisionInterval: tp and n must be integer counts.");
  if (n < 0) throw new RangeError("precisionInterval: n must not be negative.");
  if (tp < 0 || tp > n) throw new RangeError(`precisionInterval: tp must be between 0 and n, got tp=${tp}, n=${n}.`);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`precisionInterval: confidence must be between 0 and 1, got ${confidence}.`);
  if (n === 0) return null;

  const alpha = 1 - confidence;

  // Lower: the p at which seeing tp or more is exactly as unlikely as alpha/2, which is
  // P(X <= tp - 1 | p) = 1 - alpha/2. Solving that tail for alpha/2 instead returns the far
  // side of the distribution — 0.5561 rather than 0.0667 for 3 of 10, caught by the first test.
  const lower = tp === 0 ? 0 : solve(1 - alpha / 2, (p) => binomialCdf(tp - 1, n, p));
  // Upper: the smallest p for which seeing tp or fewer is that unlikely. P(X <= tp | p) falls
  // with p already.
  const upper = tp === n ? 1 : solve(alpha / 2, (p) => binomialCdf(tp, n, p));

  return { tp, n, point: tp / n, lower, upper, confidence };
}
