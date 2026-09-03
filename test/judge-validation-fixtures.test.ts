import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

interface Fixture {
  id: string;
  brief: string;
  clean_compiled_prompt: string;
  mutations: {
    domain_captured: string;
    constraints_honored: string;
    completeness: string;
    no_overreach: string;
  };
}

const fixtures: Fixture[] = JSON.parse(readFileSync("eval/judge-validation-fixtures.json", "utf8"));

describe("judge-validation-fixtures.json", () => {
  it("has exactly 12 fixtures", () => {
    expect(fixtures).toHaveLength(12);
  });

  it("every fixture has a unique id", () => {
    const ids = new Set(fixtures.map((f) => f.id));
    expect(ids.size).toBe(12);
  });

  it("every fixture has non-empty brief, clean prompt, and all four mutations", () => {
    for (const f of fixtures) {
      expect(f.brief.length).toBeGreaterThan(0);
      expect(f.clean_compiled_prompt.length).toBeGreaterThan(0);
      for (const dim of ["domain_captured", "constraints_honored", "completeness", "no_overreach"] as const) {
        expect(f.mutations[dim].length).toBeGreaterThan(0);
        // A mutation must actually differ from the clean baseline — an accidental copy-paste
        // would silently produce a fixture that cannot isolate anything.
        expect(f.mutations[dim]).not.toBe(f.clean_compiled_prompt);
      }
    }
  });
});
