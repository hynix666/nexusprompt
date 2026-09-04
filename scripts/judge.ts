/**
 * npm run judge -- --run <run_id>
 *
 * Post-processing: reads a completed run through the same local storage the CLI pipeline
 * writes to, judges its brief fidelity with the real hosted transport, and records the
 * result as evidence. Naming concrete adapters is what a composition root is for — everything
 * in application/src/judge-bundle.ts sees only the ports.
 */
import { LocalRevisionStore } from "../adapters/storage-local/src/index.js";
import { LocalContentStore } from "../adapters/content-local/src/index.js";
import { LocalEvidenceStore } from "../adapters/evidence-local/src/index.js";
import { HostedJudgeTransport } from "../adapters/provider-hosted-judge/src/index.js";
import { judgeBundle, JudgeBundleRefused } from "../application/src/judge-bundle.js";
import { readFileSync } from "node:fs";

function usageError(msg: string): never {
  console.error(`judge: ${msg}\n\nUsage: npm run judge -- --run <run_id>`);
  process.exit(2);
}

async function main() {
  const runIdx = process.argv.indexOf("--run");
  const run_id = runIdx === -1 ? null : process.argv[runIdx + 1];
  if (!run_id) usageError("no run id given (--run <run_id>)");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "judge: ANTHROPIC_API_KEY is not set in this process's environment.\n\n" +
      "  A judged run sends this run's brief and compiled prompt to api.anthropic.com and spends money.",
    );
    process.exit(2);
  }

  let calibration;
  try {
    calibration = JSON.parse(readFileSync("eval/judge-calibration.json", "utf8"));
  } catch {
    console.error(
      "judge: eval/judge-calibration.json does not exist. Run `npm run build:judge-calibration` first " +
      "(see ADR-0016) — the judge refuses to grade anything without a measured calibration.",
    );
    process.exit(2);
  }

  const root = ".nexusprompt/runs";
  const deps = {
    revisions: new LocalRevisionStore(root),
    content: new LocalContentStore(`${root}/content`),
    evidence: new LocalEvidenceStore(`${root}/evidence`),
    transport: new HostedJudgeTransport(),
    calibration: {
      // eval/judge-calibration.json only ever records a Cohen's kappa measurement — see
      // core/src/eval/judge-calibration.ts's cohensKappa, the only metric this repository
      // computes for judge calibration.
      metric: "cohens-kappa" as const,
      value: calibration.cohens_kappa,
      threshold: calibration.threshold,
      measured_at: `${calibration.measured_on}T00:00:00.000Z`,
      reference: calibration.reference,
      max_age_days: calibration.max_age_days,
    },
  };

  try {
    const judgement = await judgeBundle(deps, run_id, new Date().toISOString());
    console.log(
      `judge: run "${run_id}" judged — overall ${judgement.verdict.verdict}/12, ` +
      `judgement_id ${judgement.judgement_id}`,
    );
    for (const [dim, entry] of Object.entries(judgement.verdict.rubric_breakdown ?? {})) {
      console.log(`  ${dim}: ${(entry as { score: number }).score}/3`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof JudgeBundleRefused) {
      console.error(`judge: refused (${err.code}): ${err.message}`);
      process.exit(2);
    }
    console.error(`judge: failed — ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
