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
      expect({ id: c.id, verdict: runtimeKeyUndeclared(c.text).verdict })
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
