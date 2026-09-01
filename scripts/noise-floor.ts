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
import { parseRuns, parseCases, caseMatrix, pairsOf } from "./compare-models.js";
import { clusteredPaired } from "../core/src/eval/compare.js";
import { resolvableDelta, STATED_ASSUMPTIONS } from "../core/src/eval/sizing.js";

/**
 * `spread` is max minus min, deliberately.
 *
 * Three trials is far too few for a variance estimate anyone should quote. A range states
 * exactly what was seen and invites no more confidence than that.
 */
/** What a floor is only valid under. Every field required — a default would make a floor
 *  measured on one suite read as though it applied to another. */
export interface NoiseFloorMeta {
  measured_on: string;
  suite: { id: string; version: string; cases_scored: number };
  transport: string;
  trials_per_model: number;
}

export interface ModelMeasurement {
  scores: number[];
  mean: number;
  spread: number;
  seconds: number[];
  tokens_out: Array<number | null>;
  degraded_runs: number;
}

export interface NoiseFloor extends NoiseFloorMeta {
  models: Record<string, ModelMeasurement>;
  pairs: Record<string, { discordant_clusters: number; clusters: number }>;
  cases: Record<string, { rates: Record<string, [number, number] | null>; constant: boolean }>;
  discordance_rate: number;
}

const spreadOf = (xs: number[]): number => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
const meanOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function buildNoiseFloor(runsText: string, casesText: string, meta: NoiseFloorMeta): NoiseFloor {
  const runs = parseRuns(runsText);
  const byModel = parseCases(casesText);
  const names = [...new Set(runs.map((r) => r.model))];

  const models: Record<string, ModelMeasurement> = {};
  for (const name of names) {
    const rows = runs.filter((r) => r.model === name);
    const scores: number[] = rows.map((r) => r.score).filter((s): s is number => s !== null);
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

  const pairs: NoiseFloor["pairs"] = {};
  const rates: number[] = [];
  for (const [a, b] of pairsOf([...byModel.keys()])) {
    const r = clusteredPaired(byModel.get(a) ?? [], byModel.get(b) ?? []);
    pairs[`${a}|${b}`] = { discordant_clusters: r.discordant, clusters: r.clusters };
    if (r.clusters > 0) rates.push(r.discordant / r.clusters);
  }

  /**
   * Zipped against `byModel.keys()`, NOT against `names`.
   *
   * `caseMatrix` builds its `rates` array in the order of the case data; `names` comes from
   * the run data. The two files can disagree — a model that produced runs but no parseable
   * case lines appears in one and not the other — and indexing one array by the other's order
   * would silently attribute every case rate to the wrong model, with every number downstream
   * still looking plausible.
   */
  const caseModels = [...byModel.keys()];
  const cases: NoiseFloor["cases"] = {};
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
export function resolvableFor(
  artifact: { suite: { cases_scored: number }; discordance_rate: number },
): number {
  return resolvableDelta(artifact.suite.cases_scored, {
    alpha: STATED_ASSUMPTIONS.alpha,
    power: STATED_ASSUMPTIONS.power,
    discordanceRate: artifact.discordance_rate,
  });
}
