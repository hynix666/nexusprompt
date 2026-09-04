import { describe, it, expect } from "vitest";
import { isolatesCleanly, cohensKappa, derivePairs } from "../src/eval/judge-calibration.js";

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

describe("derivePairs", () => {
  const clean = breakdown({ domain_captured: 3, constraints_honored: 3, completeness: 3, no_overreach: 3 });
  const mutated = breakdown({ domain_captured: 1, constraints_honored: 3, completeness: 3, no_overreach: 3 });

  it("pairs the judge's binarized score against the mutation-derived label, for all four dimensions on both prompts", () => {
    const pairs = derivePairs(clean, mutated, "domain_captured");
    // 4 dimensions x 2 prompts (mutated, clean) = 8 pairs.
    expect(pairs).toHaveLength(8);
    // The mutated prompt's targeted dimension: judge says degraded (score<=1 -> true), label says degraded (true).
    expect(pairs).toContainEqual([true, true]);
    // The clean prompt is never labelled degraded on any dimension.
    expect(pairs.filter(([, label]) => label === true)).toHaveLength(1);
  });

  it("is the exact pairing scripts/build-judge-calibration.ts and scripts/check-judge.ts must agree on", () => {
    // Same clean/mutated pair, different target dimension -> different label assignment.
    const pairsA = derivePairs(clean, mutated, "domain_captured");
    const pairsB = derivePairs(clean, mutated, "constraints_honored");
    expect(pairsA).not.toEqual(pairsB);
  });
});
