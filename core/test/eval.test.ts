import { describe, it, expect } from "vitest";
import { listDetectors, getDetector, scoreCase, casePassed } from "../src/eval/detectors.js";
import { compare, mcnemar, requiredAnchorSize } from "../src/eval/compare.js";
import type { EvalCase, PipelineOutcome } from "../../contracts/index.js";

/**
 * The pure half of the evaluation plane. Both modules are Core, so both run under the
 * purity harness — no clock, no randomness, no network — which is what lets a
 * comparison be recomputed from stored artifacts rather than by re-invoking a model.
 */

const outcome = (over: Partial<PipelineOutcome> = {}): PipelineOutcome => ({
  command_id: "c",
  run_id: "r",
  stage_id: "compile",
  output: { text: "# SYSTEM PROMPT\n\nAnswer billing questions." },
  gate_results: [
    { gate_id: "SECRET_LEAK_SCAN", gate_version: "1.1.0", verdict: "PASS", message: "", message_code: "ok", input_hash: "a".repeat(64), location: null },
    { gate_id: "CLAIM_DISCIPLINE", gate_version: "1.1.0", verdict: "PASS", message: "", message_code: "ok", input_hash: "a".repeat(64), location: null },
  ],
  demo_mode: false,
  revision_id: "rev",
  execution_provenance: {
    core_build_hash: "test",
    contract_versions: { "gate-result": "1.3.0" },
    provider_model_fingerprint: "p:m",
    config_fingerprint: null,
  },
  ...over,
});

const kase = (over: Partial<EvalCase> = {}): EvalCase => ({
  case_id: "k",
  input: { brief: "x" },
  expectation: { kind: "none" },
  failure_mode: "constraint-violation",
  detector_ids: ["output-nonempty"],
  ...over,
});

describe("detectors", () => {
  it("are registered, not hardcoded — the list is not the ceiling", () => {
    expect(listDetectors().length).toBeGreaterThan(5);
    expect(getDetector("output-nonempty")).toBeDefined();
  });

  it("an unknown detector fails the case rather than being skipped", () => {
    // A suite referencing a detector nobody wrote would otherwise report a clean run.
    const scores = scoreCase(kase({ detector_ids: ["no-such-detector"] }), outcome());
    expect(scores[0].passed).toBe(false);
    expect(scores[0].detail).toContain("unknown detector");
  });

  it("a case passes only when every detector passes", () => {
    expect(casePassed([{ case_id: "k", detector_id: "a", passed: true, detail: "" },
                       { case_id: "k", detector_id: "b", passed: false, detail: "" }])).toBe(false);
    expect(casePassed([])).toBe(false);
  });

  it("catches degraded output that does not label itself", () => {
    const d = getDetector("demo-labelled-when-degraded")!;
    expect(d.run(outcome({ demo_mode: true, output: { text: "Here is your prompt." } }), { kind: "none" }).passed).toBe(false);
    expect(d.run(outcome({ demo_mode: true, output: { text: "⟦WORKFLOW DEMO — no model⟧ nothing was produced" } }), { kind: "none" }).passed).toBe(true);
  });

  it("catches degraded output that fabricates a prompt", () => {
    const d = getDetector("no-fabrication-when-degraded")!;
    expect(d.run(outcome({ demo_mode: true, output: { text: "SYSTEM PROMPT: you are helpful" } }), { kind: "none" }).passed).toBe(false);
  });

  it("gate-verdict asserts a gate fired, which no-gate-failures cannot", () => {
    // A gate that never runs also produces no failures; only this detector tells them apart.
    const d = getDetector("gate-verdict")!;
    const warned = outcome({
      gate_results: [{ gate_id: "SECRET_LEAK_SCAN", gate_version: "1", verdict: "WARN", message: "", message_code: "m", input_hash: "a".repeat(64), location: null }],
    });
    expect(d.run(warned, { kind: "predicate", value: { gate: "SECRET_LEAK_SCAN", verdict: "WARN" } }).passed).toBe(true);
    expect(d.run(outcome(), { kind: "predicate", value: { gate: "SECRET_LEAK_SCAN", verdict: "WARN" } }).passed).toBe(false);
    expect(d.run(outcome(), { kind: "predicate", value: { gate: "NEVER_REGISTERED", verdict: "PASS" } }).passed).toBe(false);
  });

  it("is deterministic — same inputs, same scores", () => {
    const k = kase({ detector_ids: ["output-nonempty", "gates-ran", "provenance-complete"] });
    expect(scoreCase(k, outcome())).toEqual(scoreCase(k, outcome()));
  });
});

/* ── the comparator ───────────────────────────────────────────────────────── */

const suite = { resolution: { detectable_delta: 0.01, confidence: 0.95 } };
const outcomes = (spec: string) =>
  spec.split("").map((ch, i) => ({ case_id: `c${i}`, passed: ch === "1" }));

const base = {
  comparison_id: "cmp",
  candidate_run_id: "cand",
  baseline_id: "base",
  suite,
  comparisons_in_family: 1,
  alpha: 0.05,
  detectors_equalized: true,
};

describe("mcnemar", () => {
  it("is exact, not the chi-square approximation, because smoke suites have small counts", () => {
    // 10 vs 0 discordant: p = 2 * 0.5^10 = 0.001953125
    expect(mcnemar(10, 0).p).toBeCloseTo(0.001953125, 9);
    // 1 vs 0: p = 2 * 0.5 = 1.0
    expect(mcnemar(1, 0).p).toBeCloseTo(1, 9);
    // symmetric evidence is never significant
    expect(mcnemar(5, 5).p).toBeCloseTo(1, 9);
  });

  it("returns p = 1 when there is nothing to compare", () => {
    expect(mcnemar(0, 0).p).toBe(1);
  });
});

describe("compare", () => {
  it("refuses when detectors were not equalized", () => {
    const r = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10"), detectors_equalized: false });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("recall");
  });

  it("refuses when the two runs do not share a case set", () => {
    const r = compare({
      ...base,
      candidate: [{ case_id: "a", passed: true }],
      baseline: [{ case_id: "b", passed: false }],
    });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("paired test");
  });

  it("reports improved only when the evidence clears alpha", () => {
    // 12 flips to pass, none the other way: p ≈ 0.00049
    const r = compare({ ...base, candidate: outcomes("111111111111"), baseline: outcomes("000000000000") });
    expect(r.verdict).toBe("improved");
    expect(r.delta).toBeCloseTo(1, 6);
    expect(r.protocol.p_value!).toBeLessThan(0.05);
  });

  it("reports regressed symmetrically", () => {
    const r = compare({ ...base, candidate: outcomes("000000000000"), baseline: outcomes("111111111111") });
    expect(r.verdict).toBe("regressed");
  });

  it("returns inconclusive rather than rounding toward a decision", () => {
    // One flip each way — a real difference in the score, no evidence behind it.
    const r = compare({ ...base, candidate: outcomes("1100"), baseline: outcomes("1010") });
    expect(r.verdict).toBe("inconclusive");
  });

  it("returns inconclusive when the two runs agree on every case", () => {
    const r = compare({ ...base, candidate: outcomes("1010"), baseline: outcomes("1010") });
    expect(r.verdict).toBe("inconclusive");
    expect(r.refusal_reason).toContain("agree on every case");
  });

  it("returns inconclusive when the delta is below the suite's declared resolution", () => {
    // A suite that can only see 0.5 must not pronounce on a difference of 1/12.
    const coarse = { resolution: { detectable_delta: 0.5, confidence: 0.95 } };
    const r = compare({ ...base, suite: coarse, candidate: outcomes("111111111111"), baseline: outcomes("111111111110") });
    expect(r.verdict).toBe("inconclusive");
    expect(r.refusal_reason).toContain("resolution");
  });

  it("corrects alpha for multiplicity, so an optimizer cannot win by volume", () => {
    // The same evidence that clears a standalone comparison must not clear one of 100.
    const evidence = { candidate: outcomes("11111111111"), baseline: outcomes("00000000000") };
    const alone = compare({ ...base, ...evidence });
    const inFamily = compare({ ...base, ...evidence, comparisons_in_family: 100 });

    expect(alone.verdict).toBe("improved");
    expect(inFamily.verdict).toBe("inconclusive");
    expect(inFamily.protocol.correction).toBe("bonferroni");
    expect(inFamily.protocol.alpha).toBeCloseTo(0.0005, 6);
  });

  it("defaults to bonferroni whenever a family is declared", () => {
    const r = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10"), comparisons_in_family: 45 });
    expect(r.protocol.correction).toBe("bonferroni");
    expect(r.protocol.alpha).toBeCloseTo(0.05 / 45, 8);
  });
});

describe("anchor sizing", () => {
  it("puts a two-point difference at roughly 3,400 items", () => {
    // The number that makes smoke and anchor different objects rather than one object
    // at two sizes. z(0.05) ≈ 1.645, so 1.645^2 / (2 * 0.02^2) ≈ 3,383.
    const n = requiredAnchorSize(0.02, 0.95);
    expect(n).toBeGreaterThan(3300);
    expect(n).toBeLessThan(3500);
  });

  it("grows quadratically as the target difference shrinks", () => {
    expect(requiredAnchorSize(0.01) / requiredAnchorSize(0.02)).toBeCloseTo(4, 0);
  });

  it("shows an eight-case smoke suite can only see a large difference", () => {
    // Inverted: what delta could 8 items resolve? Far more than any real improvement.
    expect(requiredAnchorSize(0.5)).toBeLessThan(10);
  });
});
