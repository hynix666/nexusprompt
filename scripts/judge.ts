/**
 * npm run judge -- --run <run_id>
 *
 * Post-processing: reads a completed run through the same local storage the CLI pipeline
 * writes to, judges its brief fidelity with the real hosted transport, and records the
 * result as evidence. Naming concrete adapters is what a composition root is for — everything
 * in application/src/judge-bundle.ts sees only the ports.
 */
import { composePipeline, composeEvidence } from "../shells/cli/src/composition-root.js";
import { HostedJudgeTransport } from "../adapters/provider-hosted-judge/src/index.js";
import { judgeBundle, JudgeBundleRefused } from "../application/src/judge-bundle.js";
import { validateCalibrationArtifact } from "../core/src/eval/judge-calibration.js";
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

  let calibration: Record<string, unknown>;
  try {
    calibration = JSON.parse(readFileSync("eval/judge-calibration.json", "utf8"));
  } catch {
    console.error(
      "judge: eval/judge-calibration.json does not exist. Run `npm run build:judge-calibration` first " +
      "(see ADR-0016) — the judge refuses to grade anything without a measured calibration.",
    );
    process.exit(2);
  }

  /**
   * Shape-checked BEFORE a Calibration is built from it, because the alternative fails open.
   *
   * Parsing alone left every field `unknown`, and a missing one became `undefined` inside the
   * Calibration object — where all three of admitJudge's calibration guards are comparisons
   * that are simply false against `undefined`/`NaN`. A corrupt artifact was therefore admitted
   * as a measured one. The same validator runs in check:judge, so CI refuses an artifact this
   * would refuse rather than each side having its own idea of the shape.
   */
  const problems = validateCalibrationArtifact(calibration);
  if (problems.length > 0) {
    console.error(
      "judge: eval/judge-calibration.json is not a valid calibration artifact, so it is not " +
      "evidence about anything. Refusing to grade.\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\n  Re-measure with `npm run build:judge-calibration` (see ADR-0016) rather than editing it by hand.",
    );
    process.exit(2);
  }

  /**
   * The stores come from the CLI's own composition root, not from three paths written out
   * again here.
   *
   * They were written out again here, and two of the three were wrong: content went to
   * `.nexusprompt/runs/content` and evidence to `.nexusprompt/runs/evidence`, while
   * `composePipeline`/`composeEvidence` write to `.nexusprompt/content` and
   * `.nexusprompt/evidence` — sibling directories, deliberately separate because the three
   * planes have different retention lifetimes. So every `npm run judge` would have refused
   * with `content-not-found` against a directory that has never existed on this machine, and
   * any judgement it did write would have landed where nothing reads.
   *
   * Exactly the defect `check-fingerprint.mjs` had with `.promptnexus/runs`: two hard-coded
   * halves, neither asked about the other. Deriving both from the one function that decides
   * is the fix that cannot regress. `composePipeline` also builds a ProviderTransport this
   * command has no use for; constructing one performs nothing, and taking the wiring whole is
   * what makes "reads what the CLI writes" true by construction rather than by memory.
   */
  const sink = { emit: () => {} };
  const wiring = composePipeline({ sink });
  const deps = {
    revisions: wiring.store,
    content: wiring.content!,
    evidence: composeEvidence({ sink }),
    transport: new HostedJudgeTransport(),
    calibration: {
      // eval/judge-calibration.json only ever records a Cohen's kappa measurement — see
      // core/src/eval/judge-calibration.ts's cohensKappa, the only metric this repository
      // computes for judge calibration.
      metric: "cohens-kappa" as const,
      // The casts are safe only because validateCalibrationArtifact ran above and every one of
      // these fields is one it checked the type of. Do not move this block ahead of it.
      value: calibration.cohens_kappa as number,
      threshold: calibration.threshold as number,
      measured_at: `${calibration.measured_on as string}T00:00:00.000Z`,
      reference: calibration.reference as string,
      max_age_days: calibration.max_age_days as number,
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
