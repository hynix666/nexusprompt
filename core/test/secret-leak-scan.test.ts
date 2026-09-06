import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Ajv } from "ajv";
import fc from "fast-check";
import {
  secretLeakScan,
  secretLeakLabels,
  SECRET_PATTERNS,
  GATE_ID,
} from "../src/gates/secret-leak-scan.js";
import { stripDocumentationSpans } from "../src/strip-documentation-spans.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Fixtures are read at module load, before the purity harness arms in beforeAll.
// Reading a frozen fixture is test setup, not gate behavior.
const fixtures = JSON.parse(
  readFileSync(path.join(repoRoot, "sources/v5/fixtures.json"), "utf8"),
) as { cases: Array<{ name: string; text: string; options: Record<string, unknown>; expect: { status: string; findings: [string, string][] } }> };

const schema = JSON.parse(
  readFileSync(path.join(repoRoot, "contracts/gate-result.schema.json"), "utf8"),
);

const findCase = (name: string) => {
  const c = fixtures.cases.find((x) => x.name === name);
  if (!c) throw new Error(`fixture case not found: ${name}`);
  return c;
};

/** Did the source expect SECRET_LEAK_SCAN to fire, and at what severity? */
const expectedVerdict = (c: ReturnType<typeof findCase>) => {
  const hit = c.expect.findings.find(([gate]) => gate === GATE_ID);
  return hit ? hit[1] : "PASS";
};

describe("SECRET_LEAK_SCAN — parity with sources/v5/fixtures.json", () => {
  // These three are the cases in the frozen fixture set that exercise this gate.
  for (const name of [
    "secret_leak_key",
    "secret_leak_pii",
    "secret_in_fence_is_documentation",
  ]) {
    it(`matches the source's verdict for "${name}"`, () => {
      const c = findCase(name);
      const result = secretLeakScan(c.text, {
        includeFences: c.options?.include_fences === true,
      });
      expect(result.verdict).toBe(expectedVerdict(c));
    });
  }

  it("emits WARN, not FAIL — a hit means 'look here', not proof", () => {
    const c = findCase("secret_leak_key");
    expect(secretLeakScan(c.text).verdict).toBe("WARN");
  });

  it("treats a key inside a fence as documentation, not a leak", () => {
    const c = findCase("secret_in_fence_is_documentation");
    expect(secretLeakScan(c.text).verdict).toBe("PASS");
    // ...but only because of the strip. With fences included, it is a hit.
    expect(secretLeakScan(c.text, { includeFences: true }).verdict).toBe("WARN");
  });
});

describe("GateResult contract", () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(schema);

  it("a PASS result validates", () => {
    expect(validate(secretLeakScan("nothing to see here"))).toBe(true);
  });

  it("a WARN result validates", () => {
    const r = secretLeakScan(findCase("secret_leak_key").text);
    expect(validate(r)).toBe(true);
  });

  it("rejects a malformed result — the schema can fail", () => {
    const bad = { ...secretLeakScan("clean"), verdict: "MAYBE" };
    expect(validate(bad)).toBe(false);
  });
});

describe("determinism", () => {
  it("same input yields identical output", () => {
    const text = "contact: someone@example.com";
    expect(secretLeakScan(text)).toEqual(secretLeakScan(text));
  });

  it("labels are sorted and de-duplicated", () => {
    const text = "a@b.co and c@d.co and AKIA0123456789ABCDEF";
    const labels = secretLeakLabels(text);
    expect(labels).toEqual([...new Set(labels)].sort());
  });
});

/**
 * These two tests replace two that could not fail.
 *
 * The originals timed `"sk-" + "A".repeat(500_000)` and a run of near-miss `sk-ant-`
 * prefixes against a 1000 ms budget, under a comment promising that removing a bound
 * would be caught. An audit removed the `sk-ant-…{20,128}` upper bound and both stayed
 * green — measured at 0.176 ms bounded versus 0.037 ms unbounded, the mutation being
 * marginally *faster*. Neither input forces backtracking against a key pattern,
 * because nothing follows the quantifier: the match succeeds at the minimum length and
 * the engine never retries.
 *
 * So the invariant is checked where it actually lives — in the shape of the patterns —
 * and timing is used only for `pii_email`, the one pattern where a removed bound is
 * genuinely a performance cliff.
 */
/**
 * The four shapes added in gate 1.2.0 (ADR-0017), probed in both directions.
 *
 * Both halves matter equally and the second is the one that decides whether this gate
 * survives contact with a real prompt. Widening a matcher buys detection with false
 * positives, and a scanner that cries wolf gets its WARN ignored — a false clean reached
 * by a different road. Every must-not-fire case below is text a compiled prompt plausibly
 * contains.
 */
describe("credential shapes beyond the source's set", () => {
  const fires = (text: string, label: string) =>
    expect(secretLeakLabels(text), `expected ${label} to fire`).toContain(label);
  const silent = (text: string) =>
    expect(secretLeakLabels(text), `expected no finding for: ${text.slice(0, 60)}`).toEqual([]);

  it("finds a JWT, and ignores prose that merely looks structured", () => {
    fires(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "jwt",
    );
    silent("Answer in the form section.subsection.paragraph when citing the handbook.");
    silent("Version 1.2.3 of the schema supersedes 1.2.2.");
  });

  it("finds a private-key block in any of its header spellings", () => {
    for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
      fires(`-----BEGIN ${kind}PRIVATE KEY-----\nMIIEvQIBADANBg\n`, "private_key_block");
    }
    // A prompt may legitimately discuss keys without carrying one.
    silent("Never paste a private key into the chat; ask the user to rotate it instead.");
    silent("-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n");
  });

  it("finds credentials embedded in a URL, but not a bare connection string", () => {
    fires("DATABASE_URL=postgres://svc_user:hunter2@db.internal:5432/app", "url_embedded_credentials");
    fires("git remote add origin https://oauth2:ghs_16C7e42F292c6912@github.com/o/r.git", "url_embedded_credentials");
    fires("mongodb+srv://admin:s3cr3t@cluster0.mongodb.net/test", "url_embedded_credentials");
    // Configuration, not a leak — no credentials in any of these.
    silent("Connect to postgres://localhost:5432/app_development for local work.");
    silent("Docs live at https://example.com/guide; read the section on retries.");
  });

  it("finds a Stripe secret key without firing on snake_case identifiers", () => {
    fires("STRIPE_KEY = sk_live_EXAMPLEONLYNOTREAL", "stripe_secret_key");
    fires("test mode uses sk_test_EXAMPLEONLYNOTREAL", "stripe_secret_key");
    /**
     * A real-length body, assembled at runtime rather than written as one literal.
     *
     * GitHub's push protection rejected the first version of this file: a 25-character
     * body is what its Stripe partner pattern looks for, so the fixture read as a live
     * key and the push was blocked. That is a useful independent check on the shape, and
     * the fix is not to click "allow this secret" — a repository that trains its own
     * protection to ignore `sk_live_…` has disarmed it. The short bodies above stay under
     * the scanner's threshold; this one proves the pattern still matches at full length.
     */
    fires(`STRIPE_KEY = ${"sk_live_"}${"51H8xR2KZvNqLmP3wYtBcDfGh"}`, "stripe_secret_key");
    /**
     * The reason this is a specific pattern and not a widened `generic_sk_key`.
     *
     * `sk[-_][A-Za-z0-9_]{20,128}` is a one-character diff that reads as harmless and
     * fires on every one of these: `sk_` is a suffix of ask, task, risk, desk, disk and
     * mask, and snake_case does the rest.
     */
    silent("Set task_manager_configuration_key before the first run.");
    silent("The disk_usage_threshold_value_setting governs eviction.");
    silent("Record risk_assessment_completion_status for each vendor.");
  });

  it("leaves an ordinary compiled prompt clean", () => {
    // The whole-gate must-not-fire check: a realistic artifact, no findings at all.
    silent(
      "# SYSTEM PROMPT\n\nYou are a support assistant for a billing team.\n" +
        "Answer questions about invoices, refunds and disk_usage_reporting_limits.\n" +
        "Do not speculate about account balances you cannot verify.\n",
    );
  });
});

describe("bounded-quantifier invariant", () => {
  /**
   * Walk a regex source and report quantifiers with no upper bound. Escapes and
   * character classes are tracked because `\+` is a literal plus and `[0-9 ().-]`
   * contains characters that are quantifiers anywhere else.
   */
  function unboundedQuantifiers(source: string): string[] {
    const found: string[] = [];
    let inClass = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (inClass) { if (c === "]") inClass = false; continue; }
      if (c === "[") { inClass = true; continue; }
      if (c === "+" || c === "*") { found.push(`${c} at ${i}`); continue; }
      if (c === "{") {
        const end = source.indexOf("}", i);
        if (end === -1) continue;
        const body = source.slice(i + 1, end);
        if (/^\d+,$/.test(body)) found.push(`{${body}} at ${i}`);
        i = end;
      }
    }
    return found;
  }

  it("the scanner itself recognises an unbounded quantifier", () => {
    // A structural check is only worth as much as its detector, so the detector is
    // tested on both answers before being trusted on the real patterns.
    expect(unboundedQuantifiers("[A-Za-z]{1,64}@x")).toEqual([]);
    expect(unboundedQuantifiers("\\+[0-9]{8,20}[0-9]")).toEqual([]);
    expect(unboundedQuantifiers("[A-Za-z]+@x")).toHaveLength(1);
    expect(unboundedQuantifiers("[A-Za-z]{1,}@x")).toHaveLength(1);
    expect(unboundedQuantifiers("a.*b")).toHaveLength(1);
  });

  it("every secret pattern bounds every quantifier at both ends", () => {
    for (const [pattern, label] of SECRET_PATTERNS) {
      expect(
        { label, unbounded: unboundedQuantifiers(pattern.source) },
        `${label} has an unbounded quantifier — see the note in secret-leak-scan.ts`,
      ).toEqual({ label, unbounded: [] });
    }
  });

  it("stays linear on a long local-part run with no '@'", () => {
    // The measured discriminator. Bounded ≈ 8 ms; with `{1,64}` relaxed to `+` the
    // same input took ≈ 1370 ms on the machine that wrote this. The budget sits
    // between those, far from both.
    const adversarial = "a".repeat(60_000);
    const start = process.hrtime.bigint();
    secretLeakScan(adversarial);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(300);
  });

  it("never throws, on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (s) => {
        const r = secretLeakScan(s);
        return r.gate_id === GATE_ID && ["PASS", "WARN"].includes(r.verdict);
      }),
      { numRuns: 200 },
    );
  });
});

describe("stripDocumentationSpans", () => {
  it("strips a fenced block", () => {
    expect(stripDocumentationSpans("a\n```\nsecret\n```\nb")).toBe("a\nb");
  });

  it("strips inline backtick spans", () => {
    expect(stripDocumentationSpans("use `sk-abc` here")).toBe("use  here");
  });

  it("treats a shorter fence inside a longer one as content", () => {
    const out = stripDocumentationSpans("x\n````\n```\ninner\n````\ny");
    expect(out).toBe("x\ny");
  });

  it("an unclosed fence strips to EOF — safe-side, per the source", () => {
    expect(stripDocumentationSpans("keep\n```\ndropped\nalso dropped")).toBe("keep");
  });
});
