import { describe, it, expect } from "vitest";
import { compare, mcnemar } from "../src/eval/compare.js";
import { floorDiscordant, minAttainableP } from "../src/eval/sizing.js";

/**
 * The comparator's refusal discipline, as properties rather than examples.
 *
 * `core/test/eval.test.ts` already exercises the comparator by example. This file asserts the
 * things that must hold for EVERY shape of input, because the failure they guard against is
 * the most expensive one available here and the least visible: a gate that mis-parses a fence
 * produces a verdict somebody can check by reading the prompt, while a comparator that reports
 * `improved` on evidence that cannot support it produces a NUMBER — and numbers get quoted.
 *
 * README, first paragraph: this system "helps you find out whether a change to one made
 * anything better — and refuses to answer when it cannot tell." That refusal is the product.
 *
 * ## The distinction this file exists to protect
 *
 * `refused` and `inconclusive` are different findings and must never collapse:
 *
 *   refused        the SUITE could not have separated the two configurations, whatever the
 *                  data. A statement about the instrument.
 *   inconclusive   the suite could have, and did not. A statement about the configurations.
 *
 * The floor is a property of the suite's SIZE, not of the discordance a particular run
 * happened to produce. An adversarial sweep initially conflated the two and reported thirteen
 * violations against correct code — the property was wrong, not the comparator. Both sides of
 * the line are pinned below so the next reader inherits the distinction rather than the
 * confusion.
 */

const FLOOR = floorDiscordant(0.05);

const recall = (ids: readonly string[]) => ({
  probe_corpus_version: "1.0.0",
  detectors: ids.map((detector_id) => ({
    detector_id, substrates: 100, probes_run: 100, probes_detected: 100, recall: 1,
  })),
});

const DETECTORS = ["d1"] as const;

/** `b` cases the baseline won, `c` the candidate won, `both` concordant. Discordant = b + c. */
const paired = (b: number, c: number, both: number) => {
  const baseline: Array<{ case_id: string; passed: boolean }> = [];
  const candidate: Array<{ case_id: string; passed: boolean }> = [];
  let n = 0;
  for (let i = 0; i < b; i++, n++) { baseline.push({ case_id: `k${n}`, passed: true }); candidate.push({ case_id: `k${n}`, passed: false }); }
  for (let i = 0; i < c; i++, n++) { baseline.push({ case_id: `k${n}`, passed: false }); candidate.push({ case_id: `k${n}`, passed: true }); }
  for (let i = 0; i < both; i++, n++) { baseline.push({ case_id: `k${n}`, passed: true }); candidate.push({ case_id: `k${n}`, passed: true }); }
  return { baseline, candidate, n };
};

const run = (over: Record<string, unknown> = {}) => {
  const pairs = (over.pairs as ReturnType<typeof paired>) ?? paired(0, 8, 10);
  const { pairs: _drop, ...rest } = over;
  return compare({
    comparison_id: "cmp-1",
    candidate_run_id: "run-cand",
    baseline_id: "base-1",
    candidate: pairs.candidate,
    baseline: pairs.baseline,
    suite: {
      resolution: { detectable_delta: 1 / Math.max(pairs.n, 1), confidence: 0.95, sized_for: pairs.n },
      significance_protocol: { test: "mcnemar", alpha: 0.05 },
    },
    comparisons_in_family: 1,
    alpha: 0.05,
    candidateRecall: recall(DETECTORS),
    baselineRecall: recall(DETECTORS),
    suiteDetectorIds: DETECTORS,
    ...rest,
  } as never);
};

describe("comparator — the floor is a property of the suite, not of the run", () => {
  it.each(Array.from({ length: FLOOR - 1 }, (_, i) => [i + 1] as const))(
    "a suite of %i cluster(s) refuses: it could never attain significance",
    (clusters) => {
      // Every case discordant, so the run is not the limiting factor — only the suite's size.
      const r = run({ pairs: paired(0, clusters, 0) });
      expect({ clusters, verdict: r.verdict }).toEqual({ clusters, verdict: "refused" });
    },
  );

  it.each(Array.from({ length: FLOOR - 1 }, (_, i) => [i + 1] as const))(
    "a LARGE suite producing only %i discordant unit(s) is inconclusive, not refused",
    (discordant) => {
      // The other side of the same line. The suite could have separated them; this run did
      // not. Calling that a refusal would credit the suite with a weakness it does not have.
      const r = run({ pairs: paired(0, discordant, 20) });
      expect({ discordant, verdict: r.verdict }).toEqual({ discordant, verdict: "inconclusive" });
      // And it must SAY which of the two it is.
      expect(r.refusal_reason ?? "").toMatch(/attainable|suite/i);
    },
  );

  it("agrees with the closed form the floor rests on", () => {
    // Under McNemar the statistic is binomial(d, 0.5), so the smallest two-sided p any
    // arrangement of d discordant units can produce is 2·0.5^d.
    for (let d = 1; d <= 10; d++) {
      // Compared with a tolerance, not exactly: the implementation sums binomial terms while
      // the closed form is a single power, so they agree to floating-point precision rather
      // than bit for bit. mcnemar(0,3) gives 0.25000000000000006 against a closed 0.25.
      expect(mcnemar(0, d).p).toBeCloseTo(Math.min(1, 2 * Math.pow(0.5, d)), 12);
    }
    // Which is exactly why the floor sits where it does.
    expect(minAttainableP(FLOOR) <= 0.05).toBe(true);
    expect(minAttainableP(FLOOR - 1) > 0.05).toBe(true);
  });
});

describe("comparator — identical arms", () => {
  it("in a large suite is inconclusive, and says the runs agreed", () => {
    const r = run({ pairs: paired(0, 0, 40) });
    expect(r.verdict).toBe("inconclusive");
    expect(r.refusal_reason ?? "").toMatch(/agree/i);
  });

  it("in a suite below the floor is refused", () => {
    const r = run({ pairs: paired(0, 0, 3) });
    expect(r.verdict).toBe("refused");
  });
});

describe("comparator — the instrument is checked before the measurement", () => {
  it.each([
    ["candidate recall null", { candidateRecall: null }],
    ["baseline recall null", { baselineRecall: null }],
    ["candidate recall undefined", { candidateRecall: undefined }],
  ] as const)("%s refuses and carries no delta", (_label, over) => {
    // Reporting a delta and then noting the detectors were unequal gets the delta quoted and
    // the note dropped. A refusal must carry no number at all.
    const r = run({ ...over, pairs: paired(0, 12, 12) });
    expect(r.verdict).toBe("refused");
    expect(r.delta).toBeNull();
  });
});

describe("comparator — multiplicity correction raises the bar", () => {
  it("lowers the corrected alpha as the family grows", () => {
    const pairs = paired(0, FLOOR + 6, 12);
    const alone = run({ pairs, comparisons_in_family: 1 });
    const family = run({ pairs, comparisons_in_family: 20, correction: "bonferroni" });
    expect(family.protocol.alpha).toBeLessThan(alone.protocol.alpha);
  });

  it("can turn a significant result into one that is not", () => {
    // The point of correcting: a comparison that cleared alone must be able to stop clearing
    // in a family. If this ever fails, correction is decorative.
    const pairs = paired(0, FLOOR + 2, 12);
    const alone = run({ pairs, comparisons_in_family: 1 });
    const family = run({ pairs, comparisons_in_family: 1000, correction: "bonferroni" });
    if (alone.verdict === "improved" || alone.verdict === "regressed") {
      expect(["inconclusive", "refused"]).toContain(family.verdict);
    }
  });
});

describe("comparator — no free significance", () => {
  const shapes = [FLOOR, FLOOR + 4, FLOOR + 10, 30].flatMap((d) =>
    [1, 5, 50].map((family) => [d, family] as const),
  );

  it.each(shapes)("d=%i family=%i never calls a result significant without the p-value", (d, family) => {
    const r = run({
      pairs: paired(0, d, 20),
      comparisons_in_family: family,
      correction: family > 1 ? "bonferroni" : "none",
    });
    if (r.verdict === "improved" || r.verdict === "regressed") {
      expect(r.protocol.p_value).not.toBeNull();
      expect(r.protocol.p_value! <= r.protocol.alpha).toBe(true);
      expect(r.delta).not.toBeNull();
      expect(r.verdict === "improved" ? r.delta! > 0 : r.delta! < 0).toBe(true);
    }
  });
});

describe("comparator — swapping the arms inverts the result and nothing else", () => {
  it("negates delta, flips the label, and leaves the p-value alone", () => {
    // An asymmetry here would mean the verdict depends on argument order, which is the kind
    // of defect that survives every example-based test because examples pick an order.
    const fwd = paired(0, FLOOR + 6, 20);
    const forward = run({ pairs: fwd });
    const reverse = run({ pairs: { baseline: fwd.candidate, candidate: fwd.baseline, n: fwd.n } });

    expect(reverse.delta).toBeCloseTo(-(forward.delta ?? 0), 12);
    expect(reverse.protocol.p_value).toBe(forward.protocol.p_value);
    const flipped: Record<string, string> = { improved: "regressed", regressed: "improved" };
    expect(reverse.verdict).toBe(flipped[forward.verdict] ?? forward.verdict);
  });
});

describe("comparator — totality", () => {
  it.each([
    ["empty both sides", { pairs: { baseline: [], candidate: [], n: 0 } }],
    ["empty candidate", { pairs: { baseline: [{ case_id: "a", passed: true }], candidate: [], n: 1 } }],
    ["mismatched case ids", { pairs: { baseline: [{ case_id: "a", passed: true }], candidate: [{ case_id: "z", passed: false }], n: 1 } }],
    ["alpha zero", { alpha: 0 }],
    ["alpha one", { alpha: 1 }],
    ["family size zero", { comparisons_in_family: 0 }],
    ["no suite detectors", { suiteDetectorIds: [] }],
  ] as const)("%s returns a verdict rather than throwing", (_label, over) => {
    const r = run(over as Record<string, unknown>);
    expect(["refused", "inconclusive", "improved", "regressed"]).toContain(r.verdict);
  });
});
