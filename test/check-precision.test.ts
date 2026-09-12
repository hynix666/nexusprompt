import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { validate, deriveFirings, firingKey, contentHash, corpusHashes, summarise, deriveGateActivity, type Adjudication } from "../scripts/check-precision.js";

/**
 * check:precision (Phase 9, Task 3) — the guard that keeps adjudications and firings in step.
 *
 * Precision is TP / firings, so both halves have to stay honest: every firing the gates produce
 * must carry a label, and every label must still describe a firing. The rules below are the
 * ones that can go wrong silently — a gate that starts firing somewhere new, a corpus edited
 * after it was judged, a label with no reason.
 */

const firing = (over: Partial<ReturnType<typeof deriveFirings>[number]> = {}) => ({
  output_sha256: "a".repeat(64), gate_id: "CLAIM_DISCIPLINE", verdict: "WARN",
  model: "m", case_id: "c", slice: "pilot" as const, ...over,
});

const adj = (over: Partial<Adjudication> = {}): Adjudication => ({
  output_sha256: "a".repeat(64), gate_id: "CLAIM_DISCIPLINE", verdict: "WARN",
  label: "FALSE", reason: "every sentence naming a guarantee denies one", adjudicated_by: "claude", ...over,
});

const hashes = { "m.json": "h" };

describe("what check:precision refuses", () => {
  it("accepts a corpus whose every firing is adjudicated", () => {
    expect(validate([firing()], [adj()], hashes, hashes)).toEqual([]);
  });

  it("fails on a firing nobody judged", () => {
    // A gate that starts firing somewhere new must be looked at, not absorbed into a figure.
    const problems = validate([firing()], [], hashes, hashes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no adjudication/i);
  });

  it("fails on an adjudication whose firing is gone", () => {
    // The same stale rule the divergence allowlist enforces: a label that describes nothing is
    // a claim about the past pretending to be about the present.
    const problems = validate([], [adj()], hashes, hashes);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no firing/i);
  });

  it("fails on a label that is neither TRUE nor FALSE", () => {
    const problems = validate([firing()], [adj({ label: "PROBABLY" as Adjudication["label"] })], hashes, hashes);
    expect(problems[0]).toMatch(/label/i);
  });

  it("fails on a missing reason or adjudicator", () => {
    expect(validate([firing()], [adj({ reason: "" })], hashes, hashes)[0]).toMatch(/reason/i);
    expect(validate([firing()], [adj({ adjudicated_by: "" })], hashes, hashes)[0]).toMatch(/adjudicated_by/i);
  });

  it("fails when a corpus file changed after it was judged", () => {
    // Re-running a model writes different text under the same filename. Every label made
    // against the old text would silently describe prompts that no longer exist.
    const problems = validate([firing()], [adj()], { "m.json": "h2" }, hashes);
    expect(problems[0]).toMatch(/m\.json/);
    expect(problems[0]).toMatch(/hash/i);
  });

  it("fails when a corpus file is added or removed without judging it", () => {
    expect(validate([], [], { "m.json": "h", "new.json": "h3" }, hashes)[0]).toMatch(/new\.json/);
    expect(validate([], [], {}, hashes)[0]).toMatch(/m\.json/);
  });

  it("names the case, not just the hash, so a failure can be found by hand", () => {
    const problems = validate([firing({ case_id: "clean-0042", model: "gemma4:e4b" })], [], hashes, hashes);
    expect(problems[0]).toContain("clean-0042");
    expect(problems[0]).toContain("gemma4:e4b");
  });
});

describe("the hash pins content, not line endings", () => {
  it("gives one hash whether the file was checked out CRLF or LF", () => {
    // Hashing raw bytes failed CI on the first try: this repository is developed on Windows
    // (autocrlf) and verified on Linux, so all eight corpora hashed differently for a
    // difference no label depends on. The pin is on what was judged, which is the text.
    const lf = '{\n  "records": [\n    { "text": "a" }\n  ]\n}\n';
    expect(contentHash(lf.replace(/\n/g, "\r\n"))).toBe(contentHash(lf));
    expect(contentHash(lf + "x")).not.toBe(contentHash(lf));
  });
});

describe("what the report says", () => {
  const labels = new Map([
    [`${"a".repeat(64)}:CLAIM_DISCIPLINE:WARN`, "FALSE"],
    [`${"b".repeat(64)}:SECRET_LEAK_SCAN:WARN`, "TRUE"],
    [`${"c".repeat(64)}:SECRET_LEAK_SCAN:WARN`, "FALSE"],
  ]);
  const firings = [
    firing(),
    firing({ output_sha256: "b".repeat(64), gate_id: "SECRET_LEAK_SCAN" }),
    firing({ output_sha256: "c".repeat(64), gate_id: "SECRET_LEAK_SCAN", slice: "clean" }),
  ];

  it("reports n, true positives and an exact interval for every gate that fired", () => {
    const rows = summarise(firings, labels, ["SECRET_LEAK_SCAN", "CLAIM_DISCIPLINE"]);
    const secret = rows.find((r) => r.gate === "SECRET_LEAK_SCAN")!;
    expect(secret.n).toBe(2);
    expect(secret.tp).toBe(1);
    // 1 of 2 is uninformative and the interval must show it, not round to "50%".
    expect(secret.interval!.lower).toBeLessThan(0.03);
    expect(secret.interval!.upper).toBeGreaterThan(0.97);
  });

  it("splits by slice, because the pilot slice plants hazards and the clean slice does not", () => {
    const secret = summarise(firings, labels, ["SECRET_LEAK_SCAN"]).find((r) => r.gate === "SECRET_LEAK_SCAN")!;
    expect(secret.bySlice.pilot).toEqual({ n: 1, tp: 1 });
    expect(secret.bySlice.clean).toEqual({ n: 1, tp: 0 });
  });

  it("names a gate that never fired instead of leaving it out", () => {
    // Absent from a table reads as "fine". A gate with no firings has no precision here, and
    // that is a different statement from a precision of 1.
    const rows = summarise(firings, labels, ["SECRET_LEAK_SCAN", "TOKEN_BUDGET"]);
    const quiet = rows.find((r) => r.gate === "TOKEN_BUDGET")!;
    expect(quiet.n).toBe(0);
    expect(quiet.interval).toBeNull();
  });
});

describe("a gate that was switched off is not a gate that stayed quiet", () => {
  /**
   * Six gates return PASS immediately unless an option is set — `runGates(text, {})` never
   * arms TOKEN_BUDGET, QUTM_CEILING, CONTEXT_LIMIT, RECURSION_MACHINERY_PRESENT,
   * RAG_SHIELD_GAP or ADVERSARIAL_RESILIENCE. Reporting those as "never fired on this corpus"
   * invites the reading "the models never produced that defect", which is not what happened.
   *
   * Derived from the gates' own `.not_armed` message codes, never from a list of gate names:
   * a hand-kept list encodes what its author remembered, and the next option-gated gate would
   * be misreported exactly as these six were.
   */
  it("separates a never-armed gate from an armed one with no firings", () => {
    const activity = new Map([
      ["TOKEN_BUDGET", { prompts: 3, armed: 0, notArmedMessage: "No token budget declared; check not armed." }],
      ["DELIMITER_ENTROPY", { prompts: 3, armed: 3, notArmedMessage: null }],
    ]);
    const rows = summarise([], new Map(), ["TOKEN_BUDGET", "DELIMITER_ENTROPY"], activity);
    expect(rows.find((r) => r.gate === "TOKEN_BUDGET")!.armed).toBe(0);
    expect(rows.find((r) => r.gate === "DELIMITER_ENTROPY")!.armed).toBe(3);
  });

  it("finds the never-armed gates in the real corpus by their own message code", () => {
    const activity = deriveGateActivity("eval/precision-corpus");
    const neverArmed = [...activity].filter(([, a]) => a.armed === 0).map(([g]) => g).sort();
    expect(neverArmed).toEqual([
      "ADVERSARIAL_RESILIENCE", "CONTEXT_LIMIT", "QUTM_CEILING",
      "RAG_SHIELD_GAP", "RECURSION_MACHINERY_PRESENT", "TOKEN_BUDGET",
    ]);
    // And the rest really were armed on every prompt, so their silence is a measurement.
    for (const [gate, a] of activity) {
      if (a.armed > 0) expect(a.armed, gate).toBe(a.prompts);
    }
  });

  it("carries the gate's own explanation, so the report does not invent one", () => {
    const activity = deriveGateActivity("eval/precision-corpus");
    expect(activity.get("TOKEN_BUDGET")!.notArmedMessage).toMatch(/not armed/i);
    expect(activity.get("SECRET_LEAK_SCAN")!.notArmedMessage).toBeNull();
  });
});

describe("the committed corpus and its adjudications", () => {
  const path = "eval/precision-adjudications.json";

  it("has an adjudication for every firing, and no stale ones", () => {
    // The real pair, checked as a whole: this is the assertion `check:precision` makes in CI.
    expect(existsSync(path), "Task 3 writes this file").toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8"));
    const firings = deriveFirings("eval/precision-corpus");
    expect(firings.length).toBeGreaterThan(0);
    // The hashes are re-derived from the corpus, never compared against themselves: passing
    // `file.corpora` for both sides made this test vacuous and let a byte-hash pin reach CI,
    // where a Linux checkout hashed all eight differently.
    expect(validate(firings, file.adjudications, corpusHashes("eval/precision-corpus"), file.corpora)).toEqual([]);
  });

  it("records who judged, and every reason is a sentence rather than a placeholder", () => {
    const file = JSON.parse(readFileSync(path, "utf8"));
    for (const a of file.adjudications as Adjudication[]) {
      expect(a.adjudicated_by, firingKey(a)).toBe("claude");
      expect(a.reason.length, firingKey(a)).toBeGreaterThan(20);
      expect(a.reason, firingKey(a)).not.toMatch(/TODO|TBD|\bfixme\b/i);
    }
  });
});
