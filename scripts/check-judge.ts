/**
 * check:judge — re-derives the judge calibration from committed artifacts, no network.
 *
 * Mirrors scripts/check-noise.ts's "not armed" discipline: absent artifact is not a failure
 * (exit 0, printed plainly), a malformed one is fatal (exit 2). Unlike a checker that merely
 * re-reads a claimed number, this recomputes isolation and kappa from the artifact's raw_scores
 * through `aggregatePairs` — the exact same Core function the one-time measurement calls — and
 * fails if the recomputed kept-mutation set or kappa disagrees with what the artifact claims.
 * That is what catches the artifact being hand-edited into a nicer result. It cannot catch the
 * live judge drifting — that needs a real re-run, which is what ADR-0016's max_age_days forces
 * periodically.
 *
 * `aggregatePairs`, not a loop of this script's own: the measurement script and this checker
 * previously each wrote one, and two independently-written aggregations over the same data can
 * agree on a number for reasons neither author intended. They now agree by construction.
 *
 * Shape validation is `validateCalibrationArtifact`, shared with scripts/judge.ts. Sharing it is
 * the point: an artifact CI accepts must be one the judge would accept, and vice versa.
 */
import { readFileSync } from "node:fs";
import {
  aggregatePairs, cohensKappa, validateCalibrationArtifact, type RawScoreEntry,
} from "../core/src/eval/judge-calibration.js";

interface CalibrationArtifact {
  cohens_kappa: number;
  threshold: number;
  kept_mutations: string[];
  raw_scores: RawScoreEntry[];
}

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? fallback : process.argv[idx + 1];
}

function main(): number {
  const calibrationPath = argValue("--calibration", "eval/judge-calibration.json");

  let calibrationText: string;
  try {
    calibrationText = readFileSync(calibrationPath, "utf8");
  } catch {
    console.log(
      "check:judge — not armed. eval/judge-calibration.json does not exist yet.\n" +
      "  This is the one-time measurement ADR-0016 requires a real ANTHROPIC_API_KEY to produce.\n" +
      "  Run: ANTHROPIC_API_KEY=... npm run build:judge-calibration",
    );
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(calibrationText);
  } catch (err) {
    console.error(`check:judge — FATAL: ${calibrationPath} does not parse as JSON: ${(err as Error).message}`);
    return 2;
  }

  const problems = validateCalibrationArtifact(parsed);
  if (problems.length > 0) {
    console.error(
      `check:judge — FATAL: ${calibrationPath} is not a valid calibration artifact:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
    );
    return 2;
  }
  const calibration = parsed as CalibrationArtifact;

  const { kept: recomputedKept, pairs: allPairs } = aggregatePairs(calibration.raw_scores);

  const claimedSet = new Set(calibration.kept_mutations);
  const recomputedSet = new Set(recomputedKept);
  const drifted =
    claimedSet.size !== recomputedSet.size ||
    [...claimedSet].some((k) => !recomputedSet.has(k));
  if (drifted) {
    console.error(
      `check:judge — FAILED: recomputed kept-mutation set does not match the artifact's claim.\n` +
      `  claimed:    ${[...claimedSet].sort().join(", ")}\n` +
      `  recomputed: ${[...recomputedSet].sort().join(", ")}`,
    );
    return 1;
  }

  /**
   * Keyed on the KEPT set, not on the pair count.
   *
   * `aggregatePairs` emits a fixture's clean observations whether or not any of its mutations
   * isolated, so `pairs.length` is non-zero for any non-empty artifact and can no longer stand
   * in for "something isolated". With nothing kept, every label is "not degraded" — a constant
   * rater, which `cohensKappa` reports as 1.0 by its own both-raters-constant rule. A perfect
   * score from a measurement that discriminated nothing is the worst possible thing to print.
   */
  if (recomputedKept.length === 0) {
    console.error("check:judge — FATAL: no mutation isolated cleanly; there is nothing to calibrate against.");
    return 2;
  }

  /**
   * The artifact's own count of labelled dimension-instances, re-derived.
   *
   * This is the number that was wrong: the per-mutation aggregation re-counted each fixture's
   * clean judgement once per surviving mutation, so a fixture whose four mutations all isolated
   * contributed its clean row four times. Recomputing it here means the inflation cannot recur
   * silently in a committed artifact.
   */
  const claimedInstances = (calibration as unknown as { labelled_dimension_instances: number })
    .labelled_dimension_instances;
  if (claimedInstances !== allPairs.length) {
    console.error(
      `check:judge — FAILED: claimed labelled_dimension_instances ${claimedInstances} does not match ` +
      `the ${allPairs.length} recomputed from raw_scores (${calibration.raw_scores.length} fixture(s) x 4 clean ` +
      `+ ${recomputedKept.length} kept mutation(s) x 4).`,
    );
    return 1;
  }

  const recomputedKappa = cohensKappa(allPairs);
  const EPSILON = 1e-9;
  if (Math.abs(recomputedKappa - calibration.cohens_kappa) > EPSILON) {
    console.error(
      `check:judge — FAILED: claimed kappa ${calibration.cohens_kappa} does not match ` +
      `the ${recomputedKappa} recomputed from raw_scores. The artifact may have been hand-edited.`,
    );
    return 1;
  }

  if (recomputedKappa < calibration.threshold) {
    console.error(
      `check:judge — FAILED: kappa ${recomputedKappa.toFixed(3)} is below the declared threshold ${calibration.threshold}.`,
    );
    return 1;
  }

  console.log(
    `check:judge — OK. kappa=${recomputedKappa.toFixed(3)} (threshold ${calibration.threshold}), ` +
    `${recomputedKept.length} mutation(s) confirmed isolating and recomputed to match the committed artifact.`,
  );
  return 0;
}

process.exit(main());
