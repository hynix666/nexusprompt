import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Ajv } from "ajv";
import fc from "fast-check";
import { claimDiscipline, GATE_ID } from "../src/gates/claim-discipline.js";

/**
 * CLAIM_DISCIPLINE had no test file of its own.
 *
 * That was awkward for two reasons. It is the gate the demo-mode honesty guarantee
 * rests on — a placeholder produced without a model must not assert what a model
 * would have — and `GATES_REFERENCE.md` claimed every gate ships with a property
 * test. It was reached only through `compile.test.ts` and the differential oracle.
 *
 * Every expected verdict below was read off the frozen Python linter before being
 * written down, using `scripts/differential.ts`'s method. Asserting what the port
 * happens to do and calling it parity is the failure this project exists to avoid.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Read at module load, before the purity harness arms. Reading a frozen fixture is
// test setup, not gate behaviour.
const fixtures = JSON.parse(
  readFileSync(path.join(repoRoot, "sources/v5/fixtures.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    text: string;
    options?: Record<string, unknown>;
    expect: { findings: [string, string][] };
  }>;
};

const schema = JSON.parse(
  readFileSync(path.join(repoRoot, "contracts/gate-result.schema.json"), "utf8"),
);

describe("CLAIM_DISCIPLINE — parity with sources/v5/fixtures.json", () => {
  // One frozen case exercises this gate, and it exists because the defect shipped:
  // the original regex required a literal space, so "100%accurate" passed clean.
  it('matches the source verdict for "claim_discipline_no_space"', () => {
    const c = fixtures.cases.find((x) => x.name === "claim_discipline_no_space");
    if (!c) throw new Error("fixture claim_discipline_no_space is missing");
    const expected = c.expect.findings.find(([g]) => g === GATE_ID)?.[1] ?? "PASS";
    expect(claimDiscipline(c.text).verdict).toBe(expected);
    expect(expected).toBe("WARN"); // pin the fixture's own claim, not just agreement
  });
});

describe("CLAIM_DISCIPLINE — verdicts confirmed against the frozen linter", () => {
  const verified: Array<[string, string, "PASS" | "WARN", boolean]> = [
    ["a bare guarantee", "We guarantee it.", "WARN", false],
    ["third person", "This guarantees delivery.", "WARN", false],
    ["past participle", "Results are guaranteed.", "WARN", false],
    ["uppercase", "WE GUARANTEE IT", "WARN", false],
    ["no space before the adjective", "100%accurate", "WARN", false],
    ["two spaces", "100%  safe", "WARN", false],
    ["a claim of determinism", "The build is 100% deterministic.", "WARN", false],

    // The two edges worth pinning, both confirmed against the source.
    // "guaranteeing" does not match: `\bguarantee[sd]?\b` needs a boundary after the
    // optional s/d, and "ing" is not one.
    ["a gerund is not a guarantee", "We are guaranteeing nothing here.", "PASS", false],
    // "guarantee-free" does match, because a hyphen IS a word boundary. It is a false
    // positive, the source has it too, and a port that quietly fixed it would disagree
    // with the oracle on every run. Recorded, not corrected — see ADR-0007 on why a
    // deliberate divergence needs an allowlist entry first.
    ["a hyphen is a word boundary", "a guarantee-free zone", "WARN", false],
    // "100% wrong" is not one of the three flagged adjectives.
    ["an unflagged adjective", "This is 100% wrong.", "PASS", false],

    ["fenced content is documentation", "clean\n```\nwe guarantee everything\n```\n", "PASS", false],
    ["…unless fences are included", "clean\n```\nwe guarantee everything\n```\n", "WARN", true],
    ["inline spans are documentation too", "the word `guarantee` is flagged", "PASS", false],
  ];

  for (const [label, text, expected, includeFences] of verified) {
    it(`${label} → ${expected}`, () => {
      expect(claimDiscipline(text, { includeFences }).verdict).toBe(expected);
    });
  }
});

describe("CLAIM_DISCIPLINE — the message names what it found", () => {
  it("lists the offending phrases, sorted and de-duplicated", () => {
    const r = claimDiscipline("We guarantee it. We guarantee it again. 100% safe.");
    expect(r.verdict).toBe("WARN");
    expect(r.message_code).toBe("CLAIM_DISCIPLINE.overclaim");

    // Assert the list itself rather than counting substrings: the advice sentence
    // that follows also contains the word "guarantee", so a naive occurrence count
    // measures the message template instead of the finding.
    const listed = r.message.match(/Unhedged claim\(s\): (.*?)\. State/)?.[1];
    expect(listed).toBe("100% safe, guarantee");
  });

  it("a clean result says so without naming anything", () => {
    const r = claimDiscipline("State what was verified.");
    expect(r.verdict).toBe("PASS");
    expect(r.message_code).toBe("CLAIM_DISCIPLINE.clean");
  });
});

describe("CLAIM_DISCIPLINE — contract", () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);

  it("a PASS result validates against gate-result.schema.json", () => {
    expect(validate(claimDiscipline("nothing here"))).toBe(true);
  });

  it("a WARN result validates", () => {
    expect(validate(claimDiscipline("we guarantee it"))).toBe(true);
  });

  it("rejects a malformed result — the schema can fail", () => {
    expect(validate({ ...claimDiscipline("clean"), verdict: "MAYBE" })).toBe(false);
  });
});

describe("CLAIM_DISCIPLINE — properties", () => {
  it("never throws, and only ever returns PASS or WARN", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (s) => {
        const r = claimDiscipline(s);
        return r.gate_id === GATE_ID && ["PASS", "WARN"].includes(r.verdict);
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic — identical input, identical bytes out", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        expect(claimDiscipline(s)).toEqual(claimDiscipline(s));
      }),
      { numRuns: 100 },
    );
  });

  it("appending an overclaim to any clean text always warns", () => {
    // Monotonicity. A gate that can be silenced by surrounding context is worse than
    // no gate, because the output still carries its PASS.
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        expect(claimDiscipline(`${s}\nWe guarantee it.`).verdict).toBe("WARN");
      }),
      { numRuns: 200 },
    );
  });

  it("fenced content cannot change the verdict", () => {
    // The exemption has to hold for arbitrary fenced text, not just the examples
    // someone thought of. Backticks and newlines are excluded because they would
    // close or restructure the fence — that is a different property.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((s) => !s.includes("`") && !s.includes("\n")),
        (inner) => {
          const base = "A support assistant for billing questions.";
          expect(claimDiscipline(`${base}\n\`\`\`\n${inner}\n\`\`\`\n`).verdict).toBe(
            claimDiscipline(base).verdict,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("including fences is never more permissive than stripping them", () => {
    // Stripping only ever removes text, so anything found in the stripped body is
    // still there when fences are included.
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        if (claimDiscipline(s, { includeFences: false }).verdict === "WARN") {
          expect(claimDiscipline(s, { includeFences: true }).verdict).toBe("WARN");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("hashes the raw input, not the text it audited", () => {
    // Two inputs that audit identically but differ inside a fence must not share an
    // input_hash, or the hash stops identifying the input it was computed from.
    const a = claimDiscipline("body\n```\nalpha\n```\n");
    const b = claimDiscipline("body\n```\nbeta\n```\n");
    expect(a.verdict).toBe(b.verdict);
    expect(a.input_hash).not.toBe(b.input_hash);
  });
});
