/**
 * npm run judge:pilot
 *
 * Sub-project 4: runs the 100 brief-pilot briefs (seed 1, count 100 — identical to
 * eval/brief-pilot.json's own generator call, see scripts/build-brief-pilot.ts) through two
 * local models at TINY depth, judges each compiled prompt with the real hosted judge, and
 * compares the two score sequences with a paired bootstrap. Composition root — the one file
 * here permitted to name concrete adapters; application/src/judge-pilot.ts sees only ports.
 *
 * Dedicated storage under `.nexusprompt-judge-pilot/`, NOT the CLI's own `.nexusprompt/`:
 * LocalRevisionStore keeps only 8 run bundles per store and this pilot writes 200 (100 briefs
 * x 2 models), so sharing the operator's own directory would both evict their unrelated runs
 * and risk this pilot's own bundles being evicted by unrelated CLI use running concurrently.
 * See application/src/judge-pilot.ts's header for why writing 200 bundles into an 8-slot
 * store is safe regardless: each is judged immediately, before the next brief starts.
 *
 * Spends real money against api.anthropic.com (up to 100 x 2 x 3 = 600 calls, one
 * HostedJudgeTransport grading per side per brief) and requires phi4-mini:latest and
 * lfm2.5-thinking:latest already pulled in a local Ollama daemon. Refuses up front, before
 * any of that, if the prerequisites are not met.
 */
import { readFileSync } from "node:fs";
import { LocalRevisionStore } from "../adapters/storage-local/src/index.js";
import { LocalContentStore } from "../adapters/content-local/src/index.js";
import { LocalEvidenceStore } from "../adapters/evidence-local/src/index.js";
import { OllamaProvider } from "../adapters/provider-ollama/src/index.js";
import { HostedJudgeTransport } from "../adapters/provider-hosted-judge/src/index.js";
import { validateCalibrationArtifact } from "../core/src/eval/judge-calibration.js";
import { buildBriefCorpus } from "../core/src/eval/brief-generator.js";
import { runJudgePilot, type JudgePilotBrief } from "../application/src/judge-pilot.js";

const CANDIDATE_MODEL = "lfm2.5-thinking:latest";
const BASELINE_MODEL = "phi4-mini:latest";
const SEED = 1;
const COUNT = 100;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "judge-pilot: ANTHROPIC_API_KEY is not set in this process's environment.\n\n" +
      "  This pilot judges up to 200 compiled prompts against api.anthropic.com and spends money.",
    );
    process.exit(2);
  }

  let calibration: Record<string, unknown>;
  try {
    calibration = JSON.parse(readFileSync("eval/judge-calibration.json", "utf8"));
  } catch {
    console.error(
      "judge-pilot: eval/judge-calibration.json does not exist. Run\n" +
      "  ANTHROPIC_API_KEY=... npx tsx scripts/build-judge-calibration.ts\n" +
      "first (see ADR-0016) — the judge refuses to grade anything without a measured calibration.",
    );
    process.exit(2);
  }

  const problems = validateCalibrationArtifact(calibration);
  if (problems.length > 0) {
    console.error(
      "judge-pilot: eval/judge-calibration.json is not a valid calibration artifact, so it is " +
      "not evidence about anything. Refusing to run.\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\n  Re-measure with `npm run build:judge-calibration` rather than editing it by hand.",
    );
    process.exit(2);
  }

  const briefs: JudgePilotBrief[] = buildBriefCorpus({ seed: SEED, count: COUNT }).map((c) => ({
    case_id: c.case_id,
    brief: c.input.brief,
  }));

  const deps = {
    candidateProvider: new OllamaProvider({ model: CANDIDATE_MODEL }),
    baselineProvider: new OllamaProvider({ model: BASELINE_MODEL }),
    revisions: new LocalRevisionStore(".nexusprompt-judge-pilot/runs"),
    content: new LocalContentStore(".nexusprompt-judge-pilot/content"),
    evidence: new LocalEvidenceStore(".nexusprompt-judge-pilot/evidence"),
    transport: new HostedJudgeTransport(),
    calibration: {
      metric: "cohens-kappa" as const,
      // Safe only because validateCalibrationArtifact ran above and checked every field's type.
      value: calibration.cohens_kappa as number,
      threshold: calibration.threshold as number,
      measured_at: `${calibration.measured_on as string}T00:00:00.000Z`,
      reference: calibration.reference as string,
      max_age_days: calibration.max_age_days as number,
    },
    now: () => new Date(),
    coreBuildHash: "judge-pilot",
  };

  const result = await runJudgePilot(deps, briefs);

  console.log(
    `judge-pilot: ${result.survived_n}/${result.nominal_n} briefs survived pairing.\n` +
    `  verdict: ${result.comparison.verdict}\n` +
    `  delta: ${result.comparison.delta ?? "n/a"}\n` +
    `  confidence_interval: ${JSON.stringify(result.comparison.protocol.confidence_interval ?? null)}\n` +
    `  comparison_id: ${result.comparison.comparison_id}` +
    (result.comparison.refusal_reason ? `\n  refusal_reason: ${result.comparison.refusal_reason}` : ""),
  );
  if (result.dropped.length > 0) {
    console.log(`  dropped ${result.dropped.length} brief(s):`);
    for (const d of result.dropped) console.log(`    ${d.case_id}: ${d.reason}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`judge-pilot: failed — ${(err as Error).message}`);
  process.exit(1);
});
