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

import type { Comparison, EvalSuite, DetectorRecallBlock } from "../../../contracts/index.js";
import { attainable, floorDiscordant, legacyAnchorSize, minAttainableP } from "./sizing.js";

export interface CaseOutcome {
  case_id: string;
  passed: boolean;
  /**
   * The independent unit this outcome belongs to. Absent means the case is its own cluster,
   * so an unperturbed suite behaves exactly as it did before clustering existed.
   */
  cluster_id?: string;
}

export interface CompareInput {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  candidate: readonly CaseOutcome[];
  baseline: readonly CaseOutcome[];
  suite: Pick<EvalSuite, "resolution" | "significance_protocol">;
  /** How many comparisons this one belongs to. 1 means a standalone comparison. */
  comparisons_in_family: number;
  /** Nominal significance level, before correction. */
  alpha: number;
  /**
   * Recall as measured on each run's own outcomes. Null or absent is a refusal, not a
   * default: until 2.0.0 this was a boolean the caller asserted and nothing computed,
   * which is how the comparator's strongest guard came to check nothing at all.
   */
  candidateRecall: DetectorRecallBlock | null | undefined;
  baselineRecall: DetectorRecallBlock | null | undefined;
  /** Detectors the suite actually uses. Recall of a detector nobody ran is not this comparison's problem. */
  suiteDetectorIds: readonly string[];
  correction?: "none" | "bonferroni";
}

// compare() (below) always derives a real equalization object — only compareGraded() (a
// judge-graded comparison has no detectors to equalize) ever returns null. NonNullable here
// keeps that true locally without exposing a narrower Comparison variant repo-wide.
type Equalization = NonNullable<Comparison["equalization"]>;

/**
 * Derive equalization from two measured recall blocks.
 *
 * `gap_bound` is the suite's own `detectable_delta` rather than a chosen constant, and that
 * choice carries a guarantee. With recall r and true failure rate f, an observed failure rate
 * is r*f, so a measured delta is `r_b*f_b - r_c*f_c`. Holding the true rates equal isolates
 * the artifact at `f*(r_b - r_c)`, whose magnitude is at most |delta_r| because f <= 1.
 * Bounding the gap by detectable_delta therefore bounds the artifact by it — while
 * `adjusted_resolution = detectable_delta / min(r)` is strictly larger whenever any gap
 * exists, since a nonzero gap forces some r < 1.
 *
 * So a pure recall artifact can never on its own clear the reporting threshold. The edge case
 * where that would go non-strict needs both recalls to equal 1, which makes the gap zero.
 */
function deriveEqualization(
  input: CompareInput,
): { equalization: Equalization; refusal: string | null } {
  const detectable = input.suite.resolution.detectable_delta;
  const bare = (reason: string): { equalization: Equalization; refusal: string } => ({
    equalization: {
      equalized: false, max_gap: null, gap_bound: detectable,
      effective_recall: null, adjusted_resolution: null, per_detector: [],
    },
    refusal: reason,
  });

  if (!input.candidateRecall || !input.baselineRecall) {
    const which = !input.candidateRecall && !input.baselineRecall ? "neither run"
      : !input.candidateRecall ? "the candidate run" : "the baseline run";
    return bare(`${which} carries measured detector recall; an unmeasured instrument is not evidence`);
  }
  if (input.candidateRecall.probe_corpus_version !== input.baselineRecall.probe_corpus_version) {
    return bare(
      `probe corpus differs — candidate ${input.candidateRecall.probe_corpus_version}, ` +
      `baseline ${input.baselineRecall.probe_corpus_version}; recall measured under different ` +
      `corpora is not comparable`,
    );
  }
  if (input.suiteDetectorIds.length === 0) {
    return bare("the suite names no detectors, so there is no instrument to equalize");
  }

  const cand = new Map(input.candidateRecall.detectors.map((d) => [d.detector_id, d.recall]));
  const base = new Map(input.baselineRecall.detectors.map((d) => [d.detector_id, d.recall]));

  const per_detector = [...new Set(input.suiteDetectorIds)].sort().map((detector_id) => {
    const c = cand.has(detector_id) ? cand.get(detector_id)! : null;
    const b = base.has(detector_id) ? base.get(detector_id)! : null;
    return {
      detector_id,
      candidate_recall: c,
      baseline_recall: b,
      gap: c === null || b === null ? null : Math.abs(c - b),
    };
  });

  const unmeasured = per_detector.filter((d) => d.gap === null).map((d) => d.detector_id);
  if (unmeasured.length > 0) {
    // Either the detector is absent from a run's block, or its recall is null because the
    // detector fired on every outcome and left no substrate. Both are broken instruments.
    return {
      equalization: {
        equalized: false, max_gap: null, gap_bound: detectable,
        effective_recall: null, adjusted_resolution: null, per_detector,
      },
      refusal: `recall is unmeasurable for ${unmeasured.join(", ")} — the detector left no ` +
               `substrate on one side, or was not measured there at all`,
    };
  }

  const max_gap = Math.max(...per_detector.map((d) => d.gap!));
  const effective_recall = Math.min(
    ...per_detector.flatMap((d) => [d.candidate_recall!, d.baseline_recall!]),
  );
  const equalized = max_gap <= detectable;

  const equalization: Equalization = {
    equalized,
    max_gap,
    gap_bound: detectable,
    effective_recall,
    // Recall 0 is measured-and-dead and fails the build upstream, but the comparator must
    // not divide by it if it ever arrives here.
    adjusted_resolution: effective_recall > 0 ? detectable / effective_recall : null,
    per_detector,
  };

  if (!equalized) {
    return {
      equalization,
      refusal: `detector recall differs by ${max_gap.toFixed(4)}, above the suite's bound of ` +
               `${detectable.toFixed(4)}; a gap this size can produce the whole difference on ` +
               `its own, so the comparison would measure the instrument`,
    };
  }
  return { equalization, refusal: null };
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
  // Underflows to exactly 0 past ~1075 discordant pairs. Zero would claim impossibility
  // under the null rather than "smaller than a double holds" — see `minAttainableP`.
  return p === 0 ? Number.MIN_VALUE : Math.min(1, p);
}

/**
 * McNemar on the discordant pairs. Exact binomial throughout: the chi-square form is
 * an approximation that misbehaves exactly where a smoke suite lives — small counts.
 */
export function mcnemar(b: number, c: number): { p: number; discordant: number } {
  return { p: exactTwoSided(b, c), discordant: b + c };
}

/** The independent unit an outcome belongs to. Absent means the case is its own cluster. */
export const clusterOf = (o: CaseOutcome): string => o.cluster_id ?? o.case_id;

/**
 * The paired test, applied at the level of the independent unit.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `mcnemar` above treats every case as independent. That is correct for an unperturbed
 * suite and wrong the moment perturbations ship, because the expansion is `cases ×
 * perturbations` — a within-case product, which is the definition of clustered data. Four
 * variants of one brief are four looks at one question, not four questions, and counting
 * them as four inflates the sample by the perturbation factor. Standard errors computed
 * that way run materially smaller than cluster-adjusted ones, so every p-value is
 * anticonservative and the error is invisible in the output.
 *
 * ── Why a cluster-level sign test rather than a robust variance estimator ────
 *
 * Analysing at the level of the cluster is the conservative, assumption-light form, and it
 * stays EXACT: each cluster contributes one signed difference, and the same exact binomial
 * that powers McNemar is applied to those signs. A sandwich estimator would need a large
 * number of clusters to be trustworthy, and a smoke suite has fourteen. This repository
 * already prefers exact methods over asymptotic ones for that reason.
 *
 * The cost is stated rather than elided: aggregating discards within-cluster information
 * and therefore has less power than a correctly-specified model would. Less power is the
 * right direction to err — it produces "inconclusive", not a confident wrong sign.
 */
export function clusteredPaired(
  candidate: readonly CaseOutcome[],
  baseline: readonly CaseOutcome[],
): { p: number; discordant: number; clusters: number } {
  const rate = (rows: readonly CaseOutcome[]) => {
    const byCluster = new Map<string, { passed: number; n: number }>();
    for (const o of rows) {
      const slot = byCluster.get(clusterOf(o)) ?? { passed: 0, n: 0 };
      slot.n += 1;
      if (o.passed) slot.passed += 1;
      byCluster.set(clusterOf(o), slot);
    }
    return byCluster;
  };

  const cand = rate(candidate);
  const base = rate(baseline);

  let better = 0;   // clusters where the candidate scored higher
  let worse = 0;    // clusters where the baseline did
  for (const [cluster, c] of cand) {
    const b = base.get(cluster);
    if (!b) continue;
    const cScore = c.passed / c.n;
    const bScore = b.passed / b.n;
    // Ties contribute nothing, exactly as concordant pairs do in McNemar.
    if (cScore > bScore) better += 1;
    else if (cScore < bScore) worse += 1;
  }

  return { p: exactTwoSided(better, worse), discordant: better + worse, clusters: cand.size };
}

export function compare(input: CompareInput): Comparison {
  const {
    comparison_id, candidate_run_id, baseline_id, candidate, baseline,
    suite, comparisons_in_family, alpha,
  } = input;
  const correction = input.correction ?? (comparisons_in_family > 1 ? "bonferroni" : "none");
  const correctedAlpha = correction === "bonferroni" ? alpha / comparisons_in_family : alpha;

  const { equalization, refusal } = deriveEqualization(input);

  const refuse = (reason: string): Comparison => ({
    comparison_id, candidate_run_id, baseline_id,
    verdict: "refused", refusal_reason: reason, delta: null,
    protocol: { test: "none", trials: 1, alpha: correctedAlpha, comparisons_in_family, correction, p_value: null },
    equalization,
  });

  // The instrument is checked before the measurement. Reporting a delta and then noting the
  // detectors were unequal gets the delta quoted and the note dropped.
  if (refusal) return refuse(refusal);
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

  /**
   * The declared protocol is checked against the data's actual structure.
   *
   * A suite whose cases are grouped by perturbation violates the independence `exact-mcnemar`
   * assumes, and the resulting p-value is anticonservative — smaller than it should be, in
   * the direction that manufactures significance. Reporting the number with a caveat is not
   * a mitigation: the number gets quoted and the caveat gets dropped. So this refuses, on
   * the same principle as the recall-mismatch refusal above, which it deliberately mirrors.
   */
  const clusters = new Set(paired.map(clusterOf)).size;
  const isClustered = clusters < paired.length;
  const declared = suite.significance_protocol;

  if (isClustered && declared === "exact-mcnemar") {
    return refuse(
      `suite declares exact-mcnemar but its ${paired.length} case(s) form only ${clusters} independent ` +
      `cluster(s) — perturbation variants are repeated looks at one question, not separate questions. ` +
      `An independence-assuming test on clustered data reports a p-value smaller than the evidence supports. ` +
      `Declare clustered-paired.`,
    );
  }
  if (declared === "bootstrap-ci") {
    return refuse(
      "bootstrap-ci is declared but not implemented — graded and free-form metrics need it and no " +
      "suite here produces them yet. Refusing rather than silently substituting a test for binary outcomes.",
    );
  }

  /**
   * Can this design produce a significant result AT ALL?
   *
   * Under McNemar the statistic is binomial(d, 0.5) over the d discordant units, so the
   * smallest two-sided p-value any arrangement can reach is `2 * 0.5^d`. With fewer
   * independent units than that floor requires, every possible outcome of this comparison is
   * non-significant before a single case is scored.
   *
   * This is checked against the INDEPENDENT UNIT count, not the row count, which is why it
   * sits after the clustering check: five briefs perturbed into twenty rows can still only
   * ever contribute five signs, and clustering is precisely the thing that shrinks the
   * number that matters here.
   *
   * Reported as a refusal rather than as `inconclusive` because the two mean opposite things
   * to anyone reading the result. `inconclusive` says the evidence did not separate the
   * configurations; this says no evidence could have. A promotion gate that cannot tell them
   * apart will read "we could not have seen anything" as "we looked and saw nothing".
   */
  const floor = floorDiscordant(correctedAlpha);
  if (clusters < floor) {
    return refuse(
      `this suite has ${clusters} independent unit(s); the exact two-sided test needs at least ` +
      `${floor} discordant unit(s) to reach alpha=${correctedAlpha.toFixed(4)}, so its smallest ` +
      `attainable p-value is ${minAttainableP(clusters).toFixed(4)}. No outcome this comparison ` +
      `could produce would be significant. Reporting "inconclusive" here would credit the suite ` +
      `with a look it never took.`,
    );
  }

  const candScore = paired.filter((o) => o.passed).length / paired.length;
  const baseScore = baseline.filter((o) => o.passed).length / baseline.length;
  const delta = candScore - baseScore;

  let p: number;
  let discordant: number;
  let test: "mcnemar" | "clustered-paired";

  if (declared === "clustered-paired") {
    const r = clusteredPaired(paired, baseline);
    p = r.p;
    discordant = r.discordant;
    test = "clustered-paired";
  } else {
    let b = 0; // candidate passed, baseline failed
    let c = 0; // candidate failed, baseline passed
    for (const o of paired) {
      const was = baseById.get(o.case_id)!;
      if (o.passed && !was) b++;
      else if (!o.passed && was) c++;
    }
    const r = mcnemar(b, c);
    p = r.p;
    discordant = r.discordant;
    test = "mcnemar";
  }

  const protocol = {
    test,
    trials: 1,
    alpha: correctedAlpha,
    comparisons_in_family,
    correction,
    p_value: p,
    /** The number of INDEPENDENT units the p-value rests on, which is not the case count. */
    effective_n: clusters,
    /** The exact sample size of the test: concordant units carry no information. */
    discordant,
    /** Smallest p any arrangement of these discordant units could reach. Not observed power. */
    min_attainable_p: minAttainableP(discordant),
    attainable: attainable(discordant, correctedAlpha),
  };

  // A suite cannot evidence a difference it was never sized to see, and a blunter instrument
  // sees less than the suite's declared resolution promises. `adjusted_resolution` is the
  // declared figure widened by measured recall; at recall 1 it is exactly the declared one,
  // so a perfect instrument sees no change in behaviour.
  const resolution = equalization.adjusted_resolution ?? suite.resolution.detectable_delta;
  if (Math.abs(delta) > 0 && Math.abs(delta) < resolution) {
    const widened = resolution > suite.resolution.detectable_delta
      ? ` (declared ${suite.resolution.detectable_delta}, widened by effective recall ` +
        `${equalization.effective_recall!.toFixed(3)})`
      : "";
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: `delta ${delta.toFixed(4)} is below this suite's resolution of ${resolution.toFixed(4)}${widened}`,
      delta, protocol, equalization,
    };
  }

  if (discordant === 0 || p >= correctedAlpha) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: discordant === 0
        ? "no discordant pairs — the two runs agree on every case"
        : !attainable(discordant, correctedAlpha)
          ? `only ${discordant} discordant unit(s), whose smallest attainable p is ` +
            `${minAttainableP(discordant).toFixed(4)} — above alpha=${correctedAlpha.toFixed(4)}. ` +
            `The two runs did differ; this test could not have called any such difference ` +
            `significant, so this is a statement about the suite and not about the configurations.`
          : `p=${p.toFixed(4)} does not clear alpha=${correctedAlpha.toFixed(4)}`,
      delta, protocol, equalization,
    };
  }

  return {
    comparison_id, candidate_run_id, baseline_id,
    verdict: delta > 0 ? "improved" : "regressed",
    refusal_reason: null,
    delta, protocol, equalization,
  };
}

/**
 * The anchor sizing rule, kept as a function and now honest about what it assumes.
 *
 * `n ≳ z² / (2Δ²)` is the conditional McNemar rule with power pinned at 50% and the
 * discordance rate pinned at 50%, neither of which it states. At Δ = 0.02 it returns ≈3,400,
 * which is the number three documents in this repository quote. The same target at 80% power
 * needs ≈9,800.
 *
 * The implementation now lives in `sizing.ts` alongside the general form, so the two rules
 * cannot drift apart and a caller can see which assumptions it is inheriting. Kept exported
 * because the ≈3,400 figure is cited and a citation should resolve to running code.
 *
 * @deprecated Prefer `requiredPairedSize`, which takes power and discordance as arguments.
 */
export function requiredAnchorSize(detectableDelta: number, confidence = 0.95): number {
  return legacyAnchorSize(detectableDelta, confidence);
}
