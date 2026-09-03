import { describe, it, expect } from "vitest";
import { RUBRIC_DIMENSIONS, BRIEF_FIDELITY_RUBRIC_TEMPLATE, BRIEF_FIDELITY_CONTRACT_CHANGED_AT, buildFidelityCandidate } from "../src/eval/brief-fidelity.js";

describe("BRIEF_FIDELITY_CONTRACT_CHANGED_AT", () => {
  it("is a valid ISO timestamp", () => {
    expect(Number.isFinite(Date.parse(BRIEF_FIDELITY_CONTRACT_CHANGED_AT))).toBe(true);
  });
});

describe("RUBRIC_DIMENSIONS", () => {
  it("names exactly the four dimensions the design spec pins", () => {
    expect(RUBRIC_DIMENSIONS).toEqual([
      "domain_captured", "constraints_honored", "completeness", "no_overreach",
    ]);
  });
});

describe("BRIEF_FIDELITY_RUBRIC_TEMPLATE", () => {
  it("names all four dimensions and their 0-3 scale", () => {
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(BRIEF_FIDELITY_RUBRIC_TEMPLATE).toContain(dim);
    }
    expect(BRIEF_FIDELITY_RUBRIC_TEMPLATE).toContain("0");
    expect(BRIEF_FIDELITY_RUBRIC_TEMPLATE).toContain("3");
  });

  it("asks for JSON output, not free text", () => {
    expect(BRIEF_FIDELITY_RUBRIC_TEMPLATE.toLowerCase()).toContain("json");
  });
});

describe("buildFidelityCandidate", () => {
  it("labels the brief and the compiled prompt distinctly", () => {
    const out = buildFidelityCandidate("Write a billing assistant.", "# SYSTEM PROMPT\nScope: billing.");
    expect(out).toContain("ORIGINAL BRIEF");
    expect(out).toContain("COMPILED PROMPT");
    expect(out).toContain("Write a billing assistant.");
    expect(out).toContain("# SYSTEM PROMPT\nScope: billing.");
  });

  it("is deterministic for identical inputs", () => {
    const a = buildFidelityCandidate("brief text", "prompt text");
    const b = buildFidelityCandidate("brief text", "prompt text");
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", () => {
    const a = buildFidelityCandidate("brief one", "prompt");
    const b = buildFidelityCandidate("brief two", "prompt");
    expect(a).not.toBe(b);
  });

  it("keeps the brief and compiled prompt sections separated even when one contains the other's label text", () => {
    // A brief that itself contains the literal words "COMPILED PROMPT" must not be able to
    // make the judge misread where the brief ends and the compiled prompt begins.
    const out = buildFidelityCandidate("Please mention COMPILED PROMPT nowhere.", "actual output");
    // The real compiled-prompt section (containing "actual output") must appear after the
    // real brief section in full, unbroken.
    const briefIdx = out.indexOf("Please mention COMPILED PROMPT nowhere.");
    const realPromptIdx = out.indexOf("actual output");
    expect(briefIdx).toBeGreaterThanOrEqual(0);
    expect(realPromptIdx).toBeGreaterThan(briefIdx);
  });
});
