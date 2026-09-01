import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { requiresPinnedStub, partitionByTransport } from "../src/eval/transport-validity.js";

/**
 * The inversion this prevents, and the two halves that must not break.
 *
 * A case asserting a gate FIRES is reachable only because the stub plants the content the
 * gate looks for. On a real transport the model writes the output instead, the gate correctly
 * stays quiet, and the case fails — so failing means the model behaved WELL and passing means
 * it produced the defect.
 *
 * Not hypothetical. Over nine `--local` runs across three models on 1 September 2026,
 * `secret-in-output-is-flagged` failed 0/9 and `overclaim-in-output-is-flagged` passed once —
 * for gemma4:e4b, which wrote guarantee language that tripped CLAIM_DISCIPLINE. That single
 * inverted pass was its entire apparent lead; with both cases removed, all three models scored
 * identically at 0.806.
 */

const gateCase = (verdict: string) => ({
  case_id: `asserts-${verdict}`,
  expectation: { kind: "predicate", value: { gate: "SECRET_LEAK_SCAN", verdict } },
});

describe("requiresPinnedStub — must fire", () => {
  it.each(["WARN", "FAIL"])("catches a case asserting a gate returns %s", (verdict) => {
    expect(requiresPinnedStub(gateCase(verdict))).toBe(true);
  });
});

describe("requiresPinnedStub — must NOT fire", () => {
  // The half that matters more. A predicate returning true for everything would satisfy the
  // block above and silently empty the suite on every real transport.

  it("leaves a case asserting a gate stays SILENT", () => {
    // `fenced-secret-is-documentation`. A well-behaved model does not trip it either, so the
    // case means the same thing under every transport.
    expect(requiresPinnedStub(gateCase("PASS"))).toBe(false);
  });

  it.each([
    ["output-omits", { kind: "predicate", value: "sk-ant-" }],
    ["output-contains", { kind: "predicate", value: "# SYSTEM PROMPT" }],
    ["no expectation value", { kind: "none" }],
  ])("leaves a %s case — the suite's only real model tests", (_label, expectation) => {
    expect(requiresPinnedStub({ case_id: "x", expectation })).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "nonsense"],
    ["no expectation", { case_id: "x" }],
    ["a gate expectation with no verdict", { case_id: "x", expectation: { kind: "predicate", value: { gate: "G" } } }],
  ])("runs rather than drops %s", (_label, input) => {
    // Excluding is the dangerous direction: a filter that swallowed what it could not parse
    // would shrink the suite quietly, which is the defect this module exists to prevent.
    expect(requiresPinnedStub(input)).toBe(false);
  });
});

describe("partitionByTransport", () => {
  const cases = [gateCase("WARN"), gateCase("PASS"), { case_id: "plain", expectation: { kind: "none" } }];

  it("changes nothing on the stub transport, where the plants are real", () => {
    const { runnable, excluded } = partitionByTransport(cases, "stub");
    expect(runnable).toHaveLength(3);
    expect(excluded).toEqual([]);
  });

  it.each(["local", "live"] as const)("excludes only the gate-fires case on %s", (transport) => {
    const { runnable, excluded } = partitionByTransport(cases, transport);
    expect(excluded.map((c) => c.case_id)).toEqual(["asserts-WARN"]);
    expect(runnable.map((c) => c.case_id)).toEqual(["asserts-PASS", "plain"]);
  });

  it("returns both halves, so the caller can report the denominator it actually scored", () => {
    const { runnable, excluded } = partitionByTransport(cases, "local");
    expect(runnable.length + excluded.length).toBe(cases.length);
  });
});

describe("the real suite — what this costs compile-smoke", () => {
  /**
   * Pinned against the shipped suite rather than a fixture. If someone adds a thirteenth
   * gate-fires case, this fails and they have to decide deliberately whether a case that
   * cannot be scored on a real transport belongs in a suite people run on real transports.
   */
  const suite = JSON.parse(readFileSync("eval/compile-smoke.json", "utf8")) as {
    cases: Array<{ case_id: string }>;
  };

  it("excludes exactly the two measured inversions, and keeps the other twelve", () => {
    const { runnable, excluded } = partitionByTransport(suite.cases, "local");
    expect(excluded.map((c) => c.case_id).sort()).toEqual([
      "overclaim-in-output-is-flagged",
      "secret-in-output-is-flagged",
    ]);
    expect(runnable).toHaveLength(12);
  });

  it("keeps every case when the stub supplies the output", () => {
    expect(partitionByTransport(suite.cases, "stub").runnable).toHaveLength(suite.cases.length);
  });
});
