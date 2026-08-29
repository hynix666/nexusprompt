/**
 * Pipeline C — the release gate.
 *
 * Pure. This decides whether a promotion may happen; the Application performs it, writes the
 * record, and repoints the label. `decide → invoke → reduce`, with the decision here.
 *
 * ── What a promotion is ──────────────────────────────────────────────────────
 *
 * A label repoint, not a rebuild. Nothing is recompiled and no artifact changes; a pointer
 * moves. That is what makes rollback the same operation travelling the other way, and it is
 * why `Promotion` carries `kind` rather than there being a separate rollback contract.
 *
 * ── Why a conjunction, and why it stores its own reasons ─────────────────────
 *
 * Five conditions, all of which must hold, so that no single check ever carries a promotion
 * by itself. The recorded failure this guards against is `CAPABILITY_MATRIX.md`: a document
 * asserting capabilities that no `EvalRun` ever measured, maintained by hand, believed
 * because it was checked in.
 *
 * Each condition records its verdict AND its reason, in both directions. A conjunction whose
 * satisfied terms are not written down degrades into a rubber stamp the first time one of
 * them silently stops being checked — which is precisely the class of defect this repository
 * has now found seven times under the heading "a guard's scope is quietly narrower than its
 * name". A promotion that says *why* it was allowed can be audited later by someone who does
 * not trust the code.
 *
 * ── Preconditions are checked before the conditions ──────────────────────────
 *
 * Lineage and pointer integrity come first, mirroring the comparator's rule that the
 * instrument is checked before the measurement. A promotion certified against a development
 * baseline is not a weaker promotion, it is a cycle in the grading order: an optimizer that
 * can write the baseline can promote its own candidate. `Baseline.lineage` exists for this
 * and nothing read it until now.
 */

import type { Baseline, Comparison, EvalRun, Promotion, PromotionCondition } from "../../../contracts/index.js";
import type { JudgeAdmission } from "../eval/judge-policy.js";
import { admitCostJustification, type CostJustification } from "../routing/policy.js";

export type RefusalCode =
  | "development-lineage"
  | "pointer-mismatch"
  | "dangling-ref"
  | "not-significant"
  | "unattainable-comparison"
  | "cost-justification"
  | "mode-regression"
  | "over-budget"
  | "judge-calibration"
  | "detectors-unequalized";

export interface PromotionRefusal {
  code: RefusalCode;
  detail: string;
}

export interface PromotionRequest {
  promotion_id: string;
  promoted_at: string;
  promoted_by: string;
  /** The run being promoted. Its `run_id` must be the one the comparison measured. */
  candidateRun: EvalRun;
  /** The baseline's run, needed for per-mode regression. */
  baselineRun: EvalRun;
  baseline: Baseline;
  comparison: Comparison;
  /**
   * Content refs to verify before the promotion may proceed (artifact-reference lineage
   * design §6). The Application collects every `input_ref`/`output_ref` on the candidate
   * and baseline runs' revisions and hands them here; Core only composes the decision.
   * An `EvalRun` does not carry its revisions, so the Application is the right place to
   * gather them — the caller who read the runs from the revision store already has them.
   */
  contentRefs?: string[] | null;
  /**
   * Existence oracle over the content plane. The Application resolves refs to
   * `true`/`false`; Core only composes the decision. Absent oracle means no ref checking
   * — the promotion proceeds on pointer identity alone, which is the pre-lineage
   * behaviour. A present-but-failing oracle must throw rather than return false, so a
   * broken content store cannot masquerade as "all content gone".
   */
  refExists?: ((ref: string) => boolean) | null;
  /**
   * The judge's admission, when a judge graded this run.
   *
   * Whether one did is read from `candidateRun.grader_health`, not from this field being
   * supplied — a caller who could skip the condition by omitting an argument would be a
   * gate with an opt-out.
   */
  judge?: JudgeAdmission | null;
  /** Score granularity of the suite, used as the per-mode regression threshold. */
  suiteGranularity: number;
  /** The promotion this replaces, written forward because evidence is immutable. */
  supersedes?: string | null;
  kind?: "promote" | "rollback";
  /**
   * What the promotion claims. Absent means quality, which is the only claim this system can
   * currently certify; "cost" is accepted as an input and refused with the reason, rather
   * than being unrepresentable. A claim you cannot state is a claim that gets made anyway,
   * in prose, beside the record.
   */
  justification?: CostJustification;
}

export interface PromotionDecision {
  promoted: boolean;
  /** Every condition, recorded whether or not the promotion happened. */
  conditions: Promotion["conditions"];
  /** Empty when promoted. Ordered as evaluated, so the first is the one to fix first. */
  refusals: PromotionRefusal[];
  /** Null when refused: there is no half-promotion. */
  promotion: Promotion | null;
}

const held = (detail: string): PromotionCondition => ({ held: true, detail });
const failed = (detail: string): PromotionCondition => ({ held: false, detail });

/**
 * Did any failure mode regress by more than the suite's own declared granularity?
 *
 * An aggregate improvement can hide a category collapse: overall up ten points while
 * fabrication cases fall from every-one-passing to half. The aggregate is what condition 1
 * tests, so without this the gate would certify exactly that trade.
 *
 * The threshold is the suite's `detectable_delta` — its score granularity, one case out of n
 * — rather than zero. At zero, a single case flipping under stochastic decoding blocks every
 * promotion, and a gate that never passes is a gate that gets bypassed. Using a quantity the
 * suite already declares and `check:sizing` already pins keeps the threshold from becoming a
 * number someone picked.
 */
function modeRegressions(
  candidate: EvalRun,
  baseline: EvalRun,
  granularity: number,
): Array<{ mode: string; delta: number }> {
  const cand = candidate.aggregate.by_failure_mode ?? {};
  const base = baseline.aggregate.by_failure_mode ?? {};
  const out: Array<{ mode: string; delta: number }> = [];
  for (const mode of Object.keys(base)) {
    const b = base[mode];
    const c = cand[mode];
    if (!b || b.cases === 0) continue;
    const baseRate = b.passed / b.cases;
    // A mode present in the baseline and absent from the candidate scored nothing, which is
    // not the same as scoring zero — but it cannot be evidence of no regression either.
    const candRate = c && c.cases > 0 ? c.passed / c.cases : 0;
    const delta = candRate - baseRate;
    if (delta < -granularity) out.push({ mode, delta });
  }
  return out.sort((x, y) => x.delta - y.delta);
}

export function decidePromotion(req: PromotionRequest): PromotionDecision {
  const { candidateRun, baselineRun, baseline, comparison } = req;
  const refusals: PromotionRefusal[] = [];
  const refuse = (code: RefusalCode, detail: string) => { refusals.push({ code, detail }); };

  /* ── Preconditions: is this promotion even about these artifacts? ────────── */

  if (baseline.lineage !== "benchmark") {
    refuse(
      "development-lineage",
      `baseline ${baseline.baseline_id} is on the "${baseline.lineage}" lineage. Only a ` +
      `benchmark baseline may certify a promotion — a development baseline is writable by ` +
      `the same process that produces candidates, which makes promotion a cycle rather than ` +
      `a check.`,
    );
  }

  const pointerProblems: string[] = [];
  if (comparison.candidate_run_id !== candidateRun.run_id) {
    pointerProblems.push(
      `comparison measured run ${comparison.candidate_run_id}, but ${candidateRun.run_id} is ` +
      `being promoted`,
    );
  }
  if (comparison.baseline_id !== baseline.baseline_id) {
    pointerProblems.push(
      `comparison names baseline ${comparison.baseline_id}, but ${baseline.baseline_id} was supplied`,
    );
  }
  if (baseline.run_id !== baselineRun.run_id) {
    pointerProblems.push(
      `baseline points at run ${baseline.run_id}, but ${baselineRun.run_id} was supplied as its run`,
    );
  }
  if (pointerProblems.length > 0) {
    refuse(
      "pointer-mismatch",
      `the evidence does not refer to itself consistently: ${pointerProblems.join("; ")}. ` +
      `Every field of a promotion is a pointer, so a promotion whose pointers disagree ` +
      `certifies something other than what it names.`,
    );
  }

  /* ── Precondition — do the referenced artifacts still exist? ─────────────── */

  /**
   * Pointer consistency above says the three ids agree; this says the artifacts the
   * pointers name are still REACHABLE. A run whose retained content was evicted can be
   * named by a perfectly consistent set of pointers, and promoting across that hole
   * would certify evidence nobody can inspect. Checked as a precondition, before the
   * conditions: "instrument before measurement" — a gate refuses to evaluate a claim
   * about artifacts it cannot see.
   *
   * The oracle is injected because existence is an effect. Absent oracle means the
   * deployment keeps no content plane, and pointer identity is all that can be checked —
   * the pre-lineage behaviour. A present-but-failing oracle must throw rather than
   * return false, so a broken content store cannot masquerade as "all content gone".
   */
  if (req.refExists != null) {
    const dangling: string[] = [];
    for (const ref of req.contentRefs ?? []) {
      if (!req.refExists(ref)) dangling.push(ref);
    }
    if (dangling.length > 0) {
      refuse(
        "dangling-ref",
        `${dangling.length} content reference(s) no longer resolve, first: ${dangling[0]}. ` +
        `The evidence names content that no longer exists, so what it certifies cannot be ` +
        `inspected. Re-run the evaluation rather than promoting across the hole.`,
      );
    }
  }

  /* ── Condition 1 — significance ──────────────────────────────────────────── */

  let significance: PromotionCondition;
  const attainable = comparison.protocol.attainable;
  if (attainable === undefined || attainable === null) {
    significance = failed(
      `comparison ${comparison.comparison_id} carries no attainability record, so whether its ` +
      `test could have rejected at all is unknown. An unmeasured instrument is not evidence.`,
    );
    refuse("unattainable-comparison", significance.detail);
  } else if (!attainable) {
    significance = failed(
      `comparison ${comparison.comparison_id} had ${comparison.protocol.discordant ?? "?"} ` +
      `discordant unit(s); its smallest attainable p-value is ` +
      `${comparison.protocol.min_attainable_p ?? "?"}, above alpha ${comparison.protocol.alpha}. ` +
      `No outcome it could have produced would be significant.`,
    );
    refuse("unattainable-comparison", significance.detail);
  } else if (req.justification === "cost") {
    /**
     * A cost-justified promotion is refused before the quality verdict is even consulted for
     * superiority, because the argument being made is a different one. See
     * `admitCostJustification`: an inconclusive quality comparison says the suite could not
     * separate the two configurations, not that they are equivalent, and reading a
     * superiority test backwards is how a router is adopted on a cost number while the
     * regression it bought stays invisible.
     */
    const cost = admitCostJustification({
      justification: "cost",
      qualityVerdict: comparison.verdict,
    });
    significance = failed(cost.reason);
    refuse("cost-justification", cost.reason);
  } else if (comparison.verdict !== "improved") {
    significance = failed(
      `comparison ${comparison.comparison_id} returned "${comparison.verdict}"` +
      `${comparison.refusal_reason ? ` — ${comparison.refusal_reason}` : ""}. Only "improved" ` +
      `certifies a promotion; "inconclusive" is a measurement, not a weaker yes.`,
    );
    refuse("not-significant", significance.detail);
  } else {
    significance = held(
      `improved, p=${comparison.protocol.p_value?.toFixed(5) ?? "?"} against alpha ` +
      `${comparison.protocol.alpha} over ${comparison.protocol.effective_n ?? "?"} independent ` +
      `unit(s), ${comparison.protocol.discordant ?? "?"} discordant`,
    );
  }

  /* ── Condition 2 — no per-mode regression ────────────────────────────────── */

  const regressions = modeRegressions(candidateRun, baselineRun, req.suiteGranularity);
  let no_regression: PromotionCondition;
  if (regressions.length > 0) {
    no_regression = failed(
      `${regressions.length} failure mode(s) regressed by more than the suite's granularity ` +
      `(${req.suiteGranularity}): ` +
      regressions.map((r) => `${r.mode} ${(100 * r.delta).toFixed(1)}pp`).join(", ") +
      `. An aggregate gain that hides a category collapse is the trade this condition exists ` +
      `to refuse.`,
    );
    refuse("mode-regression", no_regression.detail);
  } else {
    const modes = Object.keys(baselineRun.aggregate.by_failure_mode ?? {}).length;
    no_regression = held(
      modes === 0
        ? "no per-mode breakdown on the baseline run, so no mode could regress — and none is claimed"
        : `${modes} failure mode(s) checked, none down by more than ${req.suiteGranularity}`,
    );
  }

  /* ── Condition 3 — within budget ─────────────────────────────────────────── */

  let within_budget: PromotionCondition;
  if (candidateRun.cost.budget_exceeded) {
    within_budget = failed(
      `run ${candidateRun.run_id} exceeded its declared budget (${candidateRun.cost.provider_calls} ` +
      `provider call(s)${candidateRun.cost.usd == null ? "" : `, $${candidateRun.cost.usd}`}). ` +
      `Cost-driven degradation changes correctness without changing any other signal, so an ` +
      `over-budget run is not evidence about the configuration that was meant to be measured.`,
    );
    refuse("over-budget", within_budget.detail);
  } else {
    within_budget = held(
      `${candidateRun.cost.provider_calls} provider call(s)` +
      `${candidateRun.cost.usd == null ? ", cost unmeasured" : `, $${candidateRun.cost.usd}`}, ` +
      `budget not exceeded`,
    );
  }

  /* ── Condition 4 — judge calibration ─────────────────────────────────────── */

  /**
   * Whether a judge was involved is read from the RUN, not from whether the caller passed a
   * judge. Deriving it from an argument would let a promotion skip this condition by
   * omitting one, which is an opt-out wearing the shape of a check.
   */
  const judged = candidateRun.grader_health != null && candidateRun.grader_health.judged_cases > 0;
  let judge_calibration: PromotionCondition;
  if (!judged) {
    judge_calibration = held(
      "no judge graded this run — every case was settled by a deterministic detector, so there " +
      "is no grader whose calibration could be stale",
    );
  } else if (!req.judge) {
    judge_calibration = failed(
      `run ${candidateRun.run_id} reports ${candidateRun.grader_health!.judged_cases} judged ` +
      `case(s) but no judge admission was supplied. A judged run whose grader cannot be audited ` +
      `is not promotable.`,
    );
    refuse("judge-calibration", judge_calibration.detail);
  } else if (!req.judge.admit) {
    judge_calibration = failed(`judge refused (${req.judge.code}): ${req.judge.reason}`);
    refuse("judge-calibration", judge_calibration.detail);
  } else {
    judge_calibration = held(
      `${candidateRun.grader_health!.judged_cases} judged case(s), ${req.judge.reason}, ` +
      `max disagreement ${candidateRun.grader_health!.max_disagreement_rate}`,
    );
  }

  /* ── Condition 5 — detector equalization ─────────────────────────────────── */

  let detector_equalization: PromotionCondition;
  if (!comparison.equalization.equalized) {
    detector_equalization = failed(
      `detector recall differs by ${comparison.equalization.max_gap ?? "an unmeasured amount"} ` +
      `against a bound of ${comparison.equalization.gap_bound}. A gap this size can produce the ` +
      `whole measured difference on its own.`,
    );
    refuse("detectors-unequalized", detector_equalization.detail);
  } else {
    detector_equalization = held(
      `max recall gap ${comparison.equalization.max_gap?.toFixed(4) ?? "0"} within bound ` +
      `${comparison.equalization.gap_bound}, effective recall ` +
      `${comparison.equalization.effective_recall?.toFixed(3) ?? "?"}`,
    );
  }

  const conditions = {
    significance, no_regression, within_budget, judge_calibration, detector_equalization,
  };

  if (refusals.length > 0) {
    return { promoted: false, conditions, refusals, promotion: null };
  }

  return {
    promoted: true,
    conditions,
    refusals: [],
    promotion: {
      promotion_id: req.promotion_id,
      kind: req.kind ?? "promote",
      configuration_id: candidateRun.configuration_id,
      eval_run_id: candidateRun.run_id,
      baseline_id: baseline.baseline_id,
      comparison_id: comparison.comparison_id,
      supersedes: req.supersedes ?? null,
      promoted_at: req.promoted_at,
      promoted_by: req.promoted_by,
      conditions,
    },
  };
}

/**
 * The record that reverses a promotion.
 *
 * Rollback carries the evidence pointers of the promotion it reverses rather than fresh ones,
 * because there is no new measurement: the claim being withdrawn is the one that was made,
 * and a rollback that pointed somewhere else would erase what was believed at the time.
 *
 * No conditions are re-evaluated. Restoring a previously-shipped configuration is always
 * allowed — requiring evidence to go back would mean a bad promotion could not be undone
 * without first producing the evidence that would have prevented it.
 */
export function rollbackOf(
  promotion: Promotion,
  at: { promotion_id: string; promoted_at: string; promoted_by: string },
): Promotion {
  return {
    ...promotion,
    promotion_id: at.promotion_id,
    kind: "rollback",
    supersedes: promotion.promotion_id,
    promoted_at: at.promoted_at,
    promoted_by: at.promoted_by,
  };
}
