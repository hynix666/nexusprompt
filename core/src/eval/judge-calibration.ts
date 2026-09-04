/**
 * Pure logic for judge calibration: whether a mutation isolated cleanly, and the
 * chance-corrected agreement between the judge's classification and the mutation-derived
 * label. See ADR-0016 for why the reference is mutation-derived rather than human-labeled.
 *
 * Shared by scripts/build-judge-calibration.ts (the one-time real measurement) and
 * scripts/check-judge.ts (the CI gate that re-derives the same numbers from the committed
 * artifact without ever touching the network) — one implementation, so the two cannot drift.
 */

import { RUBRIC_DIMENSIONS, type RubricDimension } from "./brief-fidelity.js";

export type RubricBreakdown = Record<RubricDimension, { score: number; reason: string }>;

/**
 * A mutation isolates when its targeted dimension drops by at least 2 points from the clean
 * baseline, and every OTHER dimension stays within 1 point of its own baseline. A mutation
 * that fails this is dropped from the calibration measurement, not force-fit — the same rule
 * core/src/eval/anchor.ts uses when an injected fragment fires more than one gate.
 */
export function isolatesCleanly(
  clean: RubricBreakdown,
  mutated: RubricBreakdown,
  target: RubricDimension,
): boolean {
  const targetDrop = clean[target].score - mutated[target].score;
  if (targetDrop < 2) return false;
  for (const dim of RUBRIC_DIMENSIONS) {
    if (dim === target) continue;
    if (Math.abs(clean[dim].score - mutated[dim].score) > 1) return false;
  }
  return true;
}

/**
 * Cohen's kappa for two binary raters over paired observations: [rater A, rater B].
 *
 * Chance-corrected — plain percent agreement is not admissible here (see judge-verdict
 * schema's own description of why exact match overstates discrimination). Throws on an
 * empty input rather than returning 0 or NaN, both of which would silently read as "measured
 * and it's this bad" rather than "not measured at all".
 */
export function cohensKappa(pairs: Array<[boolean, boolean]>): number {
  if (pairs.length === 0) {
    throw new Error("cohensKappa: cannot compute agreement over zero paired observations.");
  }
  const n = pairs.length;
  let observedAgree = 0;
  let aTrue = 0;
  let bTrue = 0;
  for (const [a, b] of pairs) {
    if (a === b) observedAgree++;
    if (a) aTrue++;
    if (b) bTrue++;
  }
  const pObserved = observedAgree / n;
  const pAExpectedTrue = aTrue / n;
  const pBExpectedTrue = bTrue / n;
  const pChance =
    pAExpectedTrue * pBExpectedTrue + (1 - pAExpectedTrue) * (1 - pBExpectedTrue);
  if (pChance === 1) return 1; // both raters constant and identical: no room for chance to explain, treat as full agreement
  return (pObserved - pChance) / (1 - pChance);
}

/**
 * The judge-classification / mutation-label pairs for ONE mutation, both prompts, all four
 * dimensions — the exact unit cohensKappa is computed over. Exported and shared so
 * scripts/build-judge-calibration.ts (the real measurement) and scripts/check-judge.ts (the
 * CI re-derivation) construct pairs identically and cannot silently drift apart. A dimension's
 * binarization (score <= 1 = "degraded") happens here, not at either call site, for the same
 * reason.
 */
export function derivePairs(
  clean: RubricBreakdown,
  mutated: RubricBreakdown,
  targetDimension: RubricDimension,
): Array<[boolean, boolean]> {
  const pairs: Array<[boolean, boolean]> = [];
  for (const dim of RUBRIC_DIMENSIONS) {
    const expectedDegradedOnMutated = dim === targetDimension;
    pairs.push([mutated[dim].score <= 1, expectedDegradedOnMutated]);
    pairs.push([clean[dim].score <= 1, false]);
  }
  return pairs;
}
