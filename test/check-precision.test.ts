import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { validate, deriveFirings, firingKey, type Adjudication } from "../scripts/check-precision.js";

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

describe("the committed corpus and its adjudications", () => {
  const path = "eval/precision-adjudications.json";

  it("has an adjudication for every firing, and no stale ones", () => {
    // The real pair, checked as a whole: this is the assertion `check:precision` makes in CI.
    expect(existsSync(path), "Task 3 writes this file").toBe(true);
    const file = JSON.parse(readFileSync(path, "utf8"));
    const firings = deriveFirings("eval/precision-corpus");
    expect(firings.length).toBeGreaterThan(0);
    expect(validate(firings, file.adjudications, file.corpora, file.corpora)).toEqual([]);
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
