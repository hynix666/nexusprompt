import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalSuite, SuiteError } from "../scripts/load-eval-suite.js";

const write = (body: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), "suite-")), "s.json");
  writeFileSync(p, JSON.stringify(body), "utf8");
  return p;
};

const suite = (case_ids: string[]) => ({
  suite_id: "fixture",
  version: "1.0.0",
  kind: "smoke",
  case_ids,
  resolution: { detectable_delta: 1 / Math.max(case_ids.length, 1), confidence: 0.95 },
  significance_protocol: "exact-mcnemar",
});

const caseOf = (case_id: string) => ({ case_id, brief: "b", stub: { text: "t" } });

describe("loadEvalSuite", () => {
  it("returns cases in the order case_ids declares, not file order", () => {
    const p = write({ suite: suite(["a", "b"]), cases: [caseOf("b"), caseOf("a")] });
    expect(loadEvalSuite(p).cases.map((c) => c.case_id)).toEqual(["a", "b"]);
  });

  it("refuses a suite that declares a case but holds none", () => {
    const p = write({ suite: suite(["a"]), cases: [] });
    expect(() => loadEvalSuite(p)).toThrow(/holds no cases/);
  });

  it("refuses a suite that does not satisfy eval-suite.schema.json", () => {
    const p = write({ suite: { suite_id: "x" }, cases: [caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(/eval-suite\.schema\.json/);
  });

  it("refuses a declared case that is absent", () => {
    const p = write({ suite: suite(["a", "b"]), cases: [caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(/declared but absent: b/);
  });

  it("refuses a case that was never declared", () => {
    const p = write({ suite: suite(["a"]), cases: [caseOf("a"), caseOf("z")] });
    expect(() => loadEvalSuite(p)).toThrow(/present but undeclared: z/);
  });

  it("refuses duplicate case ids", () => {
    const p = write({ suite: suite(["a"]), cases: [caseOf("a"), caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(/duplicate/);
  });

  it("refuses a suite that does not satisfy eval-suite.schema.json (SuiteError)", () => {
    const p = write({ suite: { suite_id: "x" }, cases: [caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(SuiteError);
  });

  it("loads every real suite in eval/ unchanged", () => {
    // The must-not-break half. A validator that rejects the corpus proves nothing.
    for (const f of ["eval/compile-smoke.json", "eval/pipeline-smoke.json"]) {
      expect(loadEvalSuite(f).cases.length).toBeGreaterThan(0);
    }
  });
});
