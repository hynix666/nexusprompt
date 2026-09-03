import { describe, it, expect } from "vitest";
import {
  buildBriefCorpus, failingGates, satisfiesOwnStub, BriefCorpusExhausted,
} from "../src/eval/brief-generator.js";
import { partitionByTransport } from "../src/eval/transport-validity.js";

describe("buildBriefCorpus", () => {
  it("is deterministic in the seed, byte for byte", () => {
    const a = buildBriefCorpus({ seed: 1, count: 20 });
    const b = buildBriefCorpus({ seed: 1, count: 20 });
    expect(a).toEqual(b);
  });

  it("produces a different corpus for a different seed", () => {
    const a = buildBriefCorpus({ seed: 1, count: 20 });
    const b = buildBriefCorpus({ seed: 2, count: 20 });
    expect(a).not.toEqual(b);
  });

  it("produces exactly the count asked for, with unique ids", () => {
    const c = buildBriefCorpus({ seed: 1, count: 37 });
    expect(c).toHaveLength(37);
    expect(new Set(c.map((k) => k.case_id)).size).toBe(37);
  });

  it("varies all four pressure dimensions", () => {
    // A generator that collapsed to one shape would still pass every other test here while
    // measuring one thing a hundred times.
    const c = buildBriefCorpus({ seed: 1, count: 100 });
    // `brief-secret-0000`.split("-")[1] is the shape. The index, not the count, is what
    // makes this readable — a case id is `brief-<shape>-<nnnn>`.
    const shapes = new Set(c.map((k) => k.case_id.split("-")[1]));
    expect(shapes).toEqual(new Set(["secret", "unicode", "placeholder", "structure"]));
    // 100 cases round-robin over four shapes, so each appears exactly 25 times.
    for (const s of shapes) {
      expect(c.filter((k) => k.case_id.split("-")[1] === s)).toHaveLength(25);
    }
  });

  it("keeps only cases whose own stub satisfies their own expectation", () => {
    // RE-DERIVED, not trusted. The anchor kept `base_text` for exactly this reason: an
    // invariant you cannot check after the fact is one you are taking on faith.
    for (const k of buildBriefCorpus({ seed: 1, count: 100 })) {
      expect(satisfiesOwnStub(k), `${k.case_id} cannot be passed by its own stub`).toBe(true);
    }
  });

  it("keeps only cases whose stub trips no gate FAIL", () => {
    for (const k of buildBriefCorpus({ seed: 1, count: 100 })) {
      expect(failingGates(k.stub.content), k.case_id).toEqual([]);
    }
  });

  it("contains no case that a real transport would have to exclude", () => {
    // Spec section 3: a generated suite that generates its own exclusions is a suite arguing
    // with itself. Every case must mean the same thing under stub, local and live.
    const c = buildBriefCorpus({ seed: 1, count: 100 });
    expect(partitionByTransport(c, "local").excluded).toEqual([]);
    expect(partitionByTransport(c, "live").excluded).toEqual([]);
  });

  it("never scores with a detector that reads pipeline structure rather than output", () => {
    // gates-ran and provenance-complete are constant by construction. They are two of the
    // seven dead cases this suite exists to stop paying for.
    for (const k of buildBriefCorpus({ seed: 1, count: 100 })) {
      expect(k.detector_ids).not.toContain("gates-ran");
      expect(k.detector_ids).not.toContain("provenance-complete");
      expect(k.detector_ids).not.toContain("no-gate-warnings");
    }
  });

  it("throws rather than looping when the corpus cannot fill", () => {
    expect(() => buildBriefCorpus({ seed: 1, count: 10, maxDraws: 2 })).toThrow(BriefCorpusExhausted);
  });
});
