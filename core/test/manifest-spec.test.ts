import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runtimeKeyUndeclared } from "../src/gates/placeholder-audit.js";

interface SpecCase {
  id: string;
  group: string;
  status: "spec" | "known-limit";
  text: string;
  options?: { includeFences?: boolean };
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
  it("contains unique, well-formed cases", () => {
    expect(spec.cases.length).toBeGreaterThan(25);
    expect(new Set(spec.cases.map((c) => c.id)).size).toBe(spec.cases.length);
    for (const c of spec.cases) {
      expect(c.id && c.group && c.text && c.expect && c.why).toBeTruthy();
      expect(["spec", "known-limit"]).toContain(c.status);
    }
  });

  it.each(spec.cases.map((c) => [c.id, c] as const))(
    "%s",
    (_id, c) => {
      expect({ id: c.id, verdict: runtimeKeyUndeclared(c.text, c.options).verdict })
        .toEqual({ id: c.id, verdict: c.expect });
    },
  );

  const limits = spec.cases.filter((c) => c.status === "known-limit");
  it.each(limits.map((c) => [c.id, c] as const))(
    "known limit %s is still a limit",
    (_id, c) => {
      expect(c.wanted).toBeDefined();
      expect(c.wanted).not.toBe(c.expect);
      expect(runtimeKeyUndeclared(c.text).verdict).not.toBe(c.wanted);
    },
  );

  it("applies options to the cases that declare them", () => {
    for (const c of spec.cases.filter((c) => c.options)) {
      const withOptions = runtimeKeyUndeclared(c.text, c.options).verdict;
      expect(withOptions).toBe(c.expect);
      if (c.options_invariant) {
        expect(runtimeKeyUndeclared(c.text).verdict).toBe(c.expect);
      }
    }
  });

  it("keeps the known-limit contract honest", () => {
    const unsafe = limits.filter((c) => c.wanted === "FAIL");
    expect(unsafe.map((c) => c.id)).toEqual(["limit-fenced-warning-block"]);
    for (const c of limits) {
      expect(c.wanted).toBeDefined();
      expect(c.wanted).not.toBe(c.expect);
      expect(runtimeKeyUndeclared(c.text).verdict).not.toBe(c.wanted);
    }
  });
});
