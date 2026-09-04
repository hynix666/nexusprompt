/**
 * check:judge — re-derives the judge calibration from committed artifacts, no network.
 *
 * Mirrors scripts/check-noise.ts's "not armed" discipline: absent artifact is not a failure
 * (exit 0, printed plainly), a malformed one is fatal (exit 2). Unlike a checker that merely
 * re-reads a claimed number, this recomputes isolatesCleanly/derivePairs/cohensKappa from the
 * artifact's raw_scores using the exact same Core functions the one-time measurement used, and
 * fails if the recomputed kept-mutation set or kappa disagrees with what the artifact claims.
 * That is what catches the artifact being hand-edited into a nicer result. It cannot catch the
 * live judge drifting — that needs a real re-run, which is what ADR-0016's max_age_days forces
 * periodically.
 */
import { readFileSync } from "node:fs";
import { RUBRIC_DIMENSIONS, type RubricDimension } from "../core/src/eval/brief-fidelity.js";
import { isolatesCleanly, cohensKappa, derivePairs, type RubricBreakdown } from "../core/src/eval/judge-calibration.js";

interface CalibrationArtifact {
  cohens_kappa: number;
  threshold: number;
  kept_mutations: string[];
  raw_scores: Array<{ fixture: string; clean: RubricBreakdown; mutations: Record<string, RubricBreakdown> }>;
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

  let calibration: CalibrationArtifact;
  try {
    calibration = JSON.parse(calibrationText);
  } catch (err) {
    console.error(`check:judge — FATAL: ${calibrationPath} does not parse as JSON: ${(err as Error).message}`);
    return 2;
  }

  if (
    typeof calibration.cohens_kappa !== "number" ||
    !Array.isArray(calibration.kept_mutations) ||
    !Array.isArray(calibration.raw_scores)
  ) {
    console.error(`check:judge — FATAL: ${calibrationPath} is missing required fields (cohens_kappa, kept_mutations, raw_scores).`);
    return 2;
  }

  const recomputedKept: string[] = [];
  const allPairs: Array<[boolean, boolean]> = [];
  for (const entry of calibration.raw_scores) {
    for (const dim of RUBRIC_DIMENSIONS) {
      const mutated = entry.mutations[dim];
      if (!mutated) continue;
      if (!isolatesCleanly(entry.clean, mutated, dim as RubricDimension)) continue;
      recomputedKept.push(`${entry.fixture}/${dim}`);
      allPairs.push(...derivePairs(entry.clean, mutated, dim as RubricDimension));
    }
  }

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

  if (allPairs.length === 0) {
    console.error("check:judge — FATAL: no mutation isolated cleanly; there is nothing to calibrate against.");
    return 2;
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
