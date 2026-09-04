/**
 * Pure logic for judge calibration: whether a mutation isolated cleanly, and the
 * chance-corrected agreement between the judge's classification and the mutation-derived
 * label. See ADR-0016 for why the reference is mutation-derived rather than human-labeled.
 *
 * Shared by scripts/build-judge-calibration.ts (the one-time real measurement) and
 * scripts/check-judge.ts (the CI gate that re-derives the same numbers from the committed
 * artifact without ever touching the network) — one implementation, so the two cannot drift.
 * `aggregatePairs` is that shared implementation: the two scripts call it rather than each
 * writing their own loop, which is what the pair of hand-written loops it replaced could not
 * guarantee.
 *
 * `validateCalibrationArtifact` lives here too, beside the shape it validates. It is pure and
 * takes an already-parsed value, so Core never learns where the artifact came from.
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
 * A dimension's binarization: the judge said "degraded" when it scored 0 or 1.
 *
 * One definition, used by both halves of a pair's construction below, so the mutated row and
 * the clean row cannot come to disagree about what the judge's score MEANS.
 */
const judgedDegraded = (b: RubricBreakdown, dim: RubricDimension): boolean => b[dim].score <= 1;

/**
 * The four observations a CLEAN prompt contributes: every dimension, labelled "not degraded".
 *
 * Emitted once per FIXTURE by `aggregatePairs` — see the note there for why once and not once
 * per surviving mutation.
 */
export function cleanPairs(clean: RubricBreakdown): Array<[boolean, boolean]> {
  return RUBRIC_DIMENSIONS.map((dim) => [judgedDegraded(clean, dim), false] as [boolean, boolean]);
}

/**
 * The four observations ONE mutated prompt contributes: its target dimension is labelled
 * "degraded", the other three "not degraded".
 */
export function mutatedPairs(
  mutated: RubricBreakdown,
  targetDimension: RubricDimension,
): Array<[boolean, boolean]> {
  return RUBRIC_DIMENSIONS.map(
    (dim) => [judgedDegraded(mutated, dim), dim === targetDimension] as [boolean, boolean],
  );
}

/** One fixture's judged scores, as the calibration artifact records them. */
export interface RawScoreEntry {
  fixture: string;
  clean: RubricBreakdown;
  mutations: Record<string, RubricBreakdown>;
}

export interface AggregatedPairs {
  /** `${fixture}/${dimension}` for every mutation that isolated cleanly, in fixture order. */
  kept: string[];
  /** Every labelled dimension-instance the kappa is computed over. */
  pairs: Array<[boolean, boolean]>;
}

/**
 * Every labelled dimension-instance in a calibration measurement, from the raw judged scores.
 *
 * **One function, two call sites, on purpose.** `scripts/build-judge-calibration.ts` (the
 * one-time paid measurement) and `scripts/check-judge.ts` (the CI re-derivation that must
 * reproduce its number without a network) both call this. They previously each wrote their own
 * loop around a per-mutation helper, and two independently-written loops over the same data is
 * exactly the gap a silent disagreement lives in.
 *
 * **Why the clean prompt is counted ONCE PER FIXTURE.** The per-mutation shape emitted a
 * fixture's four clean observations again for every surviving mutation, so a fixture whose four
 * mutations all isolated had its single clean judgement counted four times while a fixture
 * where nothing isolated contributed no clean rows at all. That is not merely inflation — it
 * makes the weighting of the kappa DATA-DEPENDENT on isolation success, which is the very
 * phenomenon being measured. Each judged prompt is one observation of the judge, and it is
 * counted once.
 *
 * The clean row is emitted for EVERY fixture, isolating or not: a fixture's clean grading
 * happened and is evidence about the judge regardless of what its mutations did. Making it
 * conditional would reintroduce the same correlation from the other side.
 *
 * Ceiling, stated as a formula rather than a number so it stays true: `F x D` clean instances
 * plus `K x D` mutated ones, for F fixtures, D dimensions and K surviving mutations. At the
 * committed suite's F=12, D=4 and a best case of K=48 that is 48 + 192 = 240.
 */
export function aggregatePairs(rawScores: readonly RawScoreEntry[]): AggregatedPairs {
  const kept: string[] = [];
  const pairs: Array<[boolean, boolean]> = [];
  for (const entry of rawScores) {
    pairs.push(...cleanPairs(entry.clean));
    for (const dim of RUBRIC_DIMENSIONS) {
      const mutated = entry.mutations[dim];
      if (!mutated) continue;
      if (!isolatesCleanly(entry.clean, mutated, dim)) continue;
      kept.push(`${entry.fixture}/${dim}`);
      pairs.push(...mutatedPairs(mutated, dim));
    }
  }
  return { kept, pairs };
}

/**
 * Is this parsed JSON actually a calibration artifact? Returns the problems, empty when valid.
 *
 * **This exists because the absence of it failed OPEN.** `scripts/judge.ts` read
 * `eval/judge-calibration.json` into an untyped value and caught only a JSON parse error, so a
 * valid-JSON, wrong-shape artifact produced `undefined` fields that walked through all three of
 * `admitJudge`'s calibration guards untouched: `"undefinedT00:00:00.000Z" < contract_changed_at`
 * is false, `NaN > undefined` is false, and `undefined < undefined` is false. A corrupt
 * calibration was therefore accepted as a measured one — the exact inversion of "an unmeasured
 * instrument is not evidence", and the failure mode a calibration gate exists to make
 * impossible.
 *
 * Every problem is collected rather than the first thrown, so an operator fixing a hand-edited
 * artifact sees the whole list instead of one round trip per field.
 */
export function validateCalibrationArtifact(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["the artifact is not a JSON object"];
  }
  const a = value as Record<string, unknown>;

  const finite = (key: string): void => {
    if (typeof a[key] !== "number" || !Number.isFinite(a[key] as number)) {
      problems.push(`"${key}" must be a finite number (got ${JSON.stringify(a[key])})`);
    }
  };
  finite("cohens_kappa");
  finite("threshold");
  finite("max_age_days");
  // Required so check:judge can re-derive it: it is the count the per-mutation aggregation
  // inflated, and a number nobody recomputes is a number that drifts.
  finite("labelled_dimension_instances");

  if (typeof a.reference !== "string" || a.reference.length === 0) {
    problems.push(`"reference" must be a non-empty string (got ${JSON.stringify(a.reference)})`);
  }
  // A calendar date, not any parseable string: scripts/judge.ts turns this into an ISO instant
  // by appending "T00:00:00.000Z", and that concatenation is only meaningful for this shape.
  if (typeof a.measured_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.measured_on)) {
    problems.push(`"measured_on" must be a YYYY-MM-DD date (got ${JSON.stringify(a.measured_on)})`);
  } else if (Number.isNaN(Date.parse(`${a.measured_on}T00:00:00.000Z`))) {
    problems.push(`"measured_on" is not a real date (got ${JSON.stringify(a.measured_on)})`);
  }

  if (!Array.isArray(a.kept_mutations) || a.kept_mutations.some((k) => typeof k !== "string")) {
    problems.push(`"kept_mutations" must be an array of strings`);
  }

  if (!Array.isArray(a.raw_scores)) {
    problems.push(`"raw_scores" must be an array`);
  } else {
    a.raw_scores.forEach((entry, i) => {
      problems.push(...breakdownProblems(entry, `raw_scores[${i}]`));
    });
  }
  return problems;
}

/** One `raw_scores` entry's shape, including every RubricBreakdown it carries. */
function breakdownProblems(entry: unknown, at: string): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${at} is not an object`];
  }
  const e = entry as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof e.fixture !== "string" || e.fixture.length === 0) {
    problems.push(`${at}.fixture must be a non-empty string`);
  }
  problems.push(...oneBreakdown(e.clean, `${at}.clean`));
  if (typeof e.mutations !== "object" || e.mutations === null || Array.isArray(e.mutations)) {
    problems.push(`${at}.mutations must be an object keyed by dimension`);
  } else {
    for (const [dim, breakdown] of Object.entries(e.mutations as Record<string, unknown>)) {
      if (!(RUBRIC_DIMENSIONS as readonly string[]).includes(dim)) {
        problems.push(`${at}.mutations has an unknown dimension "${dim}"`);
        continue;
      }
      problems.push(...oneBreakdown(breakdown, `${at}.mutations.${dim}`));
    }
  }
  return problems;
}

/**
 * A RubricBreakdown: all four dimensions, each an integer score in 0-3 with a string reason.
 *
 * The RANGE matters and not only the type. `isolatesCleanly` compares differences against 2
 * and 1, and `judgedDegraded` thresholds at 1 — a score of 47 or -3 would satisfy every one of
 * those comparisons while meaning nothing, and would reach `cohensKappa` as a confident
 * classification. Mirrors the same range check the hosted judge adapter applies to a live
 * response, so an artifact cannot hold a score the transport would have refused.
 */
function oneBreakdown(value: unknown, at: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${at} is not a rubric breakdown object`];
  }
  const b = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const dim of RUBRIC_DIMENSIONS) {
    const cell = b[dim] as Record<string, unknown> | undefined;
    if (typeof cell !== "object" || cell === null) {
      problems.push(`${at}.${dim} is missing`);
      continue;
    }
    if (typeof cell.score !== "number" || !Number.isInteger(cell.score) || cell.score < 0 || cell.score > 3) {
      problems.push(`${at}.${dim}.score must be an integer 0-3 (got ${JSON.stringify(cell.score)})`);
    }
    if (typeof cell.reason !== "string") {
      problems.push(`${at}.${dim}.reason must be a string`);
    }
  }
  return problems;
}
