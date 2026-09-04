/**
 * The one-time real measurement. Run by hand, with ANTHROPIC_API_KEY set, by someone who has
 * decided to spend the money — never by an automated pipeline. Reads
 * eval/judge-validation-fixtures.json, calls the real hosted judge once per fixture variant
 * (60 calls: 12 clean + 48 mutated), filters to isolating mutations, computes Cohen's kappa,
 * and writes eval/judge-calibration.json.
 *
 * Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/build-judge-calibration.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { HostedJudgeTransport } from "../adapters/provider-hosted-judge/src/index.js";
import { buildFidelityCandidate, BRIEF_FIDELITY_RUBRIC_TEMPLATE, RUBRIC_DIMENSIONS } from "../core/src/eval/brief-fidelity.js";
import { aggregatePairs, cohensKappa, type RawScoreEntry, type RubricBreakdown } from "../core/src/eval/judge-calibration.js";

interface Fixture {
  id: string;
  brief: string;
  clean_compiled_prompt: string;
  mutations: Record<string, string>;
}

async function gradeOne(transport: HostedJudgeTransport, brief: string, compiledPrompt: string): Promise<RubricBreakdown> {
  /**
   * This script calls HostedJudgeTransport.grade() directly rather than going through
   * GuardedJudge (application/src/judge.ts) — deliberately: GuardedJudge's admission check
   * (core/src/eval/judge-policy.ts) requires an existing Calibration, and producing that
   * Calibration is this script's entire purpose. But HostedJudgeTransport sends `candidate`
   * to the model verbatim as the whole message (see its callOnce), so this script must supply
   * what GuardedJudge.buildJudgePrompt() would otherwise have prepended: the rubric template
   * itself, telling the model what to score and what shape to respond in. Without it, the
   * model receives only the brief/compiled-prompt sections with no instructions at all.
   */
  const candidate = [BRIEF_FIDELITY_RUBRIC_TEMPLATE, "", buildFidelityCandidate(brief, compiledPrompt)].join("\n");
  const verdict = await transport.grade({
    request_id: randomUUID(),
    rubric_id: "brief-fidelity-v1",
    rubric_hash: "unused-in-calibration",
    candidate,
    position_randomized: true,
    runs: 1,
  });
  return verdict.rubric_breakdown as RubricBreakdown;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. This script spends real money and must be run deliberately.");
    process.exit(2);
  }

  const fixtures: Fixture[] = JSON.parse(readFileSync("eval/judge-validation-fixtures.json", "utf8"));
  const transport = new HostedJudgeTransport();
  /**
   * Raw per-fixture scores, recorded in the artifact so check:judge can re-derive isolation
   * and kappa from committed data alone, with no network — the whole point of a CI gate.
   * Without this, the artifact would carry only a claimed kappa, and check:judge could do no
   * better than trust it.
   *
   * Grading fills this and NOTHING ELSE. Isolation, the kept set and the pairs are all derived
   * from it afterwards by `aggregatePairs` — the same call check:judge makes over the same
   * committed field. An aggregation computed inline while grading is an aggregation the checker
   * has to reproduce from a different piece of code, and that is exactly how the two drifted:
   * the inline loop re-emitted each fixture's clean observations once per surviving mutation,
   * inflating n and tying the kappa's weighting to isolation success.
   */
  const rawScores: RawScoreEntry[] = [];

  for (const fixture of fixtures) {
    console.error(`grading fixture: ${fixture.id}`);
    const clean = await gradeOne(transport, fixture.brief, fixture.clean_compiled_prompt);
    const mutationScores: Record<string, RubricBreakdown> = {};

    for (const dim of RUBRIC_DIMENSIONS) {
      const mutatedPrompt = fixture.mutations[dim];
      mutationScores[dim] = await gradeOne(transport, fixture.brief, mutatedPrompt);
    }

    rawScores.push({ fixture: fixture.id, clean, mutations: mutationScores });
  }

  const { kept, pairs } = aggregatePairs(rawScores);
  const keptSet = new Set(kept);
  for (const entry of rawScores) {
    for (const dim of RUBRIC_DIMENSIONS) {
      if (!keptSet.has(`${entry.fixture}/${dim}`)) {
        console.error(`  DROPPED (does not isolate): ${entry.fixture} / ${dim}`);
      }
    }
  }

  if (kept.length === 0) {
    console.error("no mutation isolated cleanly; there is nothing to calibrate against. Nothing written.");
    process.exit(1);
  }

  const kappa = cohensKappa(pairs);
  const artifact = {
    measured_on: new Date().toISOString().slice(0, 10),
    reference: "mutation-derived-v1",
    fixtures_total: fixtures.length,
    mutations_kept: kept.length,
    mutations_total: fixtures.length * RUBRIC_DIMENSIONS.length,
    // F x D clean instances + K x D mutated ones. See aggregatePairs.
    labelled_dimension_instances: pairs.length,
    cohens_kappa: kappa,
    threshold: 0.6,
    max_age_days: 30,
    kept_mutations: kept,
    raw_scores: rawScores,
  };
  writeFileSync("eval/judge-calibration.json", JSON.stringify(artifact, null, 2) + "\n");
  console.error(`wrote eval/judge-calibration.json — kappa=${kappa.toFixed(3)}, kept ${kept.length}/${fixtures.length * RUBRIC_DIMENSIONS.length}, ${pairs.length} labelled dimension-instances`);
}

main();
