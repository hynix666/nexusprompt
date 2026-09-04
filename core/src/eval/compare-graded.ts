/**
 * The paired-bootstrap comparator, for continuous per-case scores rather than binary
 * pass/fail. `compare.ts`'s own comment has said since before this module existed: "graded
 * and free-form metrics need [bootstrap-ci] and no suite here produces them yet." This is
 * that comparator, built for exactly one shape of graded outcome so far: the brief-fidelity
 * judge's integer 0-12 rubric sum (application/src/judge-bundle.ts).
 *
 * Pure. Text and scores only — no provider, no clock, no filesystem. The bootstrap resampler
 * is seeded explicitly rather than reaching for `Math.random`, which `core/test/purity.setup.ts`
 * traps; determinism here means the same input always produces the same Comparison, not that
 * the resampling is somehow non-random.
 *
 * ── Why a separate function rather than a branch inside `compare()` ─────────────────
 *
 * `compare()` already treats "the declared protocol does not match the data's structure" as
 * a refusal-worthy problem — that is exactly what its clustered/mcnemar mismatch check does.
 * Boolean `passed` and continuous `score` are different enough shapes of data that retrofitting
 * one function to branch on both invites the same silent-wrong-runner failure this repository
 * already fixed once, for pipeline vs. single-stage eval suites: a suite scored by the wrong
 * comparator produces a real-looking Comparison record for the wrong reason.
 *
 * ── Why a stated floor, not a derived one ────────────────────────────────────────────
 *
 * `floorDiscordant` in sizing.ts gives McNemar an EXACT floor: under the null the test
 * statistic is binomial(d, 0.5), so `2 * 0.5^d` is provably the smallest attainable two-sided
 * p-value at d discordant units. A percentile bootstrap has no equivalent — its coverage is
 * asymptotic, not exact, and there is no arithmetic identity pinning a minimum n the way
 * `floorDiscordant` pins one. `MIN_BOOTSTRAP_N` below is a stated, literature-common
 * rule-of-thumb, recorded as an assumption with a name — the same posture `LEGACY_ASSUMPTIONS`
 * in sizing.ts already takes toward the binary rule's hidden 50%/50% defaults — not a proof.
 */

import type { Comparison, EvalSuite } from "../../../contracts/index.js";
import { rng } from "./generator.js";

export interface GradedCaseOutcome {
  case_id: string;
  score: number;
  /** The independent unit this outcome belongs to. Absent means the case is its own cluster. */
  cluster_id?: string;
}

export interface CompareGradedInput {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  candidate: readonly GradedCaseOutcome[];
  baseline: readonly GradedCaseOutcome[];
  suite: Pick<EvalSuite, "resolution" | "significance_protocol">;
  /** How many comparisons this one belongs to. 1 means a standalone comparison. */
  comparisons_in_family: number;
  /** Nominal significance level, before correction. */
  alpha: number;
  correction?: "none" | "bonferroni";
}

/** Bootstrap resamples per comparison. Fixed, not caller-chosen, so the function stays pure. */
export const BOOTSTRAP_RESAMPLES = 10_000;
/**
 * Seeds only the bootstrap resampler here — an unrelated constant from anchor.ts's and the
 * brief-pilot generator's own seed 1, which seed brief GENERATION, a different concern.
 */
export const BOOTSTRAP_SEED = 1;
/**
 * Stated, not derived — see the module header. A common rule-of-thumb floor for percentile
 * bootstrap CIs to be reasonably well-behaved, not a proven property of this design.
 */
export const MIN_BOOTSTRAP_N = 20;

/** Which comparator a suite wants, mirroring `isPipelineCase`'s role for the other suite split. */
export function isGradedSuite(suite: Pick<EvalSuite, "significance_protocol">): boolean {
  return suite.significance_protocol === "bootstrap-ci";
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolated percentile of an already-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Paired percentile bootstrap over n signed differences. Deterministic given `seed`. */
function bootstrapCI(
  diffs: readonly number[],
  alpha: number,
  resamples: number,
  seed: number,
): [number, number] {
  const rand = rng(seed);
  const n = diffs.length;
  const means: number[] = new Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  return [percentile(means, alpha / 2), percentile(means, 1 - alpha / 2)];
}

export function compareGraded(input: CompareGradedInput): Comparison {
  const {
    comparison_id, candidate_run_id, baseline_id, candidate, baseline,
    suite, comparisons_in_family, alpha,
  } = input;
  const correction = input.correction ?? (comparisons_in_family > 1 ? "bonferroni" : "none");
  const correctedAlpha = correction === "bonferroni" ? alpha / comparisons_in_family : alpha;

  const refuse = (reason: string): Comparison => ({
    comparison_id, candidate_run_id, baseline_id,
    verdict: "refused", refusal_reason: reason, delta: null,
    protocol: { test: "none", trials: 1, alpha: correctedAlpha, comparisons_in_family, correction },
    equalization: null,
  });

  if (!isGradedSuite(suite)) {
    return refuse(
      `suite declares significance_protocol "${suite.significance_protocol}", not "bootstrap-ci" ` +
      `— compareGraded only scores suites that declare a graded/continuous outcome.`,
    );
  }
  if (candidate.length === 0 || baseline.length === 0) {
    return refuse("one side has no cases");
  }

  const baseById = new Map(baseline.map((o) => [o.case_id, o.score]));
  const paired = candidate.filter((o) => baseById.has(o.case_id));
  if (paired.length !== candidate.length || paired.length !== baseline.length) {
    return refuse(
      `case sets differ — ${candidate.length} candidate, ${baseline.length} baseline, ` +
      `${paired.length} shared; a paired test needs the same cases on both sides`,
    );
  }
  if (paired.length < MIN_BOOTSTRAP_N) {
    return refuse(
      `this suite has ${paired.length} paired case(s); a percentile bootstrap is stated ` +
      `(not derived — see the module header) to need at least ${MIN_BOOTSTRAP_N} for its ` +
      `interval to be reasonable. Below that, reporting a CI would dress up noise as precision.`,
    );
  }

  const diffs = paired.map((o) => o.score - baseById.get(o.case_id)!);
  const delta = mean(diffs);

  const resolution = suite.resolution.detectable_delta;
  if (Math.abs(delta) > 0 && Math.abs(delta) < resolution) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: `delta ${delta.toFixed(4)} is below this suite's resolution of ${resolution.toFixed(4)}`,
      delta,
      protocol: {
        test: "paired-bootstrap", trials: 1, alpha: correctedAlpha, comparisons_in_family,
        correction, effective_n: paired.length,
      },
      equalization: null,
    };
  }

  if (delta === 0) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: "no difference — the two sides scored identically on every case",
      delta,
      protocol: {
        test: "paired-bootstrap", trials: 1, alpha: correctedAlpha, comparisons_in_family,
        correction, effective_n: paired.length, confidence_interval: [0, 0],
      },
      equalization: null,
    };
  }

  const [lo, hi] = bootstrapCI(diffs, correctedAlpha, BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED);
  const protocol = {
    test: "paired-bootstrap" as const,
    trials: 1,
    alpha: correctedAlpha,
    comparisons_in_family,
    correction,
    confidence_interval: [lo, hi] as [number, number],
    effective_n: paired.length,
  };

  if (lo <= 0 && hi >= 0) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: `${((1 - correctedAlpha) * 100).toFixed(1)}% bootstrap CI ` +
        `[${lo.toFixed(4)}, ${hi.toFixed(4)}] includes 0`,
      delta, protocol, equalization: null,
    };
  }

  return {
    comparison_id, candidate_run_id, baseline_id,
    verdict: delta > 0 ? "improved" : "regressed",
    refusal_reason: null,
    delta, protocol, equalization: null,
  };
}
