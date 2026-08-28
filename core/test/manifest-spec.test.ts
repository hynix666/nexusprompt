import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runtimeKeyUndeclared } from "../src/gates/placeholder-audit.js";

/**
 * `spec/manifest-shapes.json`, executed.
 *
 * The manifest rule was stated in four places — the code, its comments, ADR-0010, and the
 * tests — and drifted between them twice in two days. ADR-0010 was amended twice; a test had
 * to be reconciled after it contradicted the ADR it cited. This file is what makes that
 * impossible: the spec is the test, so a row cannot be true in the documentation and false in
 * the suite.
 *
 * `npm run docs:manifest-spec` renders the same file into `Documentation/MANIFEST_SHAPES.md`,
 * and `check:manifest-spec` fails when the committed document is not what the spec produces.
 * Three artifacts, one source.
 *
 * If you are here because a case failed: decide which is wrong, the spec or the gate. Do not
 * edit the expectation to match observed behaviour without deciding — that is how the four
 * places disagreed in the first place.
 */

interface SpecCase {
  id: string;
  group: string;
  status: "spec" | "known-limit";
  text: string;
  /** Gate options. A case that varies one MUST be run with it — see the assertion below. */
  options?: Record<string, unknown>;
  /**
   * Set when the row exists to assert the option changes NOTHING here.
   *
   * Without this, "the option must change the verdict" would be the only allowed intent, and
   * an invariance claim — `includeFences` must not make a fenced heading declare — could not
   * be expressed. Declaring the intent beats inferring it: the assertion then checks the
   * claim the author actually made.
   */
  options_invariant?: boolean;
  expect: "PASS" | "FAIL" | "WARN";
  wanted?: string;
  why: string;
}

const spec = JSON.parse(readFileSync("spec/manifest-shapes.json", "utf8")) as {
  gate: string;
  cases: SpecCase[];
};

describe("spec/manifest-shapes.json — the manifest rule, executed", () => {
  it("is not empty, and every case is well formed", () => {
    // A spec file that failed to load would make every `it.each` below vacuous — the suite
    // would be green because it ran nothing. Guard the guard.
    expect(spec.cases.length).toBeGreaterThan(25);
    for (const c of spec.cases) {
      expect({ id: c.id, ok: Boolean(c.id && c.group && c.text && c.expect && c.why) })
        .toEqual({ id: c.id, ok: true });
      expect(["spec", "known-limit"]).toContain(c.status);
    }
    expect(new Set(spec.cases.map((c) => c.id)).size).toBe(spec.cases.length);
  });

  it.each(spec.cases.map((c) => [c.id, c] as const))(
    "%s",
    (_id, c) => {
      expect({ id: c.id, verdict: runtimeKeyUndeclared(c.text, (c.options ?? {}) as never).verdict })
        .toEqual({ id: c.id, verdict: c.expect });
    },
  );

  /**
   * A known limit must actually still be one.
   *
   * `wanted` records the verdict we would prefer. If the gate starts producing it, the entry
   * is stale and must be promoted to `spec` — the same staleness rule the divergence allowlist
   * and counted-claims use. Without this, a fixed limit would sit in the file forever
   * describing a defect that no longer exists, and the next reader would believe it.
   */
  const limits = spec.cases.filter((c) => c.status === "known-limit");
  it.each(limits.map((c) => [c.id, c] as const))(
    "known limit %s is still a limit",
    (_id, c) => {
      expect(c.wanted).toBeDefined();
      expect(c.wanted).not.toBe(c.expect);
      expect(runtimeKeyUndeclared(c.text).verdict).not.toBe(c.wanted);
    },
  );

  it("actually applies each case's options", () => {
    /**
     * The runner ignored `options` until 2026-08-28, so a row varying one ran with defaults
     * and its recorded verdict was right or wrong by luck. Three `includeFences` rows were
     * added before anyone noticed — a row the suite silently ignores is worse than no row,
     * because the documentation renders it as covered.
     *
     * This asserts the option is load-bearing: every options-carrying case must produce a
     * DIFFERENT verdict without its options. If it does not, the row is not testing the option
     * and should either be given a discriminating fixture or lose the options field.
     */
    const withOptions = spec.cases.filter((c) => c.options && Object.keys(c.options).length > 0);
    expect(withOptions.length).toBeGreaterThan(0);
    for (const c of withOptions) {
      const withOpts = runtimeKeyUndeclared(c.text, c.options as never).verdict;
      const without = runtimeKeyUndeclared(c.text).verdict;
      expect({ id: c.id, withOpts }).toEqual({ id: c.id, withOpts: c.expect });

      if (c.options_invariant) {
        // The row claims the option changes nothing. Assert exactly that, so the claim is
        // checked rather than merely stated.
        expect({ id: c.id, withOpts, without }).toEqual({ id: c.id, withOpts: c.expect, without: c.expect });
      } else if (withOpts === without) {
        throw new Error(
          `${c.id} carries options ${JSON.stringify(c.options)} but produces ${withOpts} either ` +
          `way. Either the row does not test what it claims, or it is an invariance claim and ` +
          `should set options_invariant: true.`,
        );
      }
    }
  });

  it("records at most one known limit in the unsafe direction", () => {
    /**
     * A limit whose `wanted` is FAIL is a false clean we are knowingly carrying — the one
     * category ADR-0010 exists to eliminate. There is currently one (a fenced warning block
     * under a real manifest), it is inherited rather than introduced, and fixing it collides
     * with fenced entries declaring at all.
     *
     * This asserts the count does not grow quietly. A second one is not a row to add; it is a
     * decision that needs an ADR.
     */
    const unsafe = limits.filter((c) => c.wanted === "FAIL");
    expect(unsafe.map((c) => c.id)).toEqual(["limit-fenced-warning-block"]);
  });
});
