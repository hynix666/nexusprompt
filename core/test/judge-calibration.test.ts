import { describe, it, expect } from "vitest";
import {
  isolatesCleanly, cohensKappa, cleanPairs, mutatedPairs, aggregatePairs,
  validateCalibrationArtifact, type RawScoreEntry,
} from "../src/eval/judge-calibration.js";

const breakdown = (scores: Record<string, number>) =>
  Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v, reason: "x" }])) as any;

describe("isolatesCleanly", () => {
  const clean = breakdown({ domain_captured: 3, constraints_honored: 3, completeness: 3, no_overreach: 3 });

  it("accepts a mutation that drops only its target dimension by at least 2", () => {
    const mutated = breakdown({ domain_captured: 3, constraints_honored: 1, completeness: 3, no_overreach: 3 });
    expect(isolatesCleanly(clean, mutated, "constraints_honored")).toBe(true);
  });

  it("rejects a mutation whose target drops by less than 2", () => {
    const mutated = breakdown({ domain_captured: 3, constraints_honored: 2, completeness: 3, no_overreach: 3 });
    expect(isolatesCleanly(clean, mutated, "constraints_honored")).toBe(false);
  });

  it("rejects a mutation that also depresses a non-target dimension by more than 1", () => {
    const mutated = breakdown({ domain_captured: 3, constraints_honored: 1, completeness: 1, no_overreach: 3 });
    expect(isolatesCleanly(clean, mutated, "constraints_honored")).toBe(false);
  });

  it("accepts a non-target dimension drifting by exactly 1", () => {
    const mutated = breakdown({ domain_captured: 2, constraints_honored: 1, completeness: 3, no_overreach: 3 });
    expect(isolatesCleanly(clean, mutated, "constraints_honored")).toBe(true);
  });
});

describe("cohensKappa", () => {
  it("returns 1 for perfect agreement", () => {
    const pairs: Array<[boolean, boolean]> = [[true, true], [false, false], [true, true], [false, false]];
    expect(cohensKappa(pairs)).toBeCloseTo(1);
  });

  it("returns 0 for agreement no better than chance", () => {
    // Constructed so observed agreement exactly equals expected-by-chance agreement.
    const pairs: Array<[boolean, boolean]> = [
      [true, true], [true, false], [false, true], [false, false],
    ];
    expect(cohensKappa(pairs)).toBeCloseTo(0, 1);
  });

  it("returns a negative value for systematic disagreement", () => {
    const pairs: Array<[boolean, boolean]> = [[true, false], [false, true], [true, false], [false, true]];
    expect(cohensKappa(pairs)).toBeLessThan(0);
  });

  it("throws on an empty input rather than returning a misleading number", () => {
    expect(() => cohensKappa([])).toThrow();
  });
});

const CLEAN = breakdown({ domain_captured: 3, constraints_honored: 3, completeness: 3, no_overreach: 3 });
/** Isolates on domain_captured: target drops 2, the other three hold. */
const MUTATED_DOMAIN = breakdown({ domain_captured: 1, constraints_honored: 3, completeness: 3, no_overreach: 3 });
const MUTATED_CONSTRAINTS = breakdown({ domain_captured: 3, constraints_honored: 1, completeness: 3, no_overreach: 3 });
/** Does NOT isolate: the target drops only 1. */
const MUTATED_WEAK = breakdown({ domain_captured: 2, constraints_honored: 3, completeness: 3, no_overreach: 3 });

describe("cleanPairs / mutatedPairs", () => {
  it("labels every dimension of a clean prompt 'not degraded'", () => {
    const pairs = cleanPairs(CLEAN);
    expect(pairs).toHaveLength(4);
    expect(pairs.every(([, label]) => label === false)).toBe(true);
    // The judge scored 3 everywhere, so it said "not degraded" everywhere too.
    expect(pairs.every(([judged]) => judged === false)).toBe(true);
  });

  it("labels exactly the targeted dimension of a mutated prompt 'degraded'", () => {
    const pairs = mutatedPairs(MUTATED_DOMAIN, "domain_captured");
    expect(pairs).toHaveLength(4);
    expect(pairs.filter(([, label]) => label === true)).toHaveLength(1);
    // Targeted dimension: judge says degraded (score <= 1), label says degraded.
    expect(pairs).toContainEqual([true, true]);
  });

  it("assigns the label by target, so the same scores under a different target differ", () => {
    expect(mutatedPairs(MUTATED_DOMAIN, "domain_captured"))
      .not.toEqual(mutatedPairs(MUTATED_DOMAIN, "constraints_honored"));
  });
});

describe("aggregatePairs", () => {
  /**
   * Important 6, the finding this function exists for. The per-mutation shape it replaced
   * emitted a fixture's four clean observations once per SURVIVING mutation, so this fixture —
   * two isolating mutations — contributed 8 clean rows instead of 4, inflating n from 12 to 16
   * and tying the kappa's weighting to isolation success, the very thing being measured.
   */
  it("counts a fixture's clean observations exactly once, however many mutations survive", () => {
    const raw: RawScoreEntry[] = [{
      fixture: "f1", clean: CLEAN,
      mutations: { domain_captured: MUTATED_DOMAIN, constraints_honored: MUTATED_CONSTRAINTS },
    }];
    const { kept, pairs } = aggregatePairs(raw);
    expect(kept).toEqual(["f1/domain_captured", "f1/constraints_honored"]);
    // 1 fixture x 4 clean + 2 kept mutations x 4 = 12, NOT 2 x 8 = 16.
    expect(pairs).toHaveLength(12);
    expect(pairs.filter(([, label]) => label === true)).toHaveLength(2);
  });

  it("still emits a fixture's clean observations when none of its mutations isolate", () => {
    // The correlation from the other side: making the clean row conditional on isolation would
    // reintroduce exactly the data-dependence the per-mutation shape had.
    const raw: RawScoreEntry[] = [{ fixture: "f1", clean: CLEAN, mutations: { domain_captured: MUTATED_WEAK } }];
    const { kept, pairs } = aggregatePairs(raw);
    expect(kept).toEqual([]);
    expect(pairs).toHaveLength(4);
  });

  it("drops a mutation that does not isolate, keeping the ones that do", () => {
    const raw: RawScoreEntry[] = [{
      fixture: "f1", clean: CLEAN,
      mutations: { domain_captured: MUTATED_WEAK, constraints_honored: MUTATED_CONSTRAINTS },
    }];
    const { kept, pairs } = aggregatePairs(raw);
    expect(kept).toEqual(["f1/constraints_honored"]);
    expect(pairs).toHaveLength(8); // 4 clean + 4 from the one survivor
  });

  it("is the count both scripts must agree on: F x 4 clean + K x 4 mutated", () => {
    const raw: RawScoreEntry[] = [
      { fixture: "f1", clean: CLEAN, mutations: { domain_captured: MUTATED_DOMAIN } },
      { fixture: "f2", clean: CLEAN, mutations: { constraints_honored: MUTATED_CONSTRAINTS } },
      { fixture: "f3", clean: CLEAN, mutations: { domain_captured: MUTATED_WEAK } },
    ];
    const { kept, pairs } = aggregatePairs(raw);
    expect(kept).toHaveLength(2);
    expect(pairs).toHaveLength(3 * 4 + 2 * 4);
  });

  it("returns no pairs for no fixtures, so cohensKappa refuses rather than inventing a number", () => {
    expect(aggregatePairs([]).pairs).toHaveLength(0);
    expect(() => cohensKappa(aggregatePairs([]).pairs)).toThrow();
  });
});

describe("validateCalibrationArtifact", () => {
  const valid = () => ({
    measured_on: "2026-09-03", reference: "mutation-derived-v1",
    labelled_dimension_instances: 8, cohens_kappa: 1, threshold: 0.6, max_age_days: 30,
    kept_mutations: ["f1/domain_captured"],
    raw_scores: [{ fixture: "f1", clean: CLEAN, mutations: { domain_captured: MUTATED_DOMAIN } }],
  });

  it("accepts a well-formed artifact", () => {
    expect(validateCalibrationArtifact(valid())).toEqual([]);
  });

  /**
   * Critical 3: each of these is a field whose absence produced `undefined` in the Calibration
   * object, where every one of admitJudge's three calibration comparisons is simply false —
   * so a corrupt artifact was admitted as a measured one. Each must now be NAMED.
   */
  it.each([
    ["cohens_kappa", "cohens_kappa"],
    ["threshold", "threshold"],
    ["max_age_days", "max_age_days"],
    ["measured_on", "measured_on"],
    ["reference", "reference"],
    ["labelled_dimension_instances", "labelled_dimension_instances"],
  ])("rejects an artifact missing %s", (field, named) => {
    const a = valid() as Record<string, unknown>;
    delete a[field];
    const problems = validateCalibrationArtifact(a);
    expect(problems.join("\n")).toContain(named);
  });

  it("rejects a non-numeric kappa rather than letting NaN comparisons pass", () => {
    expect(validateCalibrationArtifact({ ...valid(), cohens_kappa: "0.82" }).join("\n"))
      .toContain("cohens_kappa");
  });

  it("rejects a measured_on that is not a calendar date, since judge.ts appends a time to it", () => {
    expect(validateCalibrationArtifact({ ...valid(), measured_on: "3 September 2026" }).join("\n"))
      .toContain("measured_on");
    expect(validateCalibrationArtifact({ ...valid(), measured_on: "2026-13-45" }).join("\n"))
      .toContain("measured_on");
  });

  it("rejects a raw_scores entry whose breakdown is out of the rubric's 0-3 scale", () => {
    const a = valid();
    a.raw_scores = [{
      fixture: "f1",
      clean: breakdown({ domain_captured: 95, constraints_honored: 3, completeness: 3, no_overreach: 3 }),
      mutations: { domain_captured: MUTATED_DOMAIN },
    }];
    expect(validateCalibrationArtifact(a).join("\n")).toContain("raw_scores[0].clean.domain_captured.score");
  });

  it("rejects a raw_scores entry missing a dimension entirely", () => {
    const a = valid();
    a.raw_scores = [{
      fixture: "f1",
      clean: breakdown({ domain_captured: 3, constraints_honored: 3, completeness: 3 }),
      mutations: { domain_captured: MUTATED_DOMAIN },
    }];
    expect(validateCalibrationArtifact(a).join("\n")).toContain("no_overreach is missing");
  });

  it("rejects a mutations key that is not a rubric dimension", () => {
    const a = valid();
    a.raw_scores = [{ fixture: "f1", clean: CLEAN, mutations: { tone: MUTATED_DOMAIN } as any }];
    expect(validateCalibrationArtifact(a).join("\n")).toContain('unknown dimension "tone"');
  });

  it("rejects a non-object, and says so once rather than listing every missing field", () => {
    expect(validateCalibrationArtifact(null)).toEqual(["the artifact is not a JSON object"]);
    expect(validateCalibrationArtifact([])).toEqual(["the artifact is not a JSON object"]);
    expect(validateCalibrationArtifact("{}")).toEqual(["the artifact is not a JSON object"]);
  });

  it("collects every problem rather than throwing on the first", () => {
    const problems = validateCalibrationArtifact({ raw_scores: [], kept_mutations: [] });
    expect(problems.length).toBeGreaterThan(3);
  });
});
