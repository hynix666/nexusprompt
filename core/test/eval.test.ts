import { describe, it, expect } from "vitest";
import { listDetectors, getDetector, scoreCase, casePassed } from "../src/eval/detectors.js";
import { compare, mcnemar, requiredAnchorSize } from "../src/eval/compare.js";
import {
  PROBE_CORPUS, PROBE_CORPUS_VERSION, measureRecall,
  detectorsWithoutProbes, probesWithoutDetectors, deadDetectors,
} from "../src/eval/probes.js";
import type { EvalCase, PipelineOutcome, DetectorRecallBlock } from "../../contracts/index.js";
import { PIPELINE } from "../src/stages/pipeline.js";

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

  it("catches a marker forged into LIVE output — the converse that was missing", () => {
    const d = getDetector("no-marker-when-live")!;
    const none: Parameters<typeof d.run>[1] = { kind: "none" };

    // Must fire: not degraded, and wearing a marker only the pipeline may emit.
    for (const marker of ["⟦WORKFLOW DEMO — no model⟧", "⟦MODEL ANSWERED — OUTPUT UNUSABLE⟧"]) {
      const o = outcome({ demo_mode: false, output: { text: `${marker}\n\nBe useful.` } });
      expect({ marker, passed: d.run(o, none).passed }).toEqual({ marker, passed: false });
    }

    // Must NOT fire: a degraded run wearing a marker is the correct state, and
    // `demo-labelled-when-degraded` is the detector that owns it.
    expect(d.run(outcome({ demo_mode: true, output: { text: "⟦WORKFLOW DEMO — no model⟧" } }), none).passed).toBe(true);

    // Must NOT fire on a near-miss. Widening this would make a model unable to DISCUSS the
    // demo mechanism without being reported as forging it.
    expect(d.run(outcome({ demo_mode: false, output: { text: "[WORKFLOW DEMO - no model] is what it prints" } }), none).passed).toBe(true);

    // Must NOT fire on ordinary live output — otherwise every case would fail and the
    // detector would be measuring nothing.
    expect(d.run(outcome({ demo_mode: false, output: { text: "# SYSTEM PROMPT\n\nBe useful." } }), none).passed).toBe(true);
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

const suite = { resolution: { detectable_delta: 0.01, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const };
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

// `equalization!` throughout this block: compare() (unlike compareGraded(), added for the
// judge-scored comparison pilot) never returns a null equalization, only Comparison's contract
// type admits one now.
describe("compare", () => {
  it("refuses when a run carries no measured recall", () => {
    // Until contract 2.0.0 this was a boolean the caller asserted and nothing computed.
    // Absent recall is a refusal, never a default.
    const r = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10"), candidateRecall: null });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("candidate run");
    expect(r.equalization!.equalized).toBe(false);
    expect(r.equalization!.max_gap).toBeNull();
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
      suite: { resolution: { detectable_delta: 0.005, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const },
    });
    expect(coarse.equalization!.gap_bound).toBe(0.01);
    expect(fine.equalization!.gap_bound).toBe(0.005);
  });

  it("takes effective recall as the minimum over BOTH runs", () => {
    // The comparison is only as sharp as the blunter of the two instruments producing it.
    const r = compare({
      ...base, candidate: outcomes("11"), baseline: outcomes("10"),
      candidateRecall: recallBlock({ d: 1, e: 0.75 }),
      baselineRecall: recallBlock({ d: 0.75, e: 1 }),
      suiteDetectorIds: ["d", "e"],
      suite: { resolution: { detectable_delta: 0.5, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const },
    });
    expect(r.equalization!.effective_recall).toBeCloseTo(0.75, 6);
    // 0.5 / 0.75 — a blunter instrument must show a larger observed difference.
    expect(r.equalization!.adjusted_resolution).toBeCloseTo(0.6667, 3);
  });

  it("leaves resolution untouched at recall 1, so a perfect instrument sees no change", () => {
    const r = compare({ ...base, candidate: outcomes("11"), baseline: outcomes("10") });
    expect(r.equalization!.effective_recall).toBe(1);
    expect(r.equalization!.adjusted_resolution).toBe(base.suite.resolution.detectable_delta);
  });

  it("widens the resolution enough to change a verdict when recall is poor", () => {
    // 1 of 12 flips = 0.0833. Declared resolution 0.05 would report it; at recall 0.25 the
    // adjusted resolution is 0.2, and the suite correctly declines to pronounce.
    const evidence = { candidate: outcomes("111111111111"), baseline: outcomes("111111111110") };
    const suite12 = { resolution: { detectable_delta: 0.05, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const };
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
      suite: { resolution: { detectable_delta: 0.05, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const },
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
    expect(honest.equalization!.max_gap).toBeCloseTo(0.5, 6);
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
    /**
     * Four flips one way, three the other — a real difference in the score with no evidence
     * behind it. Twelve cases rather than four: with four, the exact test's smallest
     * attainable p is 0.125 and the comparison is refused for being unanswerable before the
     * outcomes matter. Testing "inconclusive" needs a design that could have said otherwise.
     */
    const r = compare({ ...base, candidate: outcomes("000111110000"), baseline: outcomes("111100000000") });
    expect(r.verdict).toBe("inconclusive");
    expect(r.protocol.discordant).toBe(7);
    expect(r.protocol.attainable).toBe(true);
    expect(r.refusal_reason).toContain("does not clear alpha");
  });

  it("returns inconclusive when the two runs agree on every case", () => {
    const r = compare({ ...base, candidate: outcomes("10100100"), baseline: outcomes("10100100") });
    expect(r.verdict).toBe("inconclusive");
    expect(r.refusal_reason).toContain("agree on every case");
  });

  it("names an underpowered result as such, not as an absence of difference", () => {
    /**
     * Eight cases, disagreeing on two. The design could have rejected — eight units clears
     * the floor — but the two discordant units it actually produced bottom out at p = 0.5.
     *
     * Both of these are "inconclusive", and they mean opposite things: "we looked and the
     * runs did not separate" versus "they did separate, and this test could not have called
     * any such separation significant". Collapsing them is how a suite's weakness gets
     * reported as a configuration's equivalence.
     */
    const r = compare({ ...base, candidate: outcomes("11000000"), baseline: outcomes("10100000") });
    expect(r.verdict).toBe("inconclusive");
    expect(r.protocol.discordant).toBe(2);
    expect(r.protocol.attainable).toBe(false);
    expect(r.refusal_reason).toContain("could not have called any such difference");
    expect(r.refusal_reason).not.toContain("does not clear alpha");
  });

  it("refuses a suite too small for the exact test to ever reject", () => {
    /**
     * The floor is a property of the design, not of the data. Under McNemar the statistic is
     * binomial(d, 0.5), so d discordant units bottom out at 2 * 0.5^d; five of them reach
     * 0.0625 and stop. A four-case suite cannot produce a significant result whatever the
     * outcomes are, and saying "inconclusive" would credit it with a look it never took.
     *
     * `eval/compile-smoke.json` has carried the sentence "resolving a difference takes six
     * flips, not one" in its comment block since it was written. This is that sentence, as code.
     */
    const r = compare({ ...base, candidate: outcomes("1111"), baseline: outcomes("0000") });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("No outcome this comparison could produce");
    expect(r.delta).toBeNull();
  });

  it("reports the discordant count and the design floor on every comparison", () => {
    const r = compare({ ...base, candidate: outcomes("111111111111"), baseline: outcomes("000000000000") });
    // 12 discordant units: the exact sample size of the test, not the 12 cases by coincidence.
    expect(r.protocol.discordant).toBe(12);
    expect(r.protocol.min_attainable_p).toBeCloseTo(2 * Math.pow(0.5, 12), 12);
    expect(r.protocol.attainable).toBe(true);
  });

  it("returns inconclusive when the delta is below the suite's declared resolution", () => {
    // A suite that can only see 0.5 must not pronounce on a difference of 1/12.
    const coarse = { resolution: { detectable_delta: 0.5, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const };
    const r = compare({ ...base, suite: coarse, candidate: outcomes("111111111111"), baseline: outcomes("111111111110") });
    expect(r.verdict).toBe("inconclusive");
    expect(r.refusal_reason).toContain("resolution");
  });

  it("corrects alpha for multiplicity, so an optimizer cannot win by volume", () => {
    /**
     * The same evidence that clears a standalone comparison must not clear one of 100.
     * Fourteen cases split 12 up / 2 down: p = 0.0129, which clears 0.05 alone and not the
     * corrected 0.0005 — while leaving the design capable at both, so the verdict turns on
     * the evidence rather than on the suite's size.
     */
    const evidence = { candidate: outcomes("11111111111100"), baseline: outcomes("00000000000011") };
    const alone = compare({ ...base, ...evidence });
    const inFamily = compare({ ...base, ...evidence, comparisons_in_family: 100 });

    expect(alone.verdict).toBe("improved");
    expect(inFamily.verdict).toBe("inconclusive");
    expect(inFamily.protocol.attainable).toBe(true);
    expect(inFamily.protocol.correction).toBe("bonferroni");
    expect(inFamily.protocol.alpha).toBeCloseTo(0.0005, 6);
  });

  it("refuses when multiplicity correction pushes the floor past the suite size", () => {
    /**
     * Correction does not merely raise the bar, it can move it out of the suite's reach.
     * At alpha 0.0005 the exact test needs twelve discordant units before any arrangement
     * clears it; an eleven-case suite has eleven. Running a hundred comparisons against a
     * suite this size is not a stricter search, it is a search that cannot return anything —
     * and reporting a hundred "inconclusive" verdicts would look like a hundred honest looks.
     */
    const r = compare({
      ...base,
      candidate: outcomes("11111111111"),
      baseline: outcomes("00000000000"),
      comparisons_in_family: 100,
    });
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("11 independent unit(s)");
    expect(r.refusal_reason).toContain("at least 12");
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
  isDeterministic, cacheKey, plannedCalls, plannedPipelineCalls, admitRun, accrue, assertValidRate, hit, exceeds, emptyCost,
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

describe("plannedPipelineCalls", () => {
  const P = PIPELINE.map((s) => ({ id: s.id as string, kind: s.kind }));

  it("counts the generating stages of the plan it is given, not a nominal eleven", () => {
    // Nine of the eleven stages generate; `lint` and `cost_estimate` are deterministic.
    expect(plannedPipelineCalls({ plan: P })).toBe(9);
    expect(P.length).toBe(11);
    // A shallower plan costs less, which is the whole reason this takes a plan.
    const tiny = P.slice(0, 4);
    expect(plannedPipelineCalls({ plan: tiny })).toBeLessThan(plannedPipelineCalls({ plan: P }));
  });

  it("adds one generating execution per feedback round, DERIVED from the refine..lint slice", () => {
    // Measured against the runner: at caps of 0/1/2/3 an eleven-stage run performs 8/9/10/11
    // provider calls. The bound must sit at or above each, and must move with the cap.
    for (const [rounds, observed] of [[0, 8], [1, 9], [2, 10], [3, 11]] as const) {
      const bound = plannedPipelineCalls({ plan: P, feedbackRounds: rounds });
      expect(bound, `rounds=${rounds}`).toBeGreaterThanOrEqual(observed);
      expect(bound, `rounds=${rounds}`).toBe(9 + rounds);
    }
  });

  it("permits no rounds when the plan omits refine or lint", () => {
    // The same condition `decideGateFeedback` refuses on. A plan that cannot loop must not be
    // charged for looping, or every shallow run is over-budgeted into refusal.
    const noLint = P.filter((s) => s.id !== "lint");
    expect(plannedPipelineCalls({ plan: noLint, feedbackRounds: 3 }))
      .toBe(plannedPipelineCalls({ plan: noLint, feedbackRounds: 0 }));
  });

  it("multiplies by attempts, because a retry is another call", () => {
    expect(plannedPipelineCalls({ plan: P, maxAttempts: 3 })).toBe(27);
    // Floors at one: `maxAttempts: 0` would otherwise bound a real run at zero calls.
    expect(plannedPipelineCalls({ plan: P, maxAttempts: 0 })).toBe(9);
  });

  it("is an UPPER bound — the thing a budget needs", () => {
    // Stages skip (a clean critique skips `refine`), so a real run costs less. A bound that
    // sometimes sat below the truth would authorise a spend it did not cover, which is the
    // one direction that cannot be allowed to fail.
    expect(plannedPipelineCalls({ plan: P, feedbackRounds: 3, maxAttempts: 3 })).toBe(36);
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

  it("refuses `truncate_suite` too, because truncation is not implemented", () => {
    /**
     * This test asserted the opposite until 29 August 2026: `admit: true` with
     * `allowedCalls: 100`. The assertion was true of the function and false of the system.
     * `application/src/eval.ts` referenced `allowedCalls` ZERO times, so declaring
     * `on_exceed: "truncate_suite"` ran the WHOLE suite with the cap ignored — a budget that
     * reads as enforced and is not, which the schema description explicitly promises against
     * ("enforced BEFORE dispatch rather than observed after").
     *
     * Refusing is the conservative half of a choice this module's header says must never be
     * made silently, and it is reversible: honest truncation needs `EvalRun` to record that
     * it was truncated and over what, because an aggregate over whichever cases fit is a
     * score for a suite nobody defined. That is a contract change, and it lands first.
     */
    const a = admitRun({ budget: budget({ on_exceed: "truncate_suite" }), plannedCalls: 500 });
    expect(a.admit).toBe(false);
    expect(a.allowedCalls).toBe(0);
    expect(a.reason).toContain("truncation is not implemented");
    // The number is still reported, so the reason is actionable rather than merely negative.
    expect(a.reason).toContain("100 call(s) would fit");
  });

  it("a declared max_usd with no estimate is reported as UNENFORCED, not as within budget", () => {
    // The fail-open above stands. What changes is that it is no longer silent: the old reason
    // was "within budget (1 call(s))" for a run whose only declared cap was never examined.
    const a = admitRun({ budget: { on_exceed: "refuse", max_usd: 1 }, plannedCalls: 1 });
    expect(a.admit).toBe(true);
    expect(a.unenforced).toHaveLength(1);
    expect(a.unenforced[0]).toContain("max_usd");
    expect(a.reason).toContain("UNENFORCED");
  });

  it("does not report UNENFORCED when the cap WAS checked", () => {
    // The must-not-fire half. A field that always populated would carry no information.
    expect(admitRun({ budget: { on_exceed: "refuse", max_usd: 1 }, plannedCalls: 1, estimatedUsd: 0.5 }).unenforced).toEqual([]);
    expect(admitRun({ budget: budget(), plannedCalls: 1 }).unenforced).toEqual([]);
    expect(admitRun({ plannedCalls: 1 }).unenforced).toEqual([]);
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

  it("rejects a rate that would defeat the cap it is measured against", () => {
    /**
     * An unvalidated rate is a cap that reports itself satisfied. A negative rate makes `usd`
     * negative, so `exceeds` compares a negative number against a positive cap and returns
     * false — the more the run spends, the further under budget it looks. NaN is the same
     * failure by a different route: every comparison against it is false.
     */
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => assertValidRate({ in: bad, out: 15 }), `in=${bad}`).toThrow(/finite, non-negative/);
      expect(() => assertValidRate({ out: bad, in: 3 }), `out=${bad}`).toThrow(/finite, non-negative/);
      expect(() => accrue(emptyCost(), { prompt_tokens: 10 }, { in: bad, out: 15 })).toThrow();
    }
  });

  it("accepts the rates a price table actually contains", () => {
    // The must-not-fire half: zero is a real rate (a free tier), and so is a fractional one.
    for (const good of [0, 0.25, 3, 15, 75]) {
      expect(() => assertValidRate({ in: good, out: good })).not.toThrow();
    }
    expect(accrue(emptyCost(), { prompt_tokens: 1e6 }, { in: 3, out: 15 }).usd).toBeCloseTo(3, 10);
  });

  it("the negative rate really did defeat `exceeds` before the guard", () => {
    // The instrument check. Without this, the test above proves only that a throw happens,
    // not that anything was wrong — and eight of eleven sweeps here began with an instrument
    // that could not have failed.
    const spent = { ...emptyCost(), tokens_in: 1e6, tokens_out: 1e6, usd: -18 };
    expect(exceeds(spent, { on_exceed: "refuse", max_usd: 1 })).toBe(false);
    expect(exceeds({ ...spent, usd: 18 }, { on_exceed: "refuse", max_usd: 1 })).toBe(true);
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

/* ── perturbations ─────────────────────────────────────────────────────────── */

import {
  listPerturbations, getPerturbation, expandCase, expandCases, countClusters, clusterOf,
} from "../src/eval/perturbations.js";
import { clusteredPaired, type CaseOutcome } from "../src/eval/compare.js";

const baseCase = (id = "brief-1"): EvalCase => ({
  case_id: id,
  input: { brief: "A support assistant for a billing team that answers refund questions." },
  expectation: { kind: "none" },
  failure_mode: "constraint-violation",
  detector_ids: ["output-nonempty"],
});

const PRESERVING = listPerturbations().filter((p) => p.expectation_preserving).map((p) => p.id);

describe("perturbations", () => {
  it("are deterministic under a seed", () => {
    // No Math.random anywhere — the purity harness would fail the suite if there were, which
    // is precisely why these live in Core.
    const a = expandCase(baseCase(), { kinds: PRESERVING, seed: 42 });
    const b = expandCase(baseCase(), { kinds: PRESERVING, seed: 42 });
    expect(a).toEqual(b);
  });

  it("produce different variants under different seeds", () => {
    const a = expandCase(baseCase(), { kinds: ["typo"], seed: 1 })[1].input.brief;
    const b = expandCase(baseCase(), { kinds: ["typo"], seed: 999 })[1].input.brief;
    expect(a).not.toBe(b);
  });

  it("keep the base case first and unchanged", () => {
    // Expansion adds evidence; it never replaces it.
    const out = expandCase(baseCase(), { kinds: PRESERVING, seed: 7 });
    expect(out[0].case_id).toBe("brief-1");
    expect(out[0].input.brief).toBe(baseCase().input.brief);
  });

  it("actually change the brief", () => {
    // A perturbation that returns its input is a case counted twice, and would deflate every
    // cluster-level difference by adding a guaranteed tie.
    for (const p of listPerturbations()) {
      const [, variant] = expandCase(baseCase(), { kinds: [p.id], seed: 3 });
      expect(variant.input.brief, p.id).not.toBe(baseCase().input.brief);
    }
  });

  it("put expectation-preserving variants in their base case's cluster", () => {
    const out = expandCase(baseCase(), { kinds: PRESERVING, seed: 5 });
    expect(out.every((c) => clusterOf(c) === "brief-1")).toBe(true);
    expect(countClusters(out)).toBe(1);
  });

  it("give a non-preserving variant its own cluster", () => {
    // `truncate` asks a different question. Pooling it with the base would put two different
    // questions under one estimate — the exact error clustering exists to avoid, committed
    // while claiming to avoid it.
    const out = expandCase(baseCase(), { kinds: ["truncate"], seed: 5 });
    expect(countClusters(out)).toBe(2);
    expect(getPerturbation("truncate")!.expectation_preserving).toBe(false);
  });

  it("refuse an unknown perturbation rather than skipping it", () => {
    // A silent skip would report coverage the suite does not have.
    expect(() => expandCase(baseCase(), { kinds: ["nonexistent"], seed: 1 })).toThrow(/Unknown perturbation/);
  });

  it("record what produced each variant", () => {
    const [, variant] = expandCase(baseCase(), { kinds: ["homoglyph"], seed: 11 });
    expect(variant.perturbation).toEqual({ of_case_id: "brief-1", kind: "homoglyph", seed: 11 });
    expect(variant.case_id).toBe("brief-1::homoglyph");
  });

  it("substitute homoglyphs that read identically but are different code points", () => {
    const [, variant] = expandCase(baseCase(), { kinds: ["homoglyph"], seed: 2 });
    expect(variant.input.brief).not.toBe(baseCase().input.brief);
    // Same length: one code point swapped for one code point, so nothing about the text's
    // shape changes — only its bytes.
    expect([...variant.input.brief].length).toBe([...baseCase().input.brief].length);
  });

  it("counts independent units, not rows", () => {
    const cases = [baseCase("a"), baseCase("b"), baseCase("c")];
    const expanded = expandCases(cases, { kinds: PRESERVING, seed: 1 });
    expect(expanded).toHaveLength(3 * (1 + PRESERVING.length));
    expect(countClusters(expanded)).toBe(3);
  });
});

/* ── clustered significance ────────────────────────────────────────────────── */

/** Four briefs, five rows each: one base plus four preserving variants. Four clusters, 20 rows. */
/**
 * Briefs observed through five perturbation variants each.
 *
 * `regressedClusters` exists because a fixture in which every discordant cluster points the
 * same way cannot separate "significant" from "the most extreme result this design admits".
 * With d one-directional signs the exact p IS the design floor, 2 * 0.5^d — so a test built
 * that way asserts a number the fixture could not have failed to produce.
 */
function clusteredOutcomes(
  flippedClusters: number,
  totalClusters = 4,
  regressedClusters = 0,
): { candidate: CaseOutcome[]; baseline: CaseOutcome[] } {
  const candidate: CaseOutcome[] = [];
  const baseline: CaseOutcome[] = [];
  for (let cluster = 0; cluster < totalClusters; cluster++) {
    const improves = cluster < flippedClusters;
    const regresses = cluster >= flippedClusters && cluster < flippedClusters + regressedClusters;
    for (let v = 0; v < 5; v++) {
      const case_id = `brief-${cluster}::v${v}`;
      const cluster_id = `brief-${cluster}`;
      baseline.push({ case_id, cluster_id, passed: regresses });
      candidate.push({ case_id, cluster_id, passed: improves });
    }
  }
  return { candidate, baseline };
}

describe("clustered significance", () => {
  it("counts clusters, not rows", () => {
    const { candidate, baseline } = clusteredOutcomes(3);
    const r = clusteredPaired(candidate, baseline);
    expect(r.clusters).toBe(4);
    expect(r.discordant).toBe(3);
  });

  it("is strictly less significant than the naive test on the same data", () => {
    /**
     * Phase δ's falsifiable prediction, in the form this comparator supports.
     *
     * Three briefs improve, each observed through five perturbation variants. The naive test
     * sees fifteen one-directional discordant pairs and reports p ≈ 6e-5 — a decisive
     * result. The clustered test sees three improved questions out of four and reports
     * p = 0.25, which is not significant at any conventional level.
     *
     * Both numbers are computed from identical data. The first is wrong, and it is wrong in
     * the direction that manufactures a promotion.
     */
    const { candidate, baseline } = clusteredOutcomes(3);

    let b = 0, c = 0;
    const was = new Map(baseline.map((o) => [o.case_id, o.passed]));
    for (const o of candidate) {
      if (o.passed && !was.get(o.case_id)) b++;
      else if (!o.passed && was.get(o.case_id)) c++;
    }
    const naive = mcnemar(b, c);
    const clustered = clusteredPaired(candidate, baseline);

    expect(naive.discordant).toBe(15);
    expect(clustered.discordant).toBe(3);
    expect(clustered.p).toBeGreaterThan(naive.p);
    expect(naive.p).toBeLessThan(0.05);        // the naive test would promote this
    expect(clustered.p).toBeGreaterThan(0.05); // the honest one does not
  });

  it("aggregates every row in a cluster, not just the last one", () => {
    /**
     * A cluster whose rows DISAGREE, which the uniform fixture above cannot produce.
     *
     * A mutation that looked up slots by `case_id` while storing them by `cluster_id` — so
     * each cluster kept only its final row — survived the whole suite, because every row in
     * a cluster shared a pass value and the last row therefore spoke for all five. The
     * fixture could not detect what the assertion claimed to check. Third time a probe has
     * found that, and always the same cause: a fixture too uniform to discriminate.
     *
     * Here the candidate improves four rows of five and regresses the last. The cluster
     * genuinely improved (0.8 vs 0.0); reading only the final row would call it a tie.
     */
    const candidate: CaseOutcome[] = [];
    const baseline: CaseOutcome[] = [];
    for (let v = 0; v < 5; v++) {
      candidate.push({ case_id: `b::v${v}`, cluster_id: "b", passed: v < 4 });
      baseline.push({ case_id: `b::v${v}`, cluster_id: "b", passed: false });
    }

    const r = clusteredPaired(candidate, baseline);
    expect(r.clusters).toBe(1);
    expect(r.discordant).toBe(1);   // the cluster improved; last-row-only would say 0
  });

  it("agrees with the naive test when nothing is clustered", () => {
    // An unclustered suite must behave exactly as it did before clustering existed.
    const candidate: CaseOutcome[] = [
      { case_id: "a", passed: true }, { case_id: "b", passed: true }, { case_id: "c", passed: false },
    ];
    const baseline: CaseOutcome[] = [
      { case_id: "a", passed: false }, { case_id: "b", passed: false }, { case_id: "c", passed: false },
    ];
    expect(clusteredPaired(candidate, baseline).p).toBeCloseTo(mcnemar(2, 0).p, 12);
  });

  it("treats a tied cluster as contributing nothing, like a concordant pair", () => {
    const { candidate, baseline } = clusteredOutcomes(0);
    const r = clusteredPaired(candidate, baseline);
    expect(r.discordant).toBe(0);
    expect(r.p).toBe(1);
  });
});

/* ── the comparator refuses a protocol that does not match the data ─────────── */

describe("significance protocol is checked against the data's structure", () => {
  const recall: DetectorRecallBlock = {
    probe_corpus_version: "1.0.0",
    detectors: [{ detector_id: "output-nonempty", substrates: 4, probes_run: 4, probes_detected: 4, recall: 1 }],
  };

  /**
   * Eight briefs, six improved and two regressed, five variants each.
   *
   * Eight rather than four: the exact test needs six discordant units before ANY arrangement
   * clears 0.05, so a four-brief fixture is refused as unanswerable and the clustered path is
   * never reached. Six-and-two rather than six-and-zero for the reason in `clusteredOutcomes`.
   */
  const input = (protocol: "exact-mcnemar" | "clustered-paired" | "bootstrap-ci", clustered: boolean) => {
    const { candidate, baseline } = clusteredOutcomes(6, 8, 2);
    const strip = (rows: CaseOutcome[]) =>
      clustered ? rows : rows.map(({ case_id, passed }) => ({ case_id, passed }));
    return {
      comparison_id: "cmp-1",
      candidate_run_id: "run-c",
      baseline_id: "run-b",
      candidate: strip(candidate),
      baseline: strip(baseline),
      suite: { resolution: { detectable_delta: 0.01, confidence: 0.95 }, significance_protocol: protocol },
      comparisons_in_family: 1,
      alpha: 0.05,
      candidateRecall: recall,
      baselineRecall: recall,
      suiteDetectorIds: ["output-nonempty"],
    };
  };

  it("refuses exact-mcnemar on clustered data", () => {
    // A caveat beside a p-value gets the p-value quoted and the caveat dropped, so this
    // returns no number at all — the same shape as the recall-mismatch refusal it mirrors.
    const r = compare(input("exact-mcnemar", true));
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("independent cluster");
    expect(r.delta).toBeNull();
    expect(r.protocol.p_value).toBeNull();
  });

  it("accepts exact-mcnemar when the data really is unclustered", () => {
    const r = compare(input("exact-mcnemar", false));
    expect(r.verdict).not.toBe("refused");
    expect(r.protocol.test).toBe("mcnemar");
  });

  it("runs the clustered test when the suite declares it", () => {
    const r = compare(input("clustered-paired", true));
    expect(r.verdict).not.toBe("refused");
    expect(r.protocol.test).toBe("clustered-paired");
    // Eight independent questions behind the verdict, not forty rows.
    expect(r.protocol.effective_n).toBe(8);
    expect(r.protocol.discordant).toBe(8);
  });

  it("reaches the opposite verdict from the naive test on identical data", () => {
    /**
     * The whole point, end to end. Forty rows over eight briefs, six improved and two worse.
     *
     * Declared as unclustered, the comparator sees forty rows with thirty flips one way and
     * ten the other, and reports a decisive improvement. Declared honestly, it sees six
     * improved questions out of eight — p = 0.289 — and declines to call it. Same outcomes,
     * same code, opposite conclusions, and the second is the correct one.
     */
    const naive = compare(input("exact-mcnemar", false));
    const honest = compare(input("clustered-paired", true));
    expect(naive.verdict).toBe("improved");
    expect(honest.verdict).toBe("inconclusive");
  });

  it("refuses on CLUSTERS below the floor even when rows are far above it", () => {
    /**
     * The distinction the whole clustering argument rests on, at the level of the floor.
     *
     * Four briefs perturbed five ways is twenty rows and four questions. Twenty rows clears
     * the six-unit floor comfortably; four questions does not. Counting rows here would
     * restore exactly the anticonservatism clustering exists to remove — the design would be
     * declared capable on the strength of repeated looks at the same four questions.
     *
     * This is Phase δ's fixture, and its result is now sharper than Phase δ recorded. That
     * run reported p = 0.25 for the clustered analysis and called it inconclusive; 0.25 is
     * precisely `minAttainableP(3)`, the smallest value a three-discordant design can
     * produce. The comparator was reporting the floor of its own range as a measurement.
     */
    const { candidate, baseline } = clusteredOutcomes(3);
    const r = compare({
      comparison_id: "cmp-1", candidate_run_id: "run-c", baseline_id: "run-b",
      candidate, baseline,
      suite: { resolution: { detectable_delta: 0.01, confidence: 0.95 }, significance_protocol: "clustered-paired" },
      comparisons_in_family: 1, alpha: 0.05,
      candidateRecall: recall, baselineRecall: recall, suiteDetectorIds: ["output-nonempty"],
    });
    expect(candidate).toHaveLength(20);
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("4 independent unit(s)");
    expect(r.refusal_reason).toContain("at least 6");
  });

  it("refuses bootstrap-ci rather than silently substituting a binary test", () => {
    const r = compare(input("bootstrap-ci", false));
    expect(r.verdict).toBe("refused");
    expect(r.refusal_reason).toContain("not implemented");
  });
});
