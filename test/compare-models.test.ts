import { describe, it, expect } from "vitest";
import {
  parseRuns, parseCases, caseMatrix, pairsOf, verdictFor, report,
} from "../scripts/compare-models.js";

/**
 * The model-comparison harness, on a fixture rather than on models.
 *
 * Every assertion here runs in milliseconds and touches no daemon. That is the point: the
 * sweep it reads took ninety minutes of GPU time, so the analysis must be testable without
 * repeating it, or it can only be checked by the thing it is supposed to check.
 */

const RUNS = [
  "RUN|fast:1b|1|secs=60|exit=1|10/14 cases · score 0.714|tokens 100 in / 200 out",
  "RUN|fast:1b|2|secs=64|exit=1|9/14 cases · score 0.643|tokens 100 in / 210 out",
  "RUN|slow:70b|1|secs=900|exit=1|11/14 cases · score 0.786|tokens 100 in / 900 out",
].join("\n");

/** Two cases both models agree on, one they split. */
const CASES = [
  "CASE|fast:1b|1|always-passes|pass",
  "CASE|fast:1b|1|always-fails|FAIL",
  "CASE|fast:1b|1|they-differ|FAIL",
  "CASE|slow:70b|1|always-passes|pass",
  "CASE|slow:70b|1|always-fails|FAIL",
  "CASE|slow:70b|1|they-differ|pass",
].join("\n");

describe("parsing", () => {
  it("reads score, wall time and trial from a run line", () => {
    const r = parseRuns(RUNS);
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ model: "fast:1b", trial: 1, secs: 60, passed: 10, cases: 14, score: 0.714 });
  });

  it("survives a truncated run line rather than throwing", () => {
    // The sweep appends as it goes, so a crash mid-run leaves a partial file. Refusing to
    // parse it would throw away every complete run beside it.
    const r = parseRuns("RUN|fast:1b|1|secs=60|exit=1||");
    expect(r[0]).toMatchObject({ model: "fast:1b", score: null, passed: null });
  });

  it("clusters trials of one case rather than counting them as separate units", () => {
    // 14 cases x 3 trials is 14 independent units, not 42. Counting trials as units inflates
    // the sample by the trial factor and makes every p-value anticonservative.
    const byModel = parseCases([
      "CASE|m|1|c|pass",
      "CASE|m|2|c|FAIL",
    ].join("\n"));
    // Annotated because the harness is `.mjs` and carries no declarations — the shape is the
    // comparator's `CaseOutcome`, which is what makes these rows feedable to `clusteredPaired`.
    const rows = byModel.get("m") as Array<{ case_id: string; cluster_id: string; passed: boolean }>;
    expect(rows.map((r) => r.case_id)).toEqual(["c#1", "c#2"]);
    expect(new Set(rows.map((r) => r.cluster_id))).toEqual(new Set(["c"]));
  });
});

describe("caseMatrix", () => {
  it("marks a case constant when every model scores it the same", () => {
    const m = caseMatrix(parseCases(CASES));
    const byId = Object.fromEntries(m.map((r) => [r.case_id, r.constant]));
    expect(byId).toEqual({ "always-passes": true, "always-fails": true, "they-differ": false });
  });

  it("counts a case where models disagree as informative", () => {
    // This column is the harness's most useful output: on the real suite, 10 of 14 cases were
    // constant across four models, so its effective width for telling models apart was four.
    const m = caseMatrix(parseCases(CASES));
    expect(m.filter((r) => !r.constant).map((r) => r.case_id)).toEqual(["they-differ"]);
  });
});

describe("pairsOf", () => {
  it("is the multiplicity family, so the correction cannot disagree with the loop", () => {
    expect(pairsOf(["a", "b", "c"])).toEqual([["a", "b"], ["a", "c"], ["b", "c"]]);
    expect(pairsOf(["a", "b", "c", "d"])).toHaveLength(6);
  });
});

describe("verdictFor — refused is not inconclusive", () => {
  const outcomes = (n: number, passed: (i: number) => boolean) =>
    Array.from({ length: n }, (_, i) => ({ case_id: `c${i}`, cluster_id: `c${i}`, passed: passed(i) }));

  it("refuses when no arrangement of the signs could reach the alpha", () => {
    // Three discordant clusters bottom out at p=0.25. Calling that 'inconclusive' would claim
    // we looked and saw nothing, when in fact we could not have seen anything.
    const cand = outcomes(10, (i) => i < 3);
    const base = outcomes(10, () => false);
    const v = verdictFor(cand, base, 0.05);
    expect(v.verdict).toBe("refused");
    expect(v.discordant).toBe(3);
    expect(v.best).toBeCloseTo(0.25, 5);
  });

  it("calls a large one-directional difference significant", () => {
    const cand = outcomes(12, () => true);
    const base = outcomes(12, () => false);
    const v = verdictFor(cand, base, 0.05);
    expect(v.discordant).toBe(12);
    expect(v.verdict).toBe("significant");
  });

  it("calls a split difference inconclusive rather than refused", () => {
    // Enough discordance to be attainable, but the signs cancel. This is the genuine null.
    const cand = outcomes(12, (i) => i % 2 === 0);
    const base = outcomes(12, (i) => i % 2 === 1);
    const v = verdictFor(cand, base, 0.05);
    expect(v.discordant).toBe(12);
    expect(v.verdict).toBe("inconclusive");
  });
});

describe("report", () => {
  const text = report(RUNS, CASES);

  it("names the constant cases, because they are the ones that decide nothing", () => {
    expect(text).toContain("(constant)");
    expect(text).toContain("2 of 3 case(s) are constant");
  });

  it("states the corrected alpha and the discordance floor it implies", () => {
    expect(text).toContain("family of 1");
    expect(text).toContain("discordant clusters needed");
  });

  it("reports what the suite can resolve, so a null result is readable", () => {
    expect(text).toMatch(/What 3 cases resolve at 80% power: \d+\.\d pp/);
  });
});

describe("report — runtime refusal against a recorded floor", () => {
  /** 12 cases at discordance 0.238 resolve about 39.5 pp. */
  const FLOOR = { suite: { cases_scored: 12 }, discordance_rate: 0.238 };

  it("annotates a verdict that sits inside the recorded floor", () => {
    const text = report(RUNS, CASES, { floor: FLOOR });
    expect(text).toContain("inside the recorded noise floor");
  });

  it("says nothing about a floor when none is supplied", () => {
    // The tool must stay usable before any measurement exists.
    expect(report(RUNS, CASES)).not.toContain("inside the recorded noise floor");
  });

  it("names the floor it is comparing against, so the number is auditable", () => {
    expect(report(RUNS, CASES, { floor: FLOOR })).toMatch(/39\.5 pp/);
  });
});
