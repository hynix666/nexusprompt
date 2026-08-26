import { describe, it, expect } from "vitest";
import { lint } from "../src/lint.js";

/**
 * The arithmetic gates were unreachable from the only production entry point.
 *
 * `lint()` passed nothing but `includeFences`, so QUTM_CEILING could not arm and
 * GUARDRAIL_GAP could not escalate outside the eval harness and the differential's own
 * boundary cases. ADR-0011 argued about a floor on a gate no real caller could reach —
 * a guard reachable only by its tests, which is the defect this repository keeps finding.
 */
describe("lint() can arm the option-gated gates", () => {
  const bloated = "a".repeat(40_000);

  it("arms QUTM_CEILING only when a tier is supplied", () => {
    const off = lint(bloated).results.find((r) => r.gate_id === "QUTM_CEILING")!;
    expect(off.message_code).toBe("QUTM_CEILING.not_armed");

    const on = lint(bloated, { stakes: "guarded", naiveTokens: 200 }).results
      .find((r) => r.gate_id === "QUTM_CEILING")!;
    expect(on.message_code).toBe("QUTM_CEILING.exceeded");
  });

  it("accepts this system's UPPERCASE tier vocabulary", () => {
    /**
     * The must-not-fire half, and it is the one that matters. `QUTM_CEILINGS` is keyed
     * lowercase to stay faithful to the frozen linter, whose unknown tier is a FAIL. This
     * system's own vocabulary is uppercase, so passing it straight through turned every
     * production lint at a declared tier into `unknown_tier` — a FAIL on correct input,
     * created by wiring the option up. Normalisation belongs in the Application, so Core
     * stays exactly as faithful as it was.
     */
    for (const tier of ["HIGH", "SAFETY-CRITICAL", "LOW", "MEDIUM", "GUARDED"]) {
      const r = lint(bloated, { stakes: tier }).results.find((x) => x.gate_id === "QUTM_CEILING")!;
      expect({ tier, code: r.message_code }).not.toEqual({ tier, code: "QUTM_CEILING.unknown_tier" });
    }
    // ...and a tier that really is unknown still refuses rather than passing quietly.
    const bogus = lint(bloated, { stakes: "extremely-high" }).results
      .find((x) => x.gate_id === "QUTM_CEILING")!;
    expect(bogus.message_code).toBe("QUTM_CEILING.unknown_tier");
  });

  it("escalates GUARDRAIL_GAP from WARN to FAIL on a safety tier", () => {
    const bare = "A plain prompt with no guardrail vocabulary at all.";
    expect(lint(bare).results.find((r) => r.gate_id === "GUARDRAIL_GAP")!.verdict).toBe("WARN");
    expect(lint(bare, { stakes: "HIGH" }).results.find((r) => r.gate_id === "GUARDRAIL_GAP")!.verdict)
      .toBe("FAIL");
  });
});
