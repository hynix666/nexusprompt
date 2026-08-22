/**
 * Whether a judge may grade this case, and whether its verdict may be believed.
 *
 * Pure. Every rule here is a decision about a call that has not happened, so it belongs in
 * Core; the adapter performs the call and enforces what this returns.
 *
 * ── Why a judge needs a policy at all ────────────────────────────────────────
 *
 * The largest systematic study available — 21 judges, nine providers, ~541,000 judgments —
 * found reliability and validity come apart: test-retest above 0.95 coexisted with severe
 * position bias in two production-deployed judges. A judge that answers consistently is not
 * a judge that answers correctly, and consistency is the property that is easy to observe.
 * So a verdict is admissible only with its audit, and these are the checks that decide.
 *
 * ── The three refusals ───────────────────────────────────────────────────────
 *
 * ADR-0008 lists all three under **Enforcement** and nothing enforced any of them, because
 * no judge existed. They ship with the adapter rather than after it — the "guarantee written
 * but not wired" class is the one this repository keeps finding, and shipping the check
 * alongside the capability is the fix it settled on.
 */

/** Technique verification classes, from the catalog's own `verification_status`. */
export type VerificationStatus = "verifier-checkable" | "judge-checkable" | "unverifiable-by-text";

export interface JudgeIdentity {
  judge_id: string;
  /**
   * The model family, which `judge_id` alone cannot express.
   *
   * A free-form id cannot be compared against the configuration under test, so
   * "the judge is never the model under test" was unenforceable until this field existed.
   */
  judge_family: string;
  rubric_id: string;
  rubric_hash: string | null;
  /** When the judge model, rubric, or template last changed. */
  contract_changed_at: string;
}

export interface Calibration {
  metric: "cohens-kappa" | "krippendorff-alpha" | "scotts-pi";
  value: number;
  /** Declared per rubric, not globally. Practice puts the floor near 0.60 and raises it to 0.85+ where a wrong verdict carries real cost. */
  threshold: number;
  measured_at: string;
  reference: string;
  /**
   * How long this calibration stays evidence, in days.
   *
   * Staleness relative to the judge's contract was the only rule until now, and it misses the
   * commonest case entirely: a judge whose model id, rubric and template never changed, whose
   * calibration is nonetheless eight months old. Reported practice is that judges drift within
   * 60-90 days as the production distribution moves under them, and that re-calibration is a
   * monthly cadence rather than an event triggered by an edit.
   *
   * Required, and deliberately not defaulted. A default here would be a cadence nobody chose,
   * inherited silently by every rubric — the same failure as `Budget.on_exceed`, where both
   * behaviours are defensible and picking one for the caller is the bug.
   */
  max_age_days: number;
}

export interface JudgeAdmission {
  admit: boolean;
  /** Present whether or not admitted: "why it was graded" is as auditable as "why it was not". */
  reason: string;
  code:
    | "ok"
    | "self-preference"
    | "verifier-checkable"
    | "no-calibration"
    | "stale-calibration"
    | "expired-calibration"
    | "below-threshold"
    | "uncorrected-agreement";
}

/**
 * May this judge grade this case, and is its calibration still evidence?
 *
 * Order matters. Self-preference is checked first because it invalidates the verdict
 * regardless of calibration: a judge grading its own family is a cycle in the grading order,
 * and a cycle does not merely risk reward hacking — given a search that can find
 * higher-scoring evaluators, it constructs it.
 */
export function admitJudge(input: {
  judge: JudgeIdentity;
  /** The family of the model that PRODUCED the output being graded. */
  candidate_family: string;
  /** The technique class of the case. Verifier-checkable cases must never reach a judge. */
  verification_status: VerificationStatus;
  calibration?: Calibration | null;
  /**
   * The moment to judge staleness against, as an ISO date.
   *
   * Passed in rather than read: Core may not touch the clock (ADR-0001), and a purity harness
   * that traps `Date.now` would catch it if it tried. Cadence is therefore something the
   * Application supplies, which is also what makes "was this admissible last Tuesday?"
   * answerable from stored evidence.
   */
  now: string;
}): JudgeAdmission {
  const { judge, candidate_family, verification_status, calibration, now } = input;

  if (judge.judge_family === candidate_family) {
    return {
      admit: false,
      code: "self-preference",
      reason:
        `judge family "${judge.judge_family}" is the family under test — a judge scores its own ` +
        `family's output measurably higher, and self-grading is a cycle in the grading order`,
    };
  }

  if (verification_status === "verifier-checkable") {
    return {
      admit: false,
      code: "verifier-checkable",
      reason:
        "this case is verifier-checkable — a deterministic detector can settle it, and a judge " +
        "call is expensive, biased, and itself needs evaluating",
    };
  }

  if (!calibration) {
    return {
      admit: false,
      code: "no-calibration",
      reason: "no calibration recorded — an unmeasured instrument is not evidence",
    };
  }

  /**
   * A calibration measured before the judge's contract last changed describes a judge that
   * is no longer running. Current guidance is explicit that the contract is (pinned model id,
   * versioned rubric, hashed template) and that ANY change to any of the three requires
   * re-calibration against human labels.
   */
  if (calibration.measured_at < judge.contract_changed_at) {
    return {
      admit: false,
      code: "stale-calibration",
      reason:
        `calibration measured ${calibration.measured_at} predates the judge contract's last change ` +
        `(${judge.contract_changed_at}) — it describes a judge that is no longer running`,
    };
  }

  /**
   * A calibration older than its declared cadence describes a judge that may still be running
   * and may no longer behave the way it was measured. Unlike the contract check above, nothing
   * has to have CHANGED for this to fire — the point is that drift needs no edit to happen.
   */
  const ageDays = (Date.parse(now) - Date.parse(calibration.measured_at)) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays > calibration.max_age_days) {
    return {
      admit: false,
      code: "expired-calibration",
      reason:
        `calibration is ${Math.floor(ageDays)} days old against a declared cadence of ` +
        `${calibration.max_age_days} — the judge contract has not changed, but a judge drifts ` +
        `without being edited as the distribution under it moves`,
    };
  }

  if (calibration.value < calibration.threshold) {
    return {
      admit: false,
      code: "below-threshold",
      reason:
        `agreement ${calibration.value} is below the ${calibration.threshold} this rubric requires`,
    };
  }

  return {
    admit: true,
    code: "ok",
    reason:
      `calibrated ${calibration.metric} ${calibration.value}, measured ${calibration.measured_at} ` +
      `(${Math.max(0, Math.floor(ageDays))}d old, cadence ${calibration.max_age_days}d)`,
  };
}

/**
 * The five named biases, and which of them a verdict actually carries evidence about.
 *
 * The schema mandates `position_randomized` and a chance-corrected `agreement`, which covers
 * position and calibration. Verbosity, format and self-preference had no field at all, so a
 * verdict could satisfy every requirement and still be produced by a judge that rewards
 * length. Absent is reported as absent — never as zero, which would read as measured-and-fine.
 */
export const NAMED_BIASES = ["position", "verbosity", "self_preference", "format", "calibration_drift"] as const;
export type NamedBias = (typeof NAMED_BIASES)[number];

export interface BiasPanel {
  position_randomized: boolean;
  verbosity_delta?: number | null;
  format_delta?: number | null;
  self_preference_delta?: number | null;
  measured_at?: string | null;
}

/** Which of the five a panel has actually measured. The rest are unknown, not clean. */
export function measuredBiases(panel: BiasPanel): NamedBias[] {
  const out: NamedBias[] = [];
  if (panel.position_randomized) out.push("position");
  if (panel.verbosity_delta != null) out.push("verbosity");
  if (panel.format_delta != null) out.push("format");
  if (panel.self_preference_delta != null) out.push("self_preference");
  if (panel.measured_at != null) out.push("calibration_drift");
  return out;
}

/** The biases nobody has measured for this judge. Reported so the gap is visible. */
export const unmeasuredBiases = (panel: BiasPanel): NamedBias[] => {
  const measured = new Set(measuredBiases(panel));
  return NAMED_BIASES.filter((b) => !measured.has(b));
};
