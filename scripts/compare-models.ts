/**
 * Compare several models on one suite, using the comparator's own statistics.
 *
 *   tsx scripts/compare-models.ts <sweep-dir>                      report only
 *   tsx scripts/compare-models.ts <sweep-dir> --write ...         write eval/noise-floor.json
 *
 * `--write` requires --suite, --suite-version, --cases-scored, --transport and --trials.
 * None are defaulted: a floor is only valid for the configuration it was measured under.
 *
 * ## Why this is not `eval --compare`
 *
 * `--compare` answers "is this prompt configuration better than that one?" and runs both arms
 * itself. This answers "do these models differ at all?", which is a different axis: the arms
 * are separate processes, hours apart, because a 27B model takes twenty minutes per pass.
 *
 * It computes nothing of its own. `clusteredPaired` is the exact test the comparator runs, and
 * `floorDiscordant` / `attainable` / `resolvableDelta` are the rules `check:sizing` prints. A
 * tool that reimplemented the statistics could disagree with the comparator about the same
 * data, and the disagreement would be invisible.
 *
 * ## Trials are clustered, not counted
 *
 * Three trials of fourteen cases are 14 independent units, not 42. Each case is one cluster
 * and its trials become a pass RATE; the sign test runs on the clusters. Counting trials as
 * units would inflate the sample by the trial factor and make every p-value anticonservative
 * — the reason `CaseOutcome.cluster_id` exists.
 *
 * ## Input format
 *
 * A directory holding two line-oriented files, which a sweep script appends to as it goes so
 * a crash halfway still leaves readable data:
 *
 *   runs.txt    RUN|<model>|<trial>|secs=<n>|exit=<n>|<x>/<y> cases · score <s>|tokens <a> in / <b> out
 *   cases.txt   CASE|<model>|<trial>|<case_id>|<pass|FAIL>
 *
 * Both come from the eval runner's TEXT output rather than `--json`, and that is a limitation
 * worth stating: the JSON EvalRun carries `detector_recall` but no per-case array, and the
 * text carries per-case results but no machine-readable recall block. Neither alone has both.
 * So this calls `clusteredPaired` directly and does NOT invoke the comparator's recall
 * equalization — check that every run reported full detector recall before trusting a verdict.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNoiseFloor, resolvableFor } from "./noise-floor.js";
import { clusteredPaired } from "../core/src/eval/compare.js";
import {
  floorDiscordant, attainable, minAttainableP, resolvableDelta, STATED_ASSUMPTIONS,
} from "../core/src/eval/sizing.js";

export interface RunRecord {
  model: string; trial: number; secs: number; exit: number;
  passed: number | null; cases: number | null; score: number | null;
  tokens_in: number | null; tokens_out: number | null;
}

/** One trial of one case. `cluster_id` is what the sign test aggregates on. */
export interface CaseOutcomeRow { case_id: string; cluster_id: string; passed: boolean; }

export interface MatrixRow {
  case_id: string;
  rates: Array<{ passed: number; n: number } | null>;
  constant: boolean;
}

/** Only the two fields the runtime refusal needs, so a partial floor still works. */
export interface FloorForReport { suite: { cases_scored: number }; discordance_rate: number; }

const lines = (text: string, prefix: string): string[][] =>
  text.split(/\r?\n/).filter((l) => l.startsWith(prefix)).map((l) => l.split("|"));

/** One record per run: model, trial, wall time, score. */
export function parseRuns(text: string): RunRecord[] {
  return lines(text, "RUN|").map(([, model, trial, secs, exit, score, tokens]) => {
    const m = (score ?? "").match(/([0-9]+)\/([0-9]+) cases · score ([0-9.]+)/);
    const t = (tokens ?? "").match(/([0-9]+) in \/ ([0-9]+) out/);
    return {
      model,
      trial: Number(trial),
      secs: Number((secs ?? "").replace("secs=", "")),
      // Exit 3 is a DEGRADED run, not a broken one — the noise floor counts those separately,
      // because dropping them would flatter a model that times out.
      exit: Number((exit ?? "").replace("exit=", "")),
      passed: m ? Number(m[1]) : null,
      cases: m ? Number(m[2]) : null,
      score: m ? Number(m[3]) : null,
      tokens_in: t ? Number(t[1]) : null,
      tokens_out: t ? Number(t[2]) : null,
    };
  });
}

/**
 * Per-case outcomes, one `CaseOutcome` per (case, trial), clustered by case.
 *
 * `case_id` carries the trial so two trials of one case are distinct rows; `cluster_id` is the
 * bare case, which is what the sign test aggregates on.
 */
export function parseCases(text: string): Map<string, CaseOutcomeRow[]> {
  const byModel = new Map<string, CaseOutcomeRow[]>();
  for (const parts of lines(text, "CASE|")) {
    const [, model, trial, caseId, verdict] = parts as [string, string, string, string, string];
    const rows = byModel.get(model) ?? [];
    rows.push({ case_id: `${caseId}#${trial}`, cluster_id: caseId, passed: verdict === "pass" });
    byModel.set(model, rows);
  }
  return byModel;
}

/**
 * A case's pass rate per model, and whether every model agrees on it.
 *
 * The most useful column in the report. Ten of `compile-smoke`'s fourteen cases were constant
 * across four models and three trials on 1 September 2026 — nine always passed, one always
 * failed — so the suite's effective width for telling models apart was four cases, not
 * fourteen. Scaling such a suite would mostly buy noise.
 */
export function caseMatrix(byModel: Map<string, CaseOutcomeRow[]>): MatrixRow[] {
  const models = [...byModel.keys()];
  const ids: string[] = [];
  for (const rows of byModel.values()) {
    for (const r of rows) if (!ids.includes(r.cluster_id)) ids.push(r.cluster_id);
  }
  return ids.map((id) => {
    const rates = models.map((m) => {
      const rows = (byModel.get(m) ?? []).filter((r) => r.cluster_id === id);
      return rows.length ? { passed: rows.filter((r) => r.passed).length, n: rows.length } : null;
    });
    const seen = rates
      .filter((r): r is { passed: number; n: number } => r !== null)
      .map((r) => r.passed / r.n);
    return { case_id: id, rates, constant: new Set(seen).size <= 1 };
  });
}

/** Every unordered pair, which is also the multiplicity family the correction divides by. */
export function pairsOf(models: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) out.push([models[i]!, models[j]!]);
  }
  return out;
}

/**
 * The verdict for one pair, with the refusal separated from the null result.
 *
 * `refused` and `inconclusive` are different claims — "we could not have seen anything" versus
 * "we looked and saw nothing" — and collapsing them is the specific move this repository's
 * comparator refuses to make. A pair is refused when its discordant count could not reach the
 * corrected alpha under ANY arrangement of the signs.
 */
export function verdictFor(candidate: CaseOutcomeRow[], baseline: CaseOutcomeRow[], alpha: number) {
  const r = clusteredPaired(candidate, baseline);
  if (!attainable(r.discordant, alpha)) {
    return { ...r, verdict: "refused", best: minAttainableP(r.discordant) };
  }
  return { ...r, verdict: r.p <= alpha ? "significant" : "inconclusive", best: null };
}

export function report(
  runsText: string,
  casesText: string,
  { alpha = 0.05, floor = null }: { alpha?: number; floor?: FloorForReport | null } = {},
): string {
  const runs = parseRuns(runsText);
  const byModel = parseCases(casesText);
  const models = [...byModel.keys()];
  const out: string[] = [];

  out.push("## Runs\n");
  for (const r of runs) {
    out.push(`${r.model.padEnd(24)} t${r.trial}  ${String(r.secs).padStart(5)}s  ` +
      `${r.passed ?? "—"}/${r.cases ?? "—"}  ${r.score === null ? "—" : r.score.toFixed(3)}`);
  }

  out.push("\n## Score stability across trials\n");
  for (const m of models) {
    const v: number[] = runs
      .filter((r) => r.model === m && r.score !== null)
      .map((r) => r.score as number);
    if (v.length === 0) continue;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    out.push(`${m.padEnd(24)} ${v.map((x) => x.toFixed(3)).join(" ").padEnd(20)} ` +
      `mean ${mean.toFixed(3)}  spread ${(Math.max(...v) - Math.min(...v)).toFixed(3)}`);
  }

  const matrix = caseMatrix(byModel);
  const constant = matrix.filter((row) => row.constant).length;
  out.push("\n## Per-case pass rate\n");
  out.push(`${"case".padEnd(36)}${models.map((m) => m.slice(0, 14).padStart(15)).join("")}`);
  for (const row of matrix) {
    const cells = row.rates.map((r) => (r ? `${r.passed}/${r.n}` : "—").padStart(15)).join("");
    out.push(`${row.case_id.padEnd(36)}${cells}${row.constant ? "   (constant)" : ""}`);
  }
  out.push(`\n  ${constant} of ${matrix.length} case(s) are constant across every model — ` +
    "they cannot tell two models apart.");

  const pairs = pairsOf(models);
  const corrected = alpha / Math.max(pairs.length, 1);
  out.push("\n## Pairwise — the comparator's own exact clustered sign test\n");
  out.push(`family of ${pairs.length} · alpha ${alpha} nominal, ${corrected.toFixed(5)} corrected`);
  out.push(`discordant clusters needed: ${floorDiscordant(alpha)} nominal, ` +
    `${floorDiscordant(corrected)} corrected\n`);

  /**
   * The floor catches the error one step earlier than `check:noise` does — at the moment
   * someone reads a number, before they write it into a document. It does not replace the
   * gate: the damage happens when the number reaches prose, and only the gate sees prose.
   */
  const floorPp = floor ? resolvableFor(floor) * 100 : null;
  if (floorPp !== null) {
    out.push(`  recorded floor: a difference below ${floorPp.toFixed(1)} pp is inside the noise\n`);
  }

  /** A model's pass rate over every (case, trial) row it produced. */
  const passRate = (rows: CaseOutcomeRow[]): number =>
    (rows.length ? rows.filter((r) => r.passed).length / rows.length : 0);

  for (const [a, b] of pairs) {
    const rowsA = byModel.get(a) ?? [];
    const rowsB = byModel.get(b) ?? [];
    const v = verdictFor(rowsA, rowsB, corrected);
    const tail = v.best !== null ? ` (best possible p=${v.best.toFixed(4)})` : "";
    const deltaPp = Math.abs(passRate(rowsA) - passRate(rowsB)) * 100;
    const note = floorPp !== null && deltaPp < floorPp ? "  — inside the recorded noise floor" : "";
    out.push(`${a.padEnd(24)} ${b.padEnd(24)} disc ${String(v.discordant).padStart(2)}/` +
      `${v.clusters}  p ${v.p.toFixed(4)}  ${v.verdict}${tail}${note}`);
  }

  out.push(`\n## What ${matrix.length} cases resolve at 80% power: ` +
    `${(resolvableDelta(matrix.length, STATED_ASSUMPTIONS) * 100).toFixed(1)} pp`);
  return out.join("\n");
}

/**
 * Whether this `--write` may proceed.
 *
 * Pure, and taking the three facts rather than reading them, for the reason `flagError` in
 * `run-eval.ts` is pure: a test can ask it about a combination that does not exist on disk,
 * and the refusal is decided in one place instead of three `if (existsSync(...))` blocks.
 *
 * Two different failures, in severity order:
 *
 *   1. MISLABEL — the sweep ran suite X and `--suite` says Y. The measurement is real and the
 *      label is wrong, which is undetectable afterwards: `cases_scored` would be consistent
 *      with the data and inconsistent with the name. `--replace` does not excuse it, because
 *      `--replace` is permission to overwrite a file, not permission to misname one.
 *   2. CLOBBER — an artifact for another suite is already committed. Overwriting it silently
 *      re-points every claim `check:noise` enforces: on 1 September 2026 the committed floor
 *      resolved 42.6 pp over 12 cases, and a 100-case floor resolves 14.8 pp, so the accident
 *      LOOSENS the gate while leaving it green. Recoverable with an explicit flag.
 */
export function writeGuard(opts: {
  suiteFlag: string;
  sweptSuiteId: string | null;
  existingSuiteId: string | null;
  replace: boolean;
}): string | null {
  if (opts.sweptSuiteId !== null && opts.sweptSuiteId !== opts.suiteFlag) {
    return (
      `compare:models --write: the sweep ran "${opts.sweptSuiteId}" but --suite says ` +
      `"${opts.suiteFlag}".\n` +
      "  A floor is only valid for the suite it was measured on. Filing this data under the\n" +
      "  wrong name cannot be detected later — every field would be internally consistent.\n" +
      "  Re-run with the suite the sweep actually used, or sweep the suite you meant."
    );
  }
  if (opts.existingSuiteId !== null && opts.existingSuiteId !== opts.suiteFlag && !opts.replace) {
    return (
      `compare:models --write: eval/noise-floor.json holds a floor for "${opts.existingSuiteId}" ` +
      `and this write is for "${opts.suiteFlag}".\n` +
      "  Overwriting re-points every claim scripts/noise-claims.json pins, without failing:\n" +
      "  a larger suite resolves a SMALLER delta, so the gate would silently admit claims it\n" +
      "  used to refuse. Pass --replace if that is what you mean."
    );
  }
  return null;
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir || dir.startsWith("--")) {
    console.error(
      "usage: tsx scripts/compare-models.ts <sweep-dir>\n" +
      "       tsx scripts/compare-models.ts <sweep-dir> --write --suite ID --suite-version V \\\n" +
      "                                     --cases-scored N --transport T --trials N [--replace]",
    );
    process.exit(2);
  }
  const runsText = readFileSync(join(dir, "runs.txt"), "utf8");
  const casesText = readFileSync(join(dir, "cases.txt"), "utf8");

  if (!process.argv.includes("--write")) {
    // Loaded when it exists so the printed report and  cannot disagree about
    // which differences are inside the noise.
    const floorPath = join(process.cwd(), "eval/noise-floor.json");
    const floor = existsSync(floorPath)
      ? (JSON.parse(readFileSync(floorPath, "utf8")) as FloorForReport)
      : null;
    console.log(report(runsText, casesText, { floor }));
    process.exit(0);
  }

  /**
   * Every field required, none defaulted.
   *
   * A floor is only valid for the suite, transport and trial count it was measured under, and
   * a default would silently produce one that reads as general. `--cases-scored` especially:
   * `compile-smoke` lists fourteen cases but scores twelve on a real transport, and a floor
   * against the wrong denominator is not comparable to one against the right denominator.
   */
  const casesScored = Number(flag("cases-scored"));
  const trials = Number(flag("trials"));
  const meta = {
    measured_on: new Date().toISOString().slice(0, 10),
    suite: { id: flag("suite") ?? "", version: flag("suite-version") ?? "", cases_scored: casesScored },
    transport: flag("transport") ?? "",
    trials_per_model: trials,
  };
  const missing = [
    ["--suite", meta.suite.id !== ""],
    ["--suite-version", meta.suite.version !== ""],
    ["--cases-scored", Number.isInteger(casesScored) && casesScored > 0],
    ["--transport", meta.transport !== ""],
    ["--trials", Number.isInteger(trials) && trials > 0],
  ].filter(([, ok]) => !ok).map(([name]) => name as string);

  if (missing.length > 0) {
    console.error(
      `compare:models --write needs ${missing.join(", ")}.\n` +
      "  A floor is only valid for the suite, transport and trial count it was measured under.",
    );
    process.exit(2);
  }

  /** The suite id the sweep actually ran, via the path it recorded. Null when it recorded none. */
  const sweptSuiteId = ((): string | null => {
    const marker = join(dir, "suite.txt");
    if (!existsSync(marker)) return null;
    const sweptSuitePath = readFileSync(marker, "utf8").trim();
    const swept = JSON.parse(readFileSync(join(process.cwd(), sweptSuitePath), "utf8"));
    return (swept.suite?.suite_id as string | undefined) ?? null;
  })();

  const floorTarget = join(process.cwd(), "eval/noise-floor.json");
  const existingSuiteId = existsSync(floorTarget)
    ? ((JSON.parse(readFileSync(floorTarget, "utf8")).suite?.id as string | undefined) ?? null)
    : null;

  const refusal = writeGuard({
    suiteFlag: meta.suite.id,
    sweptSuiteId,
    existingSuiteId,
    replace: process.argv.includes("--replace"),
  });
  if (refusal !== null) {
    console.error(refusal);
    process.exit(2);
  }

  const artifact = buildNoiseFloor(runsText, casesText, meta);
  writeFileSync(join(process.cwd(), "eval/noise-floor.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `compare:models — wrote eval/noise-floor.json ` +
    `(${Object.keys(artifact.models).length} model(s), discordance ${artifact.discordance_rate}).`,
  );
}
