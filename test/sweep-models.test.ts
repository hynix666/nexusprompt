import { describe, it, expect } from "vitest";
import { parseSweepArgs, formatRunLine, extractCaseLines } from "../scripts/sweep-models.mjs";

/**
 * The sweep runner's argument handling and line formats, without running a model.
 *
 * The runner spawns the eval runner and imports nothing from Core, which is why it stays
 * `.mjs` while everything else in this sub-project became `.ts`. What is testable offline is
 * exactly what matters: the two line formats `compare-models.ts` parses, and the refusals
 * that stop a sweep producing nothing usable.
 */

describe("parseSweepArgs", () => {
  it("splits a comma-separated model list", () => {
    const a = parseSweepArgs(["--models", "a:1b,b:2b", "--trials", "3", "--out", "d"]);
    expect(a.models).toEqual(["a:1b", "b:2b"]);
    expect(a.trials).toBe(3);
    expect(a.outDir).toBe("d");
  });

  it("tolerates spaces around names, which a shell makes easy to introduce", () => {
    expect(parseSweepArgs(["--models", "a:1b , b:2b", "--out", "d"]).models).toEqual(["a:1b", "b:2b"]);
  });

  it("defaults to three trials — one gives no variance at all", () => {
    // Variance across trials is the whole measurement; a single trial cannot show it.
    expect(parseSweepArgs(["--models", "a", "--out", "d"]).trials).toBe(3);
  });

  it.each([["0"], ["-1"], ["2.5"], ["many"]])("refuses %s as a trial count", (bad) => {
    expect(() => parseSweepArgs(["--models", "a", "--trials", bad, "--out", "d"])).toThrow(/positive/);
  });

  it("refuses an empty model list rather than sweeping nothing", () => {
    expect(() => parseSweepArgs(["--models", "", "--trials", "3", "--out", "d"])).toThrow(/--models/);
    expect(() => parseSweepArgs(["--trials", "3", "--out", "d"])).toThrow(/--models/);
  });

  it("carries a --suite through to the runner", () => {
    const a = parseSweepArgs(["--models", "a:1b", "--suite", "eval/brief-pilot.json", "--out", "d"]);
    expect(a.suite).toBe("eval/brief-pilot.json");
  });

  it("leaves suite undefined when not given, so the default stays compile-smoke", () => {
    // The armed floor in eval/noise-floor.json was measured on the default. Changing what a
    // bare sweep runs would silently change what that artifact is comparable to.
    expect(parseSweepArgs(["--models", "a:1b", "--out", "d"]).suite).toBeUndefined();
  });
});

describe("formatRunLine", () => {
  it("emits exactly the shape compare-models parses", () => {
    const line = formatRunLine("a:1b", 2, 61, 3, "  10/14 cases · score 0.714", "    tokens 12 in / 34 out");
    expect(line).toBe("RUN|a:1b|2|secs=61|exit=3|10/14 cases · score 0.714|tokens 12 in / 34 out");
  });

  it("still emits a line when the run produced no score", () => {
    // A crashed or timed-out run is data. Dropping it would hide exactly the model whose
    // operational cost is the reason to measure at all.
    expect(formatRunLine("a:1b", 1, 900, 124, "", "")).toBe("RUN|a:1b|1|secs=900|exit=124||");
  });

  it("collapses the runner's indentation, which would otherwise reach the file", () => {
    const line = formatRunLine("m", 1, 1, 0, "   9/14   cases · score 0.643  ", "  tokens 1 in / 2 out ");
    expect(line).toContain("|9/14 cases · score 0.643|");
  });
});

describe("extractCaseLines", () => {
  it("pulls one line per case verdict from the runner's output", () => {
    const out = ["  pass  alpha    hallucination", "  FAIL  beta     overconfidence", "noise"].join("\n");
    expect(extractCaseLines("a:1b", 1, out)).toEqual([
      "CASE|a:1b|1|alpha|pass",
      "CASE|a:1b|1|beta|FAIL",
    ]);
  });

  it("returns nothing for output with no case lines, rather than throwing", () => {
    // A refused run prints a reason and no cases. That is a legitimate outcome to record.
    expect(extractCaseLines("a:1b", 1, "eval: refused before dispatch\n")).toEqual([]);
  });
});
