import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Ajv } from "ajv";
import fc from "fast-check";
import {
  secretLeakScan,
  secretLeakLabels,
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

describe("bounded-quantifier invariant", () => {
  // The source bounds every quantifier at both ends because an open-ended one made
  // the scan quadratic — a 500 KB prompt took minutes. This is the test that catches
  // a "simplification" that removes a bound.
  it("scans a 500 KB adversarial input well under a second", () => {
    const adversarial = "sk-" + "A".repeat(500_000);
    const start = process.hrtime.bigint();
    secretLeakScan(adversarial);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(1000);
  });

  it("stays bounded on repeated near-miss prefixes", () => {
    const adversarial = ("sk-ant-" + "x".repeat(19) + " ").repeat(20_000);
    const start = process.hrtime.bigint();
    secretLeakScan(adversarial);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(1000);
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
