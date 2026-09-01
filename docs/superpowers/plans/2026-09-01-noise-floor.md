# Noise Floor and Cost Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what a model comparison on this repository's suites can resolve, and make a written claim that exceeds it fail the build.

**Architecture:** A sweep writes line-oriented run data; a pure builder turns that into a committed measurement artifact; a claim checker validates prose in tracked documents against the artifact. The checker reads only committed files, so it runs in CI without a GPU and reports "not armed" until a measurement exists.

**Tech Stack:** Node 24 ESM (`.mjs` scripts, `.ts` for typed Core), vitest (project `contracts` for `test/*.test.ts`), npm workspaces. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-noise-floor-design.md`

## Global Constraints

- **Zero runtime dependencies.** `contracts`, `core`, `application`, the adapters and `shells/cli` ship nothing in `dependencies` (ADR-0012). Nothing in this plan adds a package.
- **Never reimplement the statistics.** `resolvableDelta`, `requiredPairedSize`, `floorDiscordant`, `attainable`, `minAttainableP` and `STATED_ASSUMPTIONS` come from `core/src/eval/sizing.ts`. A second implementation could disagree with `check:sizing` about the same numbers, invisibly.
- **Measurements, never verdicts.** `eval/noise-floor.json` must not record that one model beat another.
- **`cases_scored` is 12, not 14** for `compile-smoke` on a real transport — two cases are excluded by `partitionByTransport` in `core/src/eval/transport-validity.ts`.
- **Absent and broken are different states.** A missing artifact is "not armed" (exit 0); a malformed one is fatal (exit 2). They must never collapse.
- **Stage explicit paths.** Never `git add -A` or `git add .` in this repository.
- **Every `.mjs` script that imports Core TypeScript runs under `tsx`, not bare `node`.** `scripts/compare-models.mjs` already does; the npm script is `tsx scripts/compare-models.mjs`.
- **Exit codes match `check:counts`:** 0 pass or not-armed, 1 a failed claim, 2 a broken input.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/noise-floor.mjs` | **Create.** Pure builder: sweep text → artifact object. Plus `resolvableFor(artifact)`, the one place the artifact is turned into a resolvable delta. |
| `scripts/compare-models.mjs` | **Modify.** Add `--write` (produces the artifact) and the runtime refusal. Stays a reporter; the building lives next door. |
| `scripts/check-noise.mjs` | **Create.** The gate. Reads artifact + claims, validates, never runs a model. |
| `scripts/noise-claims.json` | **Create.** Claims pinned to documents, `bound` and `forbidden` kinds. |
| `scripts/sweep-models.mjs` | **Create.** Runs N trials per model, appends as it goes. |
| `eval/noise-floor.json` | **Create (Task 6).** The committed measurement. |
| `test/noise-floor.test.ts` | **Create.** Builder and `resolvableFor`. |
| `test/check-noise.test.ts` | **Create.** Gate, both kinds, both directions. |
| `test/sweep-models.test.ts` | **Create.** Runner's argument handling and append behaviour. |

`noise-floor.mjs` is separate from `compare-models.mjs` because they have different jobs: one derives a durable artifact, the other renders a transient report. Splitting them keeps each testable without the other, and keeps `compare-models.mjs` from growing a second responsibility.

---

### Task 1: The artifact builder

**Files:**
- Create: `scripts/noise-floor.mjs`
- Test: `test/noise-floor.test.ts`

**Interfaces:**
- Consumes: `parseRuns`, `parseCases`, `caseMatrix`, `pairsOf` from `scripts/compare-models.mjs`; `clusteredPaired` from `core/src/eval/compare.js`; `resolvableDelta`, `STATED_ASSUMPTIONS` from `core/src/eval/sizing.js`.
- Produces: `buildNoiseFloor(runsText, casesText, meta) => object` and `resolvableFor(artifact) => number` (a fraction, not percentage points).

- [ ] **Step 1: Write the failing test**

```typescript
// test/noise-floor.test.ts
import { describe, it, expect } from "vitest";
import { buildNoiseFloor, resolvableFor } from "../scripts/noise-floor.mjs";

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

const META = { measured_on: "2026-09-01", suite: { id: "s", version: "1.0.0", cases_scored: 12 }, transport: "local", trials_per_model: 3 };

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
    // The artifact stores measurements only. A stored verdict becomes something people
    // cite instead of re-deriving, and sub-project 2 needs a rate, not a conclusion.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/noise-floor.test.ts --project contracts`
Expected: FAIL — `Cannot find module '../scripts/noise-floor.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
#!/usr/bin/env node
/**
 * The noise floor artifact: what a comparison on this suite could resolve, measured.
 *
 * Pure. Takes the sweep's text and returns an object; the caller writes the file. That split
 * is what lets the whole shape be tested without a GPU, and the measurement it describes cost
 * ninety minutes of one.
 *
 * MEASUREMENTS ONLY, NEVER VERDICTS. The artifact must not record that one model beat another.
 * A stored verdict becomes the thing people cite instead of re-deriving, and the sub-project
 * that follows this one needs a discordance rate, not a frozen conclusion.
 */
import { parseRuns, parseCases, caseMatrix, pairsOf } from "./compare-models.mjs";
import { clusteredPaired } from "../core/src/eval/compare.js";
import { resolvableDelta, STATED_ASSUMPTIONS } from "../core/src/eval/sizing.js";

/**
 * `spread` is max minus min, deliberately.
 *
 * Three trials is far too few for a variance estimate anyone should quote. A range states
 * exactly what was seen and invites no more confidence than that.
 */
const spreadOf = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function buildNoiseFloor(runsText, casesText, meta) {
  const runs = parseRuns(runsText);
  const byModel = parseCases(casesText);
  const names = [...new Set(runs.map((r) => r.model))];

  const models = {};
  for (const name of names) {
    const rows = runs.filter((r) => r.model === name);
    const scores = rows.map((r) => r.score).filter((s) => s !== null);
    models[name] = {
      scores,
      mean: Number(meanOf(scores).toFixed(4)),
      spread: Number(spreadOf(scores).toFixed(4)),
      seconds: rows.map((r) => r.secs),
      tokens_out: rows.map((r) => r.tokens_out),
      // exit 3 is a degraded run. Counted, never dropped: dropping them would flatter a
      // model that times out, which is exactly the operational signal wanted.
      degraded_runs: rows.filter((r) => r.exit === 3).length,
    };
  }

  const pairs = {};
  const rates = [];
  for (const [a, b] of pairsOf([...byModel.keys()])) {
    const r = clusteredPaired(byModel.get(a), byModel.get(b));
    pairs[`${a}|${b}`] = { discordant_clusters: r.discordant, clusters: r.clusters };
    if (r.clusters > 0) rates.push(r.discordant / r.clusters);
  }

  /**
   * Zipped against `byModel.keys()`, NOT against `names`.
   *
   * `caseMatrix` builds its `rates` array in the order of the case data; `names` comes from
   * the run data. The two files can disagree — a model that produced runs but no parseable
   * case lines appears in one and not the other — and indexing one array by the other's order
   * would silently attribute every case rate to the wrong model.
   */
  const caseModels = [...byModel.keys()];
  const cases = {};
  for (const row of caseMatrix(byModel)) {
    cases[row.case_id] = {
      rates: Object.fromEntries(
        caseModels.map((n, i) => [n, row.rates[i] ? [row.rates[i].passed, row.rates[i].n] : null]),
      ),
      constant: row.constant,
    };
  }

  return {
    measured_on: meta.measured_on,
    suite: meta.suite,
    transport: meta.transport,
    trials_per_model: meta.trials_per_model,
    models,
    pairs,
    cases,
    // The mean of the per-pair rates. Per-pair counts are kept above so this can be
    // re-derived and a lopsided pair stays visible rather than averaged away.
    discordance_rate: Number(meanOf(rates).toFixed(4)),
  };
}

/**
 * The smallest difference this measurement could have resolved, as a fraction.
 *
 * The one place an artifact becomes a threshold, so the gate and any report agree. Uses the
 * repository's own `resolvableDelta` with the MEASURED discordance rate rather than
 * `STATED_ASSUMPTIONS`' 0.5 — substituting the assumption is what this artifact exists to stop.
 */
export function resolvableFor(artifact) {
  return resolvableDelta(artifact.suite.cases_scored, {
    alpha: STATED_ASSUMPTIONS.alpha,
    power: STATED_ASSUMPTIONS.power,
    discordanceRate: artifact.discordance_rate,
  });
}
```

`parseRuns` must supply `exit` and `tokens_out`, which it does not yet. Extend it in the same task:

```javascript
// scripts/compare-models.mjs — inside parseRuns' map callback
export function parseRuns(text) {
  return lines(text, "RUN|").map(([, model, trial, secs, exit, score, tokens]) => {
    const m = (score ?? "").match(/([0-9]+)\/([0-9]+) cases · score ([0-9.]+)/);
    const t = (tokens ?? "").match(/([0-9]+) in \/ ([0-9]+) out/);
    return {
      model,
      trial: Number(trial),
      secs: Number((secs ?? "").replace("secs=", "")),
      // Exit 3 is a degraded run, not a broken one — the artifact counts them separately.
      exit: Number((exit ?? "").replace("exit=", "")),
      passed: m ? Number(m[1]) : null,
      cases: m ? Number(m[2]) : null,
      score: m ? Number(m[3]) : null,
      tokens_in: t ? Number(t[1]) : null,
      tokens_out: t ? Number(t[2]) : null,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/noise-floor.test.ts test/compare-models.test.ts --project contracts`
Expected: PASS, both files. The existing `compare-models` tests must still pass — `parseRuns` gained fields but changed none.

- [ ] **Step 5: Commit**

```bash
git add scripts/noise-floor.mjs scripts/compare-models.mjs test/noise-floor.test.ts
git commit -m "scripts: build a noise floor artifact from a sweep"
```

---

### Task 2: Write the artifact from the CLI

**Files:**
- Modify: `scripts/compare-models.mjs` (CLI entry block at end of file)
- Test: `test/noise-floor.test.ts` (append)

**Interfaces:**
- Consumes: `buildNoiseFloor` from Task 1.
- Produces: `compare:models <dir> --write` writing `eval/noise-floor.json`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/noise-floor.test.ts — append
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("compare:models --write", () => {
  const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const SCRIPT = join(process.cwd(), "scripts/compare-models.mjs");
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
    // A floor with no suite or transport recorded is not comparable to anything, including
    // a later measurement of the same models.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/noise-floor.test.ts --project contracts`
Expected: FAIL — the artifact file is never written; `--write` is not a flag yet.

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/compare-models.mjs — replace the CLI entry block at the end of the file
import { writeFileSync } from "node:fs";
import { buildNoiseFloor } from "./noise-floor.mjs";

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir || dir.startsWith("--")) {
    console.error("usage: node scripts/compare-models.mjs <sweep-dir> [--write --suite ID --suite-version V --cases-scored N --transport T --trials N]");
    process.exit(2);
  }
  const runsText = readFileSync(join(dir, "runs.txt"), "utf8");
  const casesText = readFileSync(join(dir, "cases.txt"), "utf8");

  if (!process.argv.includes("--write")) {
    console.log(report(runsText, casesText));
    process.exit(0);
  }

  /**
   * Every field is required, none defaulted.
   *
   * A floor is only valid for the suite, transport and trial count it was measured under, and
   * a default would silently produce a floor that reads as general. `cases_scored` especially:
   * `compile-smoke` lists fourteen cases but scores twelve on a real transport, and a floor
   * against the wrong denominator is not comparable to one against the right denominator.
   */
  const meta = {
    measured_on: new Date().toISOString().slice(0, 10),
    suite: { id: flag("suite"), version: flag("suite-version"), cases_scored: Number(flag("cases-scored")) },
    transport: flag("transport"),
    trials_per_model: Number(flag("trials")),
  };
  const missing = [
    ["--suite", meta.suite.id], ["--suite-version", meta.suite.version],
    ["--cases-scored", Number.isInteger(meta.suite.cases_scored) ? "ok" : undefined],
    ["--transport", meta.transport], ["--trials", Number.isInteger(meta.trials_per_model) ? "ok" : undefined],
  ].filter(([, v]) => v === undefined || v === "" || Number.isNaN(v)).map(([k]) => k);

  if (missing.length > 0) {
    console.error(`compare:models --write needs ${missing.join(", ")}.\n` +
      "  A floor is only valid for the suite, transport and trial count it was measured under.");
    process.exit(2);
  }

  const artifact = buildNoiseFloor(runsText, casesText, meta);
  writeFileSync(join(process.cwd(), "eval/noise-floor.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`compare:models — wrote eval/noise-floor.json (${Object.keys(artifact.models).length} model(s), ` +
    `discordance ${artifact.discordance_rate}).`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/noise-floor.test.ts --project contracts`
Expected: PASS, all cases in both describe blocks.

- [ ] **Step 5: Commit**

```bash
git add scripts/compare-models.mjs test/noise-floor.test.ts
git commit -m "scripts: write the noise floor artifact from compare:models --write"
```

---

### Task 3: The claim-checking gate

**Files:**
- Create: `scripts/check-noise.mjs`, `scripts/noise-claims.json`
- Test: `test/check-noise.test.ts`

**Interfaces:**
- Consumes: `resolvableFor` from Task 1.
- Produces: `checkNoise(root) => { ok, fatal, fatalCode, failures, armed, claims }`, and exit codes 0 / 1 / 2 from `main`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/check-noise.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNoise } from "../scripts/check-noise.mjs";

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

/** A floor whose 12 cases at discordance 0.238 resolve about 39.5 pp. */
const FLOOR = {
  measured_on: "2026-09-01",
  suite: { id: "compile-smoke", version: "2.0.0", cases_scored: 12 },
  transport: "local", trials_per_model: 3,
  models: {}, pairs: {}, cases: {}, discordance_rate: 0.238,
};

function plant(claims: unknown[], floor: unknown = FLOOR, doc = "The gap was 45 pp better here.") {
  const root = mkdtempSync(join(tmpdir(), "cn-"));
  temps.push(root);
  mkdirSync(join(root, "eval"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "Documentation"), { recursive: true });
  if (floor !== null) writeFileSync(join(root, "eval/noise-floor.json"), JSON.stringify(floor));
  writeFileSync(join(root, "scripts/noise-claims.json"), JSON.stringify({ claims }));
  writeFileSync(join(root, "Documentation/PROVIDERS.md"), doc);
  return root;
}

const bound = { kind: "bound", document: "Documentation/PROVIDERS.md", pattern: "([\\d.]+) pp better", reason: "r" };
const forbidden = { kind: "forbidden", document: "Documentation/PROVIDERS.md", pattern: "outperforms", reason: "r" };

describe("check-noise — not armed", () => {
  it("passes and says so when no measurement exists", () => {
    // CI's permanent state. A guard with zero coverage that prints OK is worse than no guard,
    // so it reports coverage honestly instead — the shape check:fingerprint established.
    const r = checkNoise(plant([bound], null));
    expect(r.ok).toBe(true);
    expect(r.armed).toBe(false);
  });

  it("treats a malformed artifact as fatal, never as not armed", () => {
    // Absent and broken are different states and must not collapse.
    const root = plant([bound]);
    writeFileSync(join(root, "eval/noise-floor.json"), "{not json");
    expect(checkNoise(root).fatalCode).toBe(2);
  });
});

describe("check-noise — bound claims", () => {
  it("passes a claim larger than the floor can resolve", () => {
    const r = checkNoise(plant([bound], FLOOR, "The gap was 45 pp better here."));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails a claim inside the noise, naming both numbers", () => {
    const r = checkNoise(plant([bound], FLOOR, "The gap was 6 pp better here."));
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe("below-floor");
    expect(JSON.stringify(r.failures[0])).toContain("6");
    expect(JSON.stringify(r.failures[0])).toContain("39.5");
  });

  it("fails a bound pattern that matches nothing — a pin cannot outlive its prose", () => {
    const r = checkNoise(plant([bound], FLOOR, "No numbers here at all."));
    expect(r.failures[0].kind).toBe("stale");
  });

  it("requires EVERY match to clear the floor, not just the first", () => {
    const r = checkNoise(plant([bound], FLOOR, "45 pp better, and also 3 pp better."));
    expect(r.ok).toBe(false);
  });
});

describe("check-noise — forbidden claims", () => {
  it("fails when the forbidden phrasing is present", () => {
    const r = checkNoise(plant([forbidden], FLOOR, "phi4-mini outperforms gpt-oss."));
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe("forbidden");
  });

  it("PASSES when it matches nothing — absence is success, not staleness", () => {
    // The half that inverts. A forbidden entry guards against prose that should never appear,
    // so no match is the satisfied state; treating it as stale would make the rule unusable.
    const r = checkNoise(plant([forbidden], FLOOR, "Nothing controversial here."));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe("check-noise — input validation", () => {
  it("is fatal on an entry with no kind, rather than guessing a direction", () => {
    const r = checkNoise(plant([{ document: "Documentation/PROVIDERS.md", pattern: "x", reason: "r" }]));
    expect(r.fatalCode).toBe(2);
  });

  it("is fatal on an unreadable claims file", () => {
    const root = plant([bound]);
    writeFileSync(join(root, "scripts/noise-claims.json"), "{oops");
    expect(checkNoise(root).fatalCode).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/check-noise.test.ts --project contracts`
Expected: FAIL — `Cannot find module '../scripts/check-noise.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
#!/usr/bin/env node
/**
 * The gate: a written model comparison may not claim a difference the instrument cannot see.
 *
 * Checks CLAIMS, not models. Both the floor and the prose it guards are committed files, so
 * this is file-vs-file consistency: no GPU, no daemon, no network. It runs in CI, where it
 * will report "not armed" forever, because CI can validate a measurement but never produce one.
 *
 * Two entry kinds, and they invert each other:
 *   bound      — the captured number must be >= what the suite resolves. Matching NOTHING is
 *                stale: the pin has outlived the prose it guarded.
 *   forbidden  — an ordering with no magnitude. Matching ANYTHING fails; matching nothing is
 *                the satisfied state, not staleness.
 *
 * `kind` is required rather than defaulted, because one rule cannot mean both directions and a
 * default would silently pick one.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvableFor } from "./noise-floor.mjs";

const FLOOR = "eval/noise-floor.json";
const CLAIMS = "scripts/noise-claims.json";

export function checkNoise(root = process.cwd()) {
  const fail = (code, message) => ({
    ok: false, fatalCode: code, fatal: message, failures: [], armed: false, claims: 0,
  });

  let claims;
  try {
    claims = JSON.parse(readFileSync(join(root, CLAIMS), "utf8")).claims;
  } catch (err) {
    return fail(2, `${CLAIMS} is unreadable: ${err.message}`);
  }
  if (!Array.isArray(claims)) return fail(2, `${CLAIMS} has no claims array.`);

  for (const c of claims) {
    if (c.kind !== "bound" && c.kind !== "forbidden") {
      return fail(2, `claim for ${c.document} has kind ${JSON.stringify(c.kind)}; expected "bound" or "forbidden".`);
    }
  }

  const floorPath = join(root, FLOOR);
  if (!existsSync(floorPath)) {
    return { ok: true, fatalCode: null, fatal: null, failures: [], armed: false, claims: claims.length };
  }

  let floor;
  try {
    floor = JSON.parse(readFileSync(floorPath, "utf8"));
  } catch (err) {
    return fail(2, `${FLOOR} exists but is not valid JSON: ${err.message}. Absent and broken are different states.`);
  }

  let resolvablePp;
  try {
    resolvablePp = resolvableFor(floor) * 100;
  } catch (err) {
    return fail(2, `${FLOOR} cannot yield a resolvable delta: ${err.message}`);
  }

  const failures = [];
  for (const c of claims) {
    let text;
    try {
      text = readFileSync(join(root, c.document), "utf8").replace(/\r\n/g, "\n");
    } catch {
      failures.push({ kind: "unreadable", document: c.document, detail: "pinned document does not exist" });
      continue;
    }
    const matches = [...text.matchAll(new RegExp(c.pattern, "g"))];

    if (c.kind === "forbidden") {
      for (const m of matches) {
        failures.push({
          kind: "forbidden", document: c.document, matched: m[0],
          detail: `an ordering with no magnitude. ${c.reason}`,
        });
      }
      continue;
    }

    if (matches.length === 0) {
      failures.push({
        kind: "stale", document: c.document, pattern: c.pattern,
        detail: "pattern matches nothing. The sentence it guarded is gone — delete the pin or restore the claim.",
      });
      continue;
    }
    // EVERY match, not just the first: one document can state the same comparison twice and
    // be wrong about only the second.
    for (const m of matches) {
      const claimed = Number(m[1]);
      if (!Number.isFinite(claimed)) {
        failures.push({ kind: "unparseable", document: c.document, matched: m[0], detail: "captured group is not a number" });
      } else if (claimed < resolvablePp) {
        failures.push({
          kind: "below-floor", document: c.document, claimed,
          resolvable: Number(resolvablePp.toFixed(1)),
          detail: `claims ${claimed} pp; this suite resolves ${resolvablePp.toFixed(1)} pp. ${c.reason}`,
        });
      }
    }
  }

  return { ok: failures.length === 0, fatalCode: null, fatal: null, failures, armed: true, claims: claims.length };
}

function main() {
  const { ok, fatal, fatalCode, failures, armed, claims } = checkNoise();
  if (fatal) {
    console.error(`check:noise: ${fatal}`);
    return fatalCode;
  }
  if (!armed) {
    console.log(`check:noise — not armed. ${claims} claim(s) pinned, no ${FLOOR} to check them against.`);
    console.log("  A measurement needs a machine with models on it, which CI is not. The claims\n" +
                "  are still parsed, so a malformed pin fails here rather than on someone's laptop.");
    return 0;
  }
  if (ok) {
    console.log(`check:noise — OK. ${claims} claim(s) checked against ${FLOOR}.`);
    return 0;
  }
  console.error(`check:noise — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f.kind.toUpperCase()} ${f.document}\n    ${f.detail}\n`);
  console.error("A difference smaller than the instrument can resolve is not a finding.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
```

Seed `scripts/noise-claims.json` with the forbidden entry only — no document yet states a delta, and a `bound` entry with nothing to match would be stale on its first run:

```json
{
  "_comment": [
    "Claims about model differences, pinned to the documents that make them.",
    "",
    "Mirrors scripts/counted-claims.json, with one difference: counted-claims checks",
    "EQUALITY against a resolver, this checks a BOUND against eval/noise-floor.json.",
    "",
    "kind: bound      the captured number is a claimed difference in percentage points and",
    "                 must be >= what the suite can resolve. Matching nothing is stale.",
    "kind: forbidden  an ordering with no magnitude. Matching anything fails; matching",
    "                 nothing is success. State the size or do not state the claim."
  ],
  "claims": [
    {
      "kind": "forbidden",
      "document": "Documentation/PROVIDERS.md",
      "pattern": "(outperforms|is better than|beats) `?[a-z0-9.:-]+`?",
      "reason": "An ordering with no magnitude. Nothing to bound, and the artifact stores no verdict to validate it against — whether the instrument could have seen a difference depends entirely on its size."
    }
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/check-noise.test.ts --project contracts`
Expected: PASS, all 10 cases.

- [ ] **Step 5: Mutation-prove the bound comparison**

Change `claimed < resolvablePp` to `false` in `scripts/check-noise.mjs`, then:

Run: `npx vitest run test/check-noise.test.ts --project contracts`
Expected: FAIL on "fails a claim inside the noise" and "requires EVERY match", and **PASS** on every not-armed and forbidden case. Restore the line and re-run to confirm green.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-noise.mjs scripts/noise-claims.json test/check-noise.test.ts
git commit -m "scripts: refuse a written model difference the instrument cannot resolve"
```

---

### Task 4: Runtime refusal in the comparison report

**Files:**
- Modify: `scripts/compare-models.mjs` (`report`)
- Test: `test/compare-models.test.ts` (append)

**Interfaces:**
- Consumes: `resolvableFor` from Task 1.
- Produces: `report(runsText, casesText, { alpha, floor })` — `floor` optional; when given, verdicts inside it are annotated.

- [ ] **Step 1: Write the failing test**

```typescript
// test/compare-models.test.ts — append
describe("report — runtime refusal against a recorded floor", () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compare-models.test.ts --project contracts`
Expected: FAIL — "inside the recorded noise floor" appears nowhere.

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/compare-models.mjs — in report(), replace the signature and the pairwise loop's push
export function report(runsText, casesText, { alpha = 0.05, floor = null } = {}) {
  // ... unchanged up to the pairwise section ...

  /**
   * The floor catches the error one step earlier than `check:noise` does — at the moment
   * someone reads a number, before they write it into a document. It does not replace the
   * gate: the damage happens when the number reaches prose, and only the gate sees prose.
   */
  const floorPp = floor ? resolvableFor(floor) * 100 : null;
  if (floorPp !== null) {
    out.push(`  recorded floor: differences below ${floorPp.toFixed(1)} pp are inside the noise\n`);
  }

  for (const [a, b] of pairs) {
    const v = verdictFor(byModel.get(a), byModel.get(b), corrected);
    const meanOf = (rows) => rows.filter((r) => r.passed).length / Math.max(rows.length, 1);
    const deltaPp = Math.abs(meanOf(byModel.get(a)) - meanOf(byModel.get(b))) * 100;
    const inside = floorPp !== null && deltaPp < floorPp;
    const tail = v.verdict === "refused" ? ` (best possible p=${v.best.toFixed(4)})` : "";
    const note = inside ? "  — inside the recorded noise floor" : "";
    out.push(`${a.padEnd(24)} ${b.padEnd(24)} disc ${String(v.discordant).padStart(2)}/` +
      `${v.clusters}  p ${v.p.toFixed(4)}  ${v.verdict}${tail}${note}`);
  }
```

Add the import at the top of `scripts/compare-models.mjs`:

```javascript
import { resolvableFor } from "./noise-floor.mjs";
```

The CLI entry loads the floor when one exists, so the printed report matches what the gate would say:

```javascript
  // in the non---write branch of the CLI block
  const floorPath = join(process.cwd(), "eval/noise-floor.json");
  const floor = existsSync(floorPath) ? JSON.parse(readFileSync(floorPath, "utf8")) : null;
  console.log(report(runsText, casesText, { floor }));
```

Add `existsSync` to the `node:fs` import in that file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/compare-models.test.ts --project contracts`
Expected: PASS, including the 12 pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/compare-models.mjs test/compare-models.test.ts
git commit -m "scripts: flag a comparison sitting inside the recorded noise floor"
```

---

### Task 5: The sweep runner

**Files:**
- Create: `scripts/sweep-models.mjs`
- Test: `test/sweep-models.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseSweepArgs(argv) => { models, trials, outDir, suiteArgs }` and `formatRunLine(model, trial, secs, exit, scoreLine, tokenLine) => string`, plus the CLI writing `runs.txt` / `cases.txt`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/sweep-models.test.ts
import { describe, it, expect } from "vitest";
import { parseSweepArgs, formatRunLine, extractCaseLines } from "../scripts/sweep-models.mjs";

describe("parseSweepArgs", () => {
  it("splits a comma-separated model list", () => {
    const a = parseSweepArgs(["--models", "a:1b,b:2b", "--trials", "3", "--out", "d"]);
    expect(a.models).toEqual(["a:1b", "b:2b"]);
    expect(a.trials).toBe(3);
    expect(a.outDir).toBe("d");
  });

  it("refuses a trials count that is not a positive integer", () => {
    // One trial gives no variance at all, which is the measurement's whole point — but zero
    // or a fraction is an operator error, not a choice.
    expect(() => parseSweepArgs(["--models", "a", "--trials", "0", "--out", "d"])).toThrow(/positive/);
    expect(() => parseSweepArgs(["--models", "a", "--trials", "2.5", "--out", "d"])).toThrow(/positive/);
  });

  it("refuses an empty model list rather than sweeping nothing", () => {
    expect(() => parseSweepArgs(["--models", "", "--trials", "3", "--out", "d"])).toThrow(/--models/);
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
    const line = formatRunLine("a:1b", 1, 900, 124, "", "");
    expect(line).toBe("RUN|a:1b|1|secs=900|exit=124||");
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sweep-models.test.ts --project contracts`
Expected: FAIL — `Cannot find module '../scripts/sweep-models.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
#!/usr/bin/env node
/**
 * Run N trials of the eval suite per model, appending as it goes.
 *
 *   npm run sweep:models -- --models phi4-mini:latest,gemma4:e4b --trials 3 --out .sweep
 *
 * APPEND-ONLY, one line per completed run. The ad-hoc version of this was killed twice
 * mid-sweep and its partial data was still usable, which is the property worth keeping: a
 * twenty-minute model failing must not discard the three that already succeeded.
 *
 * Writes the two files `compare-models.mjs` reads. The format is documented there.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseSweepArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const models = (value("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("sweep: --models needs a comma-separated list of model names.");

  const raw = value("trials") ?? "3";
  const trials = Number(raw);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`sweep: --trials must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  const outDir = value("out") ?? ".sweep";
  return { models, trials, outDir };
}

/** Exactly the shape `parseRuns` reads. Built here so one format has one definition. */
export function formatRunLine(model, trial, secs, exit, scoreLine, tokenLine) {
  const score = (scoreLine ?? "").trim().replace(/\s+/g, " ");
  const tokens = (tokenLine ?? "").trim().replace(/\s+/g, " ");
  return `RUN|${model}|${trial}|secs=${secs}|exit=${exit}|${score}|${tokens}`;
}

export function extractCaseLines(model, trial, output) {
  return output.split(/\r?\n/)
    .map((l) => l.match(/^\s{2}(pass|FAIL)\s{2}(\S+)/))
    .filter((m) => m !== null)
    .map((m) => `CASE|${model}|${trial}|${m[2]}|${m[1]}`);
}

function main(argv) {
  let args;
  try {
    args = parseSweepArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  mkdirSync(args.outDir, { recursive: true });
  const runsPath = join(args.outDir, "runs.txt");
  const casesPath = join(args.outDir, "cases.txt");
  writeFileSync(runsPath, "");
  writeFileSync(casesPath, "");

  for (const model of args.models) {
    for (let trial = 1; trial <= args.trials; trial++) {
      const started = Date.now();
      const r = spawnSync(process.execPath, [
        "node_modules/tsx/dist/cli.mjs", "scripts/run-eval.ts", "--local", "--model", model,
      ], { encoding: "utf8" });
      const secs = Math.round((Date.now() - started) / 1000);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const score = out.split(/\r?\n/).find((l) => /cases · score/.test(l)) ?? "";
      const tokens = out.split(/\r?\n/).find((l) => /tokens\s+\d+ in \/ \d+ out/.test(l)) ?? "";

      appendFileSync(runsPath, `${formatRunLine(model, trial, secs, r.status ?? -1, score, tokens)}\n`);
      const caseLines = extractCaseLines(model, trial, out);
      if (caseLines.length > 0) appendFileSync(casesPath, `${caseLines.join("\n")}\n`);
      console.log(`sweep: ${model} trial ${trial} — ${secs}s, exit ${r.status}, ${caseLines.length} case(s)`);
    }
  }
  console.log(`sweep: done. ${runsPath} and ${casesPath} are ready for compare:models.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sweep-models.test.ts --project contracts`
Expected: PASS, all 6 cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/sweep-models.mjs test/sweep-models.test.ts
git commit -m "scripts: sweep N trials per model, appending as it goes"
```

---

### Task 6: Wire it into the build

**Files:**
- Modify: `package.json` (scripts), `Documentation/IMPLEMENTATION_PLAN.md` (commands list), `spec/truth-boundary.json` (new entry), `scripts/check-truth-boundary.ts` (new probe), `build-hash.json` (regenerated)
- Test: `test/truth-boundary.test.ts` (the existing bijection tests cover the new probe)

**Interfaces:**
- Consumes: `checkNoise` from Task 3.
- Produces: `npm run check:noise`, `npm run sweep:models`, and a `noiseFloor` probe named by a truth-boundary entry.

- [ ] **Step 1: Add the npm scripts and declare them**

```json
"check:noise": "tsx scripts/check-noise.mjs",
"sweep:models": "node scripts/sweep-models.mjs",
```

`check:noise` runs under `tsx` because it imports Core TypeScript through `noise-floor.mjs`. `sweep:models` does not import Core, so plain `node` is correct and cheaper.

Add both to the `commands` array in `Documentation/IMPLEMENTATION_PLAN.md` — `check:plan` fails on any npm script the plan does not declare. Add `check:noise` to the `verify` chain, immediately after `check:sizing`, since it consumes the same sizing rules.

- [ ] **Step 2: Run the checks to see them fail**

Run: `npm run check:plan`
Expected: FAIL until both scripts are in the `commands` array. Then run `npm run check:noise` — expected: `not armed`, exit 0.

- [ ] **Step 3: Add the truth-boundary probe and entry**

The probe reads only committed files, so it derives the same values on every machine:

```typescript
// scripts/check-truth-boundary.ts — add to PROBES
  /**
   * What a model comparison here can resolve, and whether one has been measured at all.
   *
   * Every value is read from committed files, so this is identical on every checkout. It is
   * pinned at zero and false until a measurement is committed, which makes arming it a
   * deliberate act rather than something that happens on whichever laptop ran a sweep.
   */
  noiseFloor(root) {
    const path = join(root, "eval/noise-floor.json");
    if (!existsSync(path)) {
      return { floor_measured: false, models_measured: 0, cases_scored: 0 };
    }
    const floor = readJson(root, "eval/noise-floor.json");
    return {
      floor_measured: true,
      models_measured: Object.keys(floor.models ?? {}).length,
      cases_scored: floor.suite?.cases_scored ?? 0,
    };
  },
```

Add `existsSync` to the `node:fs` import in that file. The matching entry:

```json
{
  "id": "model-comparisons-are-unresolvable-here",
  "title": "No suite here can separate two models",
  "probe": "noiseFloor",
  "establishes": "That the question has been asked precisely. `check:noise` refuses a written claim of a difference smaller than the instrument can resolve, and `compare:models` reports refusals using the comparator's own exact clustered sign test rather than a second implementation.",
  "does_not_establish": "That any two models here have been shown to differ, or to be the same. Measured on 1 September 2026 across four local models and three trials each, every pairwise comparison on compile-smoke came back refused: the largest discordance was 5 clusters against a Bonferroni-corrected floor of 8, so no arrangement of the signs could have reached significance. Within-model spread was 0.071 to 0.143, at least as large as the largest gap between models. A refusal is not a null result — it says the instrument could not have seen a difference, not that there is none.",
  "expect": { "floor_measured": false, "models_measured": 0, "cases_scored": 0 },
  "crossed_when": "A measurement is committed: `floor_measured` goes true and the other two become non-zero. At that moment every claim pinned in scripts/noise-claims.json starts being checked against a real number rather than parsed and passed over, and the sentences those pins guard need re-reading.",
  "evidence": ["scripts/check-noise.mjs", "scripts/noise-claims.json", "scripts/compare-models.mjs", "docs/superpowers/specs/2026-09-01-noise-floor-design.md"]
}
```

- [ ] **Step 4: Regenerate and verify**

Run: `npm run docs:truth && npm run build:hash && npm run verify`
Expected: PASS. `check:truth` reports 10 boundaries; `check:noise` reports not armed. The truth-boundary bijection tests in `test/truth-boundary.test.ts` pass without change, because the new probe is named by the new entry.

- [ ] **Step 5: Commit**

```bash
git add package.json Documentation/IMPLEMENTATION_PLAN.md spec/truth-boundary.json Documentation/TRUTH_BOUNDARY.md scripts/check-truth-boundary.ts build-hash.json
git commit -m "wire check:noise and sweep:models into the build"
```

---

## Deliberately out of scope

- **Committing a real `eval/noise-floor.json`.** It needs a machine with models on it and roughly ninety minutes. The truth-boundary entry is pinned at `floor_measured: false` precisely so arming it is a separate, deliberate commit.
- **New eval cases.** Sub-project 2.
- **Any judge.** Sub-project 3.
- **Adding `--local` to `run-adversarial.ts`.** 9 of its 11 cases assert a gate fires and would invert; that is a known landmine, recorded in `core/src/eval/transport-validity.ts`.
