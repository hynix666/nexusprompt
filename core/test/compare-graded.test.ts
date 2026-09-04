import { describe, it, expect } from "vitest";
import {
  compareGraded, isGradedSuite, MIN_BOOTSTRAP_N,
  type GradedCaseOutcome,
} from "../src/eval/compare-graded.js";

const gradedSuite = {
  resolution: { detectable_delta: 0.01, confidence: 0.95 },
  significance_protocol: "bootstrap-ci" as const,
};

function scores(n: number, fill: (i: number) => number): GradedCaseOutcome[] {
  return Array.from({ length: n }, (_, i) => ({ case_id: `c${i}`, score: fill(i) }));
}

describe("isGradedSuite", () => {
  it("is true only for bootstrap-ci", () => {
    expect(isGradedSuite({ significance_protocol: "bootstrap-ci" })).toBe(true);
    expect(isGradedSuite({ significance_protocol: "exact-mcnemar" })).toBe(false);
    expect(isGradedSuite({ significance_protocol: "clustered-paired" })).toBe(false);
  });
});

describe("compareGraded", () => {
  it("refuses a suite that does not declare bootstrap-ci", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(25, () => 8), baseline: scores(25, () => 8),
      suite: { ...gradedSuite, significance_protocol: "exact-mcnemar" as const },
      comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(/bootstrap-ci/);
    expect(cmp.equalization).toBeNull();
  });

  it("refuses mismatched case sets", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(25, () => 8),
      baseline: [{ case_id: "different", score: 8 }],
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(/case sets differ/);
  });

  it("refuses below the stated minimum-n floor", () => {
    const n = MIN_BOOTSTRAP_N - 1;
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(n, () => 10), baseline: scores(n, () => 6),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(new RegExp(String(MIN_BOOTSTRAP_N)));
  });

  it("reports improved when the candidate scores consistently higher", () => {
    // 30 cases, candidate always 4 points ahead — a bootstrap CI on this should exclude 0
    // in every direction with 10,000 resamples of a constant-signed difference.
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, () => 9), baseline: scores(30, () => 5),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("improved");
    expect(cmp.delta).toBeCloseTo(4, 10);
    expect(cmp.protocol.test).toBe("paired-bootstrap");
    expect(cmp.protocol.confidence_interval).not.toBeNull();
    const [lo, hi] = cmp.protocol.confidence_interval!;
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(0);
    expect(cmp.equalization).toBeNull();
  });

  it("reports regressed when the baseline scores consistently higher", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, () => 5), baseline: scores(30, () => 9),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("regressed");
    expect(cmp.delta).toBeCloseTo(-4, 10);
  });

  it("reports inconclusive when scores are identical on every case", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, () => 7), baseline: scores(30, () => 7),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("inconclusive");
    expect(cmp.delta).toBe(0);
  });

  it("reports inconclusive, not improved or regressed, when the CI straddles zero", () => {
    // Alternating +1/-1 differences: mean is 0 but not every case agrees, unlike the
    // identical-scores case above — this exercises the CI-straddles-zero branch specifically,
    // not the zero-delta short-circuit.
    const n = 30;
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(n, (i) => (i % 2 === 0 ? 7 : 6)),
      baseline: scores(n, (i) => (i % 2 === 0 ? 6 : 7)),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("inconclusive");
  });

  it("is deterministic across repeated calls with the same input", () => {
    const input = {
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, (i) => 5 + (i % 3)),
      baseline: scores(30, (i) => 4 + (i % 4)),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    };
    const first = compareGraded(input);
    const second = compareGraded(input);
    expect(second).toEqual(first);
  });

  it("refuses when either side has no cases", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: [], baseline: [],
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(/no cases/);
  });
});
