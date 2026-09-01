import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNoiseFloor, resolvableFor } from "../scripts/noise-floor.js";

/**
 * The measurement artifact, built from sweep text rather than from models.
 *
 * The measurement this describes cost ninety minutes of GPU time. Every test here runs in
 * milliseconds against fixture text, because an artifact checkable only by re-measuring is
 * not checkable.
 */

const RUNS = [
  "RUN|a:1b|1|secs=10|exit=1|2/3 cases · score 0.667|tokens 5 in / 7 out",
  "RUN|a:1b|2|secs=12|exit=1|3/3 cases · score 1.000|tokens 5 in / 9 out",
  "RUN|b:2b|1|secs=90|exit=3|1/3 cases · score 0.333|tokens 5 in / 40 out",
].join("\n");

const CASES = [
  "CASE|a:1b|1|shared|pass", "CASE|a:1b|1|split|FAIL",
  "CASE|a:1b|2|shared|pass", "CASE|a:1b|2|split|pass",
  "CASE|b:2b|1|shared|pass", "CASE|b:2b|1|split|FAIL",
].join("\n");

const META = {
  measured_on: "2026-09-01",
  suite: { id: "s", version: "1.0.0", cases_scored: 12 },
  transport: "local",
  trials_per_model: 3,
};

describe("buildNoiseFloor", () => {
  it("records spread as max minus min, not a standard deviation", () => {
    const a = buildNoiseFloor(RUNS, CASES, META).models["a:1b"];
    expect(a.scores).toEqual([0.667, 1]);
    expect(a.mean).toBeCloseTo(0.8335, 4);
    expect(a.spread).toBeCloseTo(0.333, 3);
  });

  it("counts a degraded run rather than dropping it", () => {
    // exit 3 is a degraded run. Dropping it would flatter a model that times out.
    expect(buildNoiseFloor(RUNS, CASES, META).models["b:2b"].degraded_runs).toBe(1);
    expect(buildNoiseFloor(RUNS, CASES, META).models["a:1b"].degraded_runs).toBe(0);
  });

  it("carries cost through per run", () => {
    const a = buildNoiseFloor(RUNS, CASES, META).models["a:1b"];
    expect(a.seconds).toEqual([10, 12]);
    expect(a.tokens_out).toEqual([7, 9]);
  });

  it("derives discordance per pair and a mean across pairs", () => {
    const art = buildNoiseFloor(RUNS, CASES, META);
    expect(art.pairs["a:1b|b:2b"]).toEqual({ discordant_clusters: 1, clusters: 2 });
    expect(art.discordance_rate).toBeCloseTo(0.5, 5);
  });

  it("marks which cases are constant across models", () => {
    const art = buildNoiseFloor(RUNS, CASES, META);
    expect(art.cases.shared.constant).toBe(true);
    expect(art.cases.split.constant).toBe(false);
  });

  it("records no verdict about which model is better", () => {
    // The artifact stores measurements only. A stored verdict becomes something people cite
    // instead of re-deriving, and sub-project 2 needs a rate, not a conclusion.
    const flat = JSON.stringify(buildNoiseFloor(RUNS, CASES, META));
    for (const word of ["winner", "better", "beats", "significant", "verdict"]) {
      expect(flat).not.toContain(word);
    }
  });

  it("attributes case rates to the right model when the two files disagree on order", () => {
    // `caseMatrix` orders its rates by the CASE data; model names come from the RUN data.
    // Indexing one by the other's order would silently attribute every rate to the wrong
    // model, and every number downstream would still look plausible.
    const runsReversed = [
      "RUN|b:2b|1|secs=90|exit=1|1/3 cases · score 0.333|tokens 5 in / 40 out",
      "RUN|a:1b|1|secs=10|exit=1|2/3 cases · score 0.667|tokens 5 in / 7 out",
    ].join("\n");
    const art = buildNoiseFloor(runsReversed, CASES, META);
    // `a:1b` passes `split` on trial 2 in CASES; `b:2b` never does.
    expect(art.cases.split.rates["b:2b"]).toEqual([0, 1]);
  });

  it("carries the meta the floor is only valid under", () => {
    const art = buildNoiseFloor(RUNS, CASES, META);
    expect(art.suite).toEqual({ id: "s", version: "1.0.0", cases_scored: 12 });
    expect(art.transport).toBe("local");
    expect(art.measured_on).toBe("2026-09-01");
  });
});

describe("resolvableFor", () => {
  it("uses the artifact's own case count and discordance rate", () => {
    const art = { suite: { cases_scored: 12 }, discordance_rate: 0.238 };
    expect(resolvableFor(art)).toBeCloseTo(0.395, 3);
  });

  it("is larger for a smaller suite — fewer cases resolve less", () => {
    const small = resolvableFor({ suite: { cases_scored: 6 }, discordance_rate: 0.238 });
    const big = resolvableFor({ suite: { cases_scored: 60 }, discordance_rate: 0.238 });
    expect(small).toBeGreaterThan(big);
  });
});

describe("compare:models --write", () => {
  const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const SCRIPT = join(process.cwd(), "scripts/compare-models.ts");
  const temps: string[] = [];
  afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

  const sweepDir = () => {
    const d = mkdtempSync(join(tmpdir(), "nf-"));
    temps.push(d);
    writeFileSync(join(d, "runs.txt"), RUNS);
    writeFileSync(join(d, "cases.txt"), CASES);
    mkdirSync(join(d, "eval"), { recursive: true });
    return d;
  };

  const run = (args: string[], cwd: string) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [TSX, SCRIPT, ...args], { cwd, encoding: "utf8" }) };
    } catch (e) {
      const err = e as { status: number; stdout?: string; stderr?: string };
      return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("writes a parseable artifact carrying the suite it was measured on", () => {
    const d = sweepDir();
    const { code } = run([d, "--write", "--suite", "s", "--suite-version", "1.0.0",
                          "--cases-scored", "12", "--transport", "local", "--trials", "3"], d);
    expect(code).toBe(0);
    const art = JSON.parse(readFileSync(join(d, "eval/noise-floor.json"), "utf8"));
    expect(art.suite).toEqual({ id: "s", version: "1.0.0", cases_scored: 12 });
    expect(art.transport).toBe("local");
    expect(Object.keys(art.models)).toContain("a:1b");
  });

  it("refuses to write without the meta the floor is only valid under", () => {
    // A floor with no suite or transport recorded is not comparable to anything, including a
    // later measurement of the same models.
    const d = sweepDir();
    const { code, out } = run([d, "--write"], d);
    expect(code).toBe(2);
    expect(out).toContain("--suite");
    expect(existsSync(join(d, "eval/noise-floor.json"))).toBe(false);
  });

  it("still reports without --write, and writes nothing", () => {
    const d = sweepDir();
    const { code, out } = run([d], d);
    expect(code).toBe(0);
    expect(out).toContain("Per-case pass rate");
    expect(existsSync(join(d, "eval/noise-floor.json"))).toBe(false);
  });
});
