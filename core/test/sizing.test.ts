import { describe, it, expect } from "vitest";
import {
  LEGACY_ASSUMPTIONS, STATED_ASSUMPTIONS, attainable, floorDiscordant, legacyAnchorSize,
  minAttainableP, requiredPairedSize, resolvableDelta,
} from "../src/eval/sizing.js";

/**
 * The sizing rule, and the three assumptions the old one made silently.
 *
 * `n ≳ z²/(2Δ²)` had been quoted in three documents and a schema description as "the sizing
 * rule". It is the conditional McNemar rule with a one-sided z used to size a two-sided test,
 * power pinned at 50%, and the discordance rate pinned at 50% — each optimistic, none stated.
 */

describe("the exact significance floor", () => {
  it("is six discordant units at alpha 0.05", () => {
    /**
     * `eval/compile-smoke.json` has said since it was written that "resolving a difference
     * takes six flips, not one". This is that sentence as an assertion. Under McNemar the
     * statistic is binomial(d, 0.5), so the smallest two-sided p any arrangement reaches is
     * 2 · 0.5^d.
     */
    expect(floorDiscordant(0.05)).toBe(6);
  });

  it("brackets the boundary from both sides", () => {
    // Five bottoms out ABOVE alpha and six lands below it. Asserting only one side would
    // pass for any floor at or beyond the true one.
    expect(minAttainableP(5)).toBeCloseTo(0.0625, 10);
    expect(minAttainableP(5)).toBeGreaterThan(0.05);
    expect(minAttainableP(6)).toBeCloseTo(0.03125, 10);
    expect(minAttainableP(6)).toBeLessThanOrEqual(0.05);
  });

  it("rises as multiplicity correction shrinks alpha", () => {
    // A family of 100 at nominal 0.05 corrects to 0.0005, which needs twelve — more than
    // an eleven-case suite can supply, so correction can move the bar out of reach.
    expect(floorDiscordant(0.05 / 100)).toBe(12);
    expect(floorDiscordant(0.01)).toBe(8);
  });

  it("treats total agreement as no evidence, never as a perfect result", () => {
    // Zero discordant units cannot reject. p = 1, and agreement is not evidence of
    // equivalence — a suite both runs pass completely has measured nothing about either.
    expect(minAttainableP(0)).toBe(1);
    expect(attainable(0, 0.05)).toBe(false);
  });

  it("returns Infinity rather than a small number for a nonsensical alpha", () => {
    expect(floorDiscordant(0)).toBe(Infinity);
    expect(floorDiscordant(-1)).toBe(Infinity);
  });
});

describe("the general sizing rule", () => {
  it("needs more items at higher power", () => {
    const at50 = requiredPairedSize(0.02, { alpha: 0.05, power: 0.5, discordanceRate: 0.5 });
    const at80 = requiredPairedSize(0.02, { alpha: 0.05, power: 0.8, discordanceRate: 0.5 });
    // The old rule has no power term at all, which is to say it sizes for 50%: a suite that
    // misses a real effect of exactly the size it was built for, half the time.
    expect(at80).toBeGreaterThan(at50);
    expect(at80 / at50).toBeCloseTo(2.04, 1);
  });

  it("needs fewer items when the two configurations disagree more often", () => {
    // Only discordant pairs carry information, so the informative sample is n · p_d.
    const rare = requiredPairedSize(0.02, { ...STATED_ASSUMPTIONS, discordanceRate: 0.1 });
    const common = requiredPairedSize(0.02, { ...STATED_ASSUMPTIONS, discordanceRate: 0.5 });
    expect(rare).toBeLessThan(common);
    expect(common / rare).toBeCloseTo(5, 1);
  });

  it("grows quadratically as the target delta halves", () => {
    const two = requiredPairedSize(0.02, STATED_ASSUMPTIONS);
    const one = requiredPairedSize(0.01, STATED_ASSUMPTIONS);
    expect(one / two).toBeCloseTo(4, 1);
  });

  it("refuses a zero discordance rate rather than dividing by it", () => {
    // No sample size makes a test informative when the two configurations never disagree.
    expect(() => requiredPairedSize(0.02, { ...STATED_ASSUMPTIONS, discordanceRate: 0 })).toThrow(/discordanceRate/);
    expect(() => requiredPairedSize(0, STATED_ASSUMPTIONS)).toThrow(/positive delta/);
  });

  it("inverts: resolvableDelta undoes requiredPairedSize", () => {
    const n = requiredPairedSize(0.05, STATED_ASSUMPTIONS);
    expect(resolvableDelta(n, STATED_ASSUMPTIONS)).toBeCloseTo(0.05, 3);
  });

  it("reproduces a published benchmark's reported resolution", () => {
    /**
     * An external cross-check, because a formula that only agrees with itself is not
     * evidence. τ²-bench reports its 114 paired tasks as resolving roughly 15 percentage
     * points. At a discordance rate near a third — plausible for two agents on one task set
     * — this rule lands on that count. The OLD rule returns 61 for the same target.
     */
    const n = requiredPairedSize(0.15, { alpha: 0.05, power: 0.8, discordanceRate: 0.327 });
    expect(n).toBeGreaterThan(105);
    expect(n).toBeLessThan(125);
    expect(legacyAnchorSize(0.15)).toBeLessThan(70);
  });
});

describe("the legacy rule, with its assumptions named", () => {
  it("returns the ≈3,400 figure three documents quote", () => {
    expect(legacyAnchorSize(0.02)).toBe(3382);
  });

  it("is exactly the general rule at a one-sided 0.05, 50% power, and 50% discordance", () => {
    /**
     * Pinned so the two cannot drift apart. A one-sided 0.05 is a two-sided 0.10, which is
     * the substitution that makes the old figure smaller than the test it sizes actually
     * requires — the comparator runs `exactTwoSided`.
     */
    const general = requiredPairedSize(0.02, { alpha: 0.10, power: 0.5, discordanceRate: 0.5 });
    expect(Math.abs(general - legacyAnchorSize(0.02))).toBeLessThanOrEqual(1);
    expect(LEGACY_ASSUMPTIONS.power).toBe(0.5);
    expect(LEGACY_ASSUMPTIONS.discordanceRate).toBe(0.5);
  });

  it("is materially smaller than the honestly-powered figure", () => {
    // 2.9x, and each factor is one assumption the old rule did not write down.
    const honest = requiredPairedSize(0.02, STATED_ASSUMPTIONS);
    expect(honest).toBe(9812);
    expect(honest / legacyAnchorSize(0.02)).toBeGreaterThan(2.5);
  });
});

describe("what the suites in this repository actually resolve", () => {
  it("puts the fourteen-case smoke suite above fifty percentage points", () => {
    /**
     * It declares `detectable_delta: 0.0714`, which is 1/14 — its score granularity, and
     * what the field means as of eval-suite 2.0.1. Read as a statistical resolution, which
     * is what the 2.0.0 schema description said it was, that figure is out by 7x.
     */
    const delta = resolvableDelta(14, STATED_ASSUMPTIONS);
    expect(delta).toBeGreaterThan(0.5);
    expect(delta).toBeLessThan(0.55);
  });

  it("puts a five-case suite near ninety, and below the floor entirely", () => {
    expect(resolvableDelta(5, STATED_ASSUMPTIONS)).toBeGreaterThan(0.85);
    expect(5).toBeLessThan(floorDiscordant(0.05));
  });
});
