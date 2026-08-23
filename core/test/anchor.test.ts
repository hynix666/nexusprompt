import { describe, it, expect } from "vitest";
import {
  AnchorCorpusExhausted, buildAnchorCorpus, caught, discordanceRate, firingGates,
  FULL_GATE_SET, scoreGateSet, withoutGate, type GateSet,
} from "../src/eval/anchor.js";
import { runGate } from "../src/gates/registry.js";

/**
 * The anchor's whole claim is that nothing about its outcomes is authored. These tests are
 * mostly about that: the corpus is reproducible from a seed, and the ground truth is derived
 * by asking the registry rather than by a label someone wrote.
 */

const small = () => buildAnchorCorpus({ seed: 7, count: 60 });
const fires = (v: string) => v === "FAIL" || v === "WARN";

describe("the corpus is reproducible", () => {
  it("gives byte-identical cases for the same seed", () => {
    // Without this, a reported anchor result cannot be reproduced, and an anchor nobody can
    // re-run is a number rather than evidence.
    expect(buildAnchorCorpus({ seed: 7, count: 40 })).toEqual(buildAnchorCorpus({ seed: 7, count: 40 }));
  });

  it("gives different cases for a different seed", () => {
    // The must-not-fire half: if seeds did not matter, the reproducibility above would be
    // trivially true and would prove nothing.
    const a = buildAnchorCorpus({ seed: 7, count: 40 });
    const b = buildAnchorCorpus({ seed: 8, count: 40 });
    expect(a.map((c) => c.text)).not.toEqual(b.map((c) => c.text));
  });

  it("keeps the RNG advancing across rejected candidates", () => {
    /**
     * Rejections are common — most draws trip zero or several gates. If the generator reset
     * its stream on rejection it would redraw the same rejected candidate forever. Asking for
     * more cases than a reset loop could ever produce is what catches that.
     */
    const c = buildAnchorCorpus({ seed: 3, count: 120 });
    expect(c).toHaveLength(120);
    expect(new Set(c.map((k) => k.text)).size).toBeGreaterThan(100);
  });
});

describe("ground truth is derived, not declared", () => {
  it("plants exactly one gate per case, and that gate really fires", () => {
    for (const k of small()) {
      expect(fires(runGate(k.planted_gate, k.text, k.options).verdict), k.case_id).toBe(true);
    }
  });

  it("names a gate that was SILENT before the injection", () => {
    /**
     * The half that makes the label mean something. A gate already firing on the base text
     * would be recorded as "planted" while detecting nothing new, and every set containing it
     * would score a free hit.
     */
    for (const k of small()) {
      expect(firingGates(k.base_text, k.options).has(k.planted_gate), k.case_id).toBe(false);
    }
  });

  it("names the ONLY gate that newly fires, never one of several", () => {
    /**
     * Re-derives the construction rule from the stored base text rather than trusting the
     * label. Two probes survived without this: one kept cases where several gates newly
     * fired, the other took the planted gate from the base text instead of the injection.
     * Both left a label that still pointed at a firing gate, which was all the old assertions
     * could see.
     *
     * It matters because "did this set catch the defect" has one answer only when there is
     * one defect. With three gates newly firing, a set can score a hit for catching something
     * other than the planted one.
     */
    for (const k of small()) {
      const before = firingGates(k.base_text, k.options);
      const added = [...firingGates(k.text, k.options)].filter((id) => !before.has(id));
      expect(added, k.case_id).toEqual([k.planted_gate]);
    }
  });

  it("draws planted gates from several gates, not one", () => {
    // A corpus where every case plants the same gate would compare two sets on one behaviour
    // and report it as coverage. This is the fixture-too-uniform failure, pre-empted.
    const planted = new Set(buildAnchorCorpus({ seed: 1, count: 200 }).map((k) => k.planted_gate));
    expect(planted.size).toBeGreaterThanOrEqual(5);
  });

  it("refuses to invent cases when the generator stops producing them", () => {
    // Must-fire: a corpus that quietly comes back short would silently shrink the anchor,
    // and a smaller anchor resolves a larger delta than the one it declares.
    expect(() => buildAnchorCorpus({ seed: 1, count: 50, maxDraws: 5 }))
      .toThrow(AnchorCorpusExhausted);
  });
});

describe("scoring a gate set", () => {
  it("counts a catch when any gate in the set fires", () => {
    const corpus = small();
    const full = FULL_GATE_SET();
    // Every case contains a defect the full registry detects — that is how it was accepted.
    expect(scoreGateSet(corpus, full).every((o) => o.passed)).toBe(true);
  });

  it("misses when the set contains no gate that fires", () => {
    // The must-not-fire half. An empty set cannot catch anything; if it did, `caught` would
    // be reading something other than the gates.
    const empty: GateSet = { gate_set_ref: "empty", gate_ids: [] };
    expect(scoreGateSet(small(), empty).some((o) => o.passed)).toBe(false);
  });

  it("returns outcomes in corpus order, so the comparator can pair them", () => {
    const corpus = small();
    expect(scoreGateSet(corpus, FULL_GATE_SET()).map((o) => o.case_id))
      .toEqual(corpus.map((k) => k.case_id));
  });
});

describe("discordance", () => {
  it("is zero between a set and itself", () => {
    const full = FULL_GATE_SET();
    expect(discordanceRate(small(), full, full).discordant).toBe(0);
  });

  it("is one-directional for nested sets, which is why the anchor does not use them", () => {
    /**
     * A subset can never catch more than its superset, so every discordant case points the
     * same way and the null "no difference" is known false before any case is scored. The
     * shipped anchor compares two sets that partition the registry for exactly this reason.
     */
    const corpus = buildAnchorCorpus({ seed: 1, count: 400 });
    const full = FULL_GATE_SET();
    const less = withoutGate("CLAIM_DISCIPLINE");
    for (const k of corpus) {
      // Never: subset caught it and the full set did not.
      expect(caught(k, less) && !caught(k, full)).toBe(false);
    }
  });

  it("refuses an unknown gate rather than silently returning the full set", () => {
    expect(() => withoutGate("NO_SUCH_GATE")).toThrow(/Unknown gate/);
  });
});
