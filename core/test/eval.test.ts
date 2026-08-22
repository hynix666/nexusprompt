import { describe, it, expect } from "vitest";
import { listDetectors, getDetector, scoreCase, casePassed } from "../src/eval/detectors.js";
import { compare, mcnemar, requiredAnchorSize } from "../src/eval/compare.js";
import {
  PROBE_CORPUS, PROBE_CORPUS_VERSION, measureRecall,
  detectorsWithoutProbes, probesWithoutDetectors, deadDetectors,
} from "../src/eval/probes.js";
import type { EvalCase, PipelineOutcome, DetectorRecallBlock } from "../../contracts/index.js";

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

/**
 * A recall block with the figures a test wants to assert on. Substrate and probe counts are
 * back-filled to be consistent with the recall, so the block is a value the system could
 * actually have produced rather than a shape that only satisfies the type.
 */
const recallBlock = (
  recalls: Record<string, number | null>,
  probe_corpus_version = PROBE_CORPUS_VERSION,
): DetectorRecallBlock => ({
  probe_corpus_version,
  detectors: Object.entries(recalls).map(([detector_id, recall]) => ({
    detector_id,
    substrates: recall === null ? 0 : 4,
    probes_run: recall === null ? 0 : 4,
    probes_detected: recall === null ? 0 : Math.round(recall * 4),
    recall,
  })),
});

const base = {
  comparison_id: "cmp",
  candidate_run_id: "cand",
  baseline_id: "base",
  suite,
  comparisons_in_family: 1,
  alpha: 0.05,
  candidateRecall: recallBlock({ d: 1 }),
  baselineRecall: recallBlock({ d: 1 }),
  suiteDetectorIds: ["d"],
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
  it("refuses when a run carries no measured recall", () => {
    // Until contract 2.0.0 this was a boolean the caller asserted and nothing computed.
    // Absent recall is a refusal, never a default.
    const r = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10"), candidateRecall: null });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("candidate run");
    expect(r.equalization.equalized).toBe(false);
    expect(r.equalization.max_gap).toBeNull();
  });

  it("refuses across differing probe corpora", () => {
    const r = compare({
      ...base, candidate: outcomes("11"), baseline: outcomes("10"),
      baselineRecall: recallBlock({ d: 1 }, "9.9.9"),
    });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("probe corpus");
  });

  it("refuses when a detector left no substrate, rather than reading null as perfect", () => {
    // recall null means the detector fired on everything — the always-fires case, which
    // scores 1.0 on any naive reading and is worthless.
    const r = compare({
      ...base, candidate: outcomes("11"), baseline: outcomes("10"),
      candidateRecall: recallBlock({ d: null }),
    });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("unmeasurable");
  });

  it("refuses when a detector the suite uses is missing from a run's block", () => {
    const r = compare({
      ...base, candidate: outcomes("11"), baseline: outcomes("10"),
      suiteDetectorIds: ["d", "never-measured"],
    });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("never-measured");
  });

  it("derives gap_bound from the suite, so it tightens as a suite grows", () => {
    const coarse = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10") });
    const fine = compare({
      ...base, candidate: outcomes("11"), baseline: outcomes("10"),
      suite: { resolution: { detectable_delta: 0.005, confidence: 0.95 } },
    });
    expect(coarse.equalization.gap_bound).toBe(0.01);
    expect(fine.equalization.gap_bound).toBe(0.005);
  });

  it("takes effective recall as the minimum over BOTH runs", () => {
    // The comparison is only as sharp as the blunter of the two instruments producing it.
    const r = compare({
      ...base, candidate: outcomes("11"), baseline: outcomes("10"),
      candidateRecall: recallBlock({ d: 1, e: 0.75 }),
      baselineRecall: recallBlock({ d: 0.75, e: 1 }),
      suiteDetectorIds: ["d", "e"],
      suite: { resolution: { detectable_delta: 0.5, confidence: 0.95 } },
    });
    expect(r.equalization.effective_recall).toBeCloseTo(0.75, 6);
    // 0.5 / 0.75 — a blunter instrument must show a larger observed difference.
    expect(r.equalization.adjusted_resolution).toBeCloseTo(0.6667, 3);
  });

  it("leaves resolution untouched at recall 1, so a perfect instrument sees no change", () => {
    const r = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10") });
    expect(r.equalization.effective_recall).toBe(1);
    expect(r.equalization.adjusted_resolution).toBe(base.suite.resolution.detectable_delta);
  });

  it("widens the resolution enough to change a verdict when recall is poor", () => {
    // 1 of 12 flips = 0.0833. Declared resolution 0.05 would report it; at recall 0.25 the
    // adjusted resolution is 0.2, and the suite correctly declines to pronounce.
    const evidence = { candidate: outcomes("111111111111"), baseline: outcomes("111111111110") };
    const suite12 = { resolution: { detectable_delta: 0.05, confidence: 0.95 } };
    const sharp = compare({ ...base, ...evidence, suite: suite12 });
    const blunt = compare({
      ...base, ...evidence, suite: suite12,
      candidateRecall: recallBlock({ d: 0.25 }), baselineRecall: recallBlock({ d: 0.25 }),
    });
    expect(sharp.refusal_reason).not.toContain("resolution");
    expect(blunt.verdict).toBe("inconclusive");
    expect(blunt.refusal_reason).toContain("resolution");
    expect(blunt.refusal_reason).toContain("widened");
  });

  it("REFUSES the detection-format artifact: same true failure rate, unequal recall", () => {
    /**
     * The acceptance test, and the reason this subsystem exists.
     *
     * Rebuild the Cross-Provider Architectural Ablation finding in miniature. Both
     * configurations genuinely fail twelve of twenty-four cases. The baseline's detector
     * catches all twelve; the candidate's catches six, because its output format makes
     * failures harder to find. Nothing about the candidate is better — but it scores 0.75
     * against 0.50 and reads as a clear, significant improvement.
     *
     * That is the shape of a finding that was published at 10-15 points and was an
     * artifact. The comparator must refuse, not report the delta with a caveat.
     *
     * Twenty-four cases rather than twelve because six one-directional discordant pairs is
     * the minimum for p < 0.05. At twelve the artifact produces only three and lands on
     * `inconclusive` for an unrelated reason, which would make this test pass while
     * demonstrating nothing.
     */
    const artifact = {
      //         12 genuine passes           12 genuine failures
      candidate: outcomes("111111111111" + "111111000000"), // 6 of 12 observed
      baseline: outcomes("111111111111" + "000000000000"), // 12 of 12 observed
      suite: { resolution: { detectable_delta: 0.05, confidence: 0.95 } },
    };

    const blind = compare({ ...base, ...artifact }); // pretend both detectors were equal
    expect(blind.verdict).toBe("improved");
    expect(blind.delta).toBeCloseTo(0.25, 6);

    const honest = compare({
      ...base, ...artifact,
      candidateRecall: recallBlock({ d: 0.5 }),
      baselineRecall: recallBlock({ d: 1.0 }),
    });
    expect(honest.verdict).toBe("refused");
    expect(honest.delta).toBeNull();
    expect(honest.equalization.max_gap).toBeCloseTo(0.5, 6);
    expect(honest.refusal_reason).toContain("measure the instrument");
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

/* ── the instrument check ─────────────────────────────────────────────────── */

describe("mutation probes", () => {
  // A clean outcome every detector is silent on, so it is a valid substrate for all of them.
  const clean = outcome({
    output: { text: "# SYSTEM PROMPT\n\nAnswer billing questions. State what was verified." },
  });

  it("covers every registered detector — the coverage rule that fails the build", () => {
    expect(detectorsWithoutProbes()).toEqual([]);
  });

  it("has no probe targeting a detector nobody wrote", () => {
    expect(probesWithoutDetectors()).toEqual([]);
  });

  it("every probe actually fires its detector — no probe is decorative", () => {
    // The must-fire half. A probe whose mutation does not trip its detector measures nothing
    // and silently drags recall down, which reads as a weak detector rather than a bad probe.
    for (const probe of PROBE_CORPUS) {
      const detector = getDetector(probe.detector_id)!;
      if (!detector.run(clean, probe.expectation).passed) continue; // not a substrate for this one
      const fired = !detector.run(probe.mutate(clean), probe.expectation).passed;
      expect(fired, `probe ${probe.id} did not fire ${probe.detector_id}`).toBe(true);
    }
  });

  it("no probe mutates its input — Core returns new values", () => {
    const before = JSON.stringify(clean);
    for (const probe of PROBE_CORPUS) probe.mutate(clean);
    expect(JSON.stringify(clean)).toBe(before);
  });

  it("counts a probe only where the detector was silent first", () => {
    // The must-not-fire half, and the substrate rule. An outcome that ALREADY has an empty
    // output is not evidence that `output-nonempty` can detect an emptied one.
    const alreadyEmpty = outcome({ output: { text: "" } });
    const block = measureRecall([alreadyEmpty], PROBE_CORPUS.filter((p) => p.detector_id === "output-nonempty"));
    const d = block.detectors.find((x) => x.detector_id === "output-nonempty")!;
    expect(d.substrates).toBe(0);
    expect(d.probes_run).toBe(0);
    expect(d.recall).toBeNull();
  });

  it("reports null, not zero, when there is no substrate", () => {
    // These are different diagnoses and take different paths: null refuses a comparison,
    // zero fails the build. Collapsing them fails the build for the wrong reason.
    const alwaysFires = measureRecall([outcome({ output: { text: "" } })],
      PROBE_CORPUS.filter((p) => p.detector_id === "output-nonempty"));
    expect(alwaysFires.detectors[0].recall).toBeNull();
    expect(deadDetectors(alwaysFires)).toEqual([]); // unmeasurable is not dead
  });

  it("reports zero and marks dead when probes ran and caught nothing", () => {
    const blind = { id: "no-op", detector_id: "output-nonempty", expectation: { kind: "none" } as const,
                    mutate: (o: PipelineOutcome) => o };
    const block = measureRecall([clean], [blind]);
    expect(block.detectors[0].recall).toBe(0);
    expect(deadDetectors(block)).toEqual(["output-nonempty"]);
  });

  it("measures full recall against the real corpus on a clean outcome", () => {
    const block = measureRecall([clean]);
    for (const d of block.detectors) {
      if (d.recall !== null) expect(d.recall, `${d.detector_id} recall`).toBe(1);
    }
    expect(block.probe_corpus_version).toBe(PROBE_CORPUS_VERSION);
  });

  it("is deterministic — same outcomes, same block", () => {
    expect(measureRecall([clean])).toEqual(measureRecall([clean]));
  });

  it("gives every detector at least one probe, structural ones included", () => {
    // A structural detector scores 1.0 from a trivial probe, and the probe is still not
    // ceremony: it proves the detector fires at all. A detector that has never fired is
    // dead code behind a passing suite.
    const byDetector = new Map<string, number>();
    for (const p of PROBE_CORPUS) byDetector.set(p.detector_id, (byDetector.get(p.detector_id) ?? 0) + 1);
    for (const d of listDetectors()) expect(byDetector.get(d.id) ?? 0, `${d.id} probes`).toBeGreaterThan(0);
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

  it("shows a smoke-sized suite can only see a large difference", () => {
    // Inverted: what delta could a dozen-odd items resolve? Far more than any real improvement.
    expect(requiredAnchorSize(0.5)).toBeLessThan(10);
  });
});

/* ── budget and the cache key ──────────────────────────────────────────────── */

import {
  isDeterministic, cacheKey, plannedCalls, admitRun, accrue, hit, exceeds, emptyCost,
} from "../src/eval/budget.js";

describe("isDeterministic", () => {
  it.each([
    ["temperature 0", { temperature: 0 }, true],
    ["temperature 0.7", { temperature: 0.7 }, false],
    ["temperature 1", { temperature: 1 }, false],
    ["null temperature with a seed", { temperature: null, seed: 7 }, true],
    ["null temperature with no seed", { temperature: null }, false],
    ["null temperature with a null seed", { temperature: null, seed: null }, false],
  ])("%s", (_name, decoding, expected) => {
    expect(isDeterministic(decoding)).toBe(expected);
  });

  it("does not treat a deprecated temperature as greedy decoding", () => {
    // A null temperature records that the provider REMOVED the parameter, which newer
    // frontier models have done. That is the absence of a control, not a promise of
    // determinism, and reading it as one would make the cache collapse trials that can
    // still differ.
    expect(isDeterministic({ temperature: null })).toBe(false);
  });
});

describe("cacheKey", () => {
  const DET = { temperature: 0 };
  const STOCH = { temperature: 0.7 };

  it("omits the trial index when decoding is deterministic", () => {
    expect(cacheKey("cfg", "case-1", 0, DET)).toBe(cacheKey("cfg", "case-1", 41, DET));
  });

  it("includes the trial index when decoding is stochastic", () => {
    // The correction to ADR-0008. Keyed on (config, case) alone, trials 2..100 are cache
    // hits of trial 1 — one sample reported as a hundred, with a measured variance of
    // exactly zero. The cache would not make a repeated-trial protocol affordable, it
    // would make it not a protocol.
    expect(cacheKey("cfg", "case-1", 0, STOCH)).not.toBe(cacheKey("cfg", "case-1", 1, STOCH));
  });

  it("separates configurations and cases regardless of decoding", () => {
    expect(cacheKey("a", "c", 0, DET)).not.toBe(cacheKey("b", "c", 0, DET));
    expect(cacheKey("a", "c1", 0, DET)).not.toBe(cacheKey("a", "c2", 0, DET));
  });
});

describe("plannedCalls", () => {
  it("counts one call per case when decoding is deterministic, however many trials", () => {
    expect(plannedCalls(14, 100, { temperature: 0 })).toBe(14);
  });

  it("counts every trial when decoding is stochastic", () => {
    expect(plannedCalls(14, 100, { temperature: 0.7 })).toBe(1400);
  });
});

describe("admitRun", () => {
  const budget = (over = {}) => ({ on_exceed: "refuse" as const, max_provider_calls: 100, ...over });

  it("admits when no budget is declared, and says so", () => {
    const a = admitRun({ plannedCalls: 9_999 });
    expect(a.admit).toBe(true);
    expect(a.reason).toContain("no budget declared");
  });

  it("admits within budget", () => {
    expect(admitRun({ budget: budget(), plannedCalls: 50 }).admit).toBe(true);
  });

  it("refuses BEFORE dispatch rather than stopping midway", () => {
    // A partially executed suite is not an EvalRun: its aggregate would be a score over
    // whichever cases happened to fit, published under the name of a suite that means
    // something else.
    const a = admitRun({ budget: budget(), plannedCalls: 101 });
    expect(a.admit).toBe(false);
    expect(a.allowedCalls).toBe(0);
    expect(a.reason).toContain("refused before dispatch");
  });

  it("truncates instead when the configuration asked for that", () => {
    const a = admitRun({ budget: budget({ on_exceed: "truncate_suite" }), plannedCalls: 500 });
    expect(a.admit).toBe(true);
    expect(a.allowedCalls).toBe(100);
  });

  it("bounds by dollars as well as calls", () => {
    const a = admitRun({ budget: { on_exceed: "refuse", max_usd: 1 }, plannedCalls: 1, estimatedUsd: 5 });
    expect(a.admit).toBe(false);
    expect(a.reason).toContain("max_usd");
  });

  it("does not bound by dollars when the spend cannot be estimated", () => {
    // An unmeasurable estimate must not be treated as zero. Refusing on an unknown would
    // block every run against a provider that reports no usage; admitting on it silently is
    // what `budget_exceeded` catches after the fact.
    expect(admitRun({ budget: { on_exceed: "refuse", max_usd: 1 }, plannedCalls: 1 }).admit).toBe(true);
  });

  it("gives a reason whether or not it admitted", () => {
    expect(admitRun({ budget: budget(), plannedCalls: 1 }).reason).toBeTruthy();
    expect(admitRun({ budget: budget(), plannedCalls: 999 }).reason).toBeTruthy();
  });
});

describe("cost accrual", () => {
  it("sums usage and counts calls", () => {
    let c = emptyCost();
    c = accrue(c, { prompt_tokens: 100, completion_tokens: 20 }, { in: 3, out: 15 });
    c = accrue(c, { prompt_tokens: 50, completion_tokens: 10 }, { in: 3, out: 15 });
    expect(c.tokens_in).toBe(150);
    expect(c.tokens_out).toBe(30);
    expect(c.provider_calls).toBe(2);
    expect(c.usd).toBeCloseTo((150 / 1e6) * 3 + (30 / 1e6) * 15, 12);
  });

  it("reports null dollars rather than zero when no rate is known", () => {
    // Zero reads as free; null reads as unmeasured, and those take different paths.
    expect(accrue(emptyCost(), { prompt_tokens: 10 }, null).usd).toBeNull();
  });

  it("counts a cache hit without counting a provider call", () => {
    const c = hit(emptyCost());
    expect(c.cache_hits).toBe(1);
    expect(c.provider_calls).toBe(0);
  });

  it("detects a spend past the declared budget", () => {
    const spent = { ...emptyCost(), provider_calls: 11 };
    expect(exceeds(spent, { on_exceed: "refuse", max_provider_calls: 10 })).toBe(true);
    expect(exceeds(spent, { on_exceed: "refuse", max_provider_calls: 11 })).toBe(false);
    expect(exceeds(spent, null)).toBe(false);
  });

  it("does not judge a dollar budget it cannot measure", () => {
    const spent = { ...emptyCost(), usd: null, provider_calls: 5 };
    expect(exceeds(spent, { on_exceed: "refuse", max_usd: 0.01 })).toBe(false);
  });
});
