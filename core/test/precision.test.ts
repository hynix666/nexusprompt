import { describe, it, expect } from "vitest";
import { precisionInterval } from "../src/eval/precision.js";

/**
 * The exact (Clopper-Pearson) interval for a gate's precision.
 *
 * Exact, not normal-approximate: the counts this is built for run from 1 firing to 84, and a
 * Wald interval on 1 of 1 returns [1, 1] — a claim of certainty from a single observation.
 * The bounds below are the textbook values for the binomial proportion, which is what makes
 * this testable at all: the arithmetic has an answer nobody here gets to choose.
 */

const round = (x: number, places = 4) => Number(x.toFixed(places));

describe("precisionInterval", () => {
  it("matches the published bounds for 3 of 10 at 95%", () => {
    const i = precisionInterval(3, 10, 0.95)!;
    expect(round(i.point)).toBe(0.3);
    expect(round(i.lower)).toBe(0.0667);
    expect(round(i.upper)).toBe(0.6525);
  });

  it("gives a lower bound below 1 when every firing was a real defect", () => {
    // 10 of 10 is where a naive interval claims certainty. The upper bound is 1 because no
    // failure was seen; the lower bound is not, because ten observations cannot exclude 0.69.
    const i = precisionInterval(10, 10, 0.95)!;
    expect(i.upper).toBe(1);
    expect(round(i.lower)).toBe(0.6915);
  });

  it("gives an upper bound above 0 when no firing was a real defect", () => {
    const i = precisionInterval(0, 20, 0.95)!;
    expect(i.lower).toBe(0);
    expect(round(i.upper)).toBe(0.1684);
  });

  it("is useless at n = 1, and says so rather than claiming certainty", () => {
    // PLACEHOLDER_AUDIT fired exactly once in the corpus. Reporting 1.0 for it would be the
    // single most misleading number this phase could produce.
    const i = precisionInterval(1, 1, 0.95)!;
    expect(i.point).toBe(1);
    expect(round(i.lower)).toBe(0.025);
    expect(i.upper).toBe(1);
  });

  it("returns null when nothing fired, because there is no ratio to report", () => {
    // The "two zeros" discipline: a gate that never fired has no precision, which is not the
    // same as a precision of 0 or of 1.
    expect(precisionInterval(0, 0, 0.95)).toBeNull();
  });

  it("widens as the confidence level rises", () => {
    const at95 = precisionInterval(69, 84, 0.95)!;
    const at99 = precisionInterval(69, 84, 0.99)!;
    expect(at99.lower).toBeLessThan(at95.lower);
    expect(at99.upper).toBeGreaterThan(at95.upper);
  });

  it("brackets the point estimate, always", () => {
    for (const n of [1, 2, 3, 7, 19, 84, 124, 1000]) {
      for (const tp of [0, 1, Math.floor(n / 2), n - 1, n].filter((t) => t >= 0 && t <= n)) {
        const i = precisionInterval(tp, n, 0.95)!;
        expect(i.lower, `${tp}/${n}`).toBeLessThanOrEqual(i.point);
        expect(i.point, `${tp}/${n}`).toBeLessThanOrEqual(i.upper);
        expect(i.lower, `${tp}/${n}`).toBeGreaterThanOrEqual(0);
        expect(i.upper, `${tp}/${n}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is symmetric: the upper bound of tp mirrors the lower bound of n - tp", () => {
    // A property the arithmetic must satisfy whatever the implementation, so it catches a
    // bisection that converged on the wrong tail.
    for (const [tp, n] of [[3, 10], [17, 40], [69, 84]] as const) {
      const a = precisionInterval(tp, n, 0.95)!;
      const b = precisionInterval(n - tp, n, 0.95)!;
      expect(round(a.upper, 9)).toBe(round(1 - b.lower, 9));
    }
  });

  it("refuses a count that is not a proportion", () => {
    expect(() => precisionInterval(5, 3, 0.95)).toThrow(/tp/);
    expect(() => precisionInterval(-1, 3, 0.95)).toThrow(/tp/);
    expect(() => precisionInterval(1.5, 3, 0.95)).toThrow(/integer/);
    expect(() => precisionInterval(1, 3, 0)).toThrow(/confidence/);
    expect(() => precisionInterval(1, 3, 1)).toThrow(/confidence/);
  });
});
