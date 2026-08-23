#!/usr/bin/env tsx
/**
 * Run the eleven-stage pipeline against a pipeline suite.
 *
 *   npm run eval:pipeline
 *   npm run eval:pipeline -- --suite eval/pipeline-smoke.json
 *
 * ## Why this exists as a separate command
 *
 * `eval/pipeline-smoke.json` was built in Phase γ to close a gap Phase β had found: no suite
 * could observe `runPipeline` at all, because `compile-smoke` drives the SINGLE-STAGE
 * orchestrator. It closed that gap inside the test suite and nowhere else — the file was
 * reachable from `application/test/pipeline-eval.test.ts` and from no command.
 *
 * That is worse than it sounds, because `run-eval.ts --suite eval/pipeline-smoke.json`
 * appeared to work. It reported **5/5 passing and 5 provider calls** for a suite whose cases
 * each describe an eleven-stage run. It was running the compile stage in isolation, ignoring
 * the per-stage `stubs` entirely, and every case fell back to a pinned failure — so the
 * detectors that are conditional on `demo_mode` passed vacuously. A green result measuring
 * something other than what its name says is the exact failure this repository exists to
 * catch, and it was sitting in the evaluation runner.
 *
 * `run-eval.ts` now refuses a pipeline suite instead of silently running it. This is where
 * those suites go.
 *
 * Exit 0 every case passed · 1 a case failed · 2 the suite cannot be read or is the wrong shape.
 */

import { readFileSync } from "node:fs";
import { runPipelineSuite, isPipelineCase, type PipelineEvalCase } from "../application/src/pipeline-eval.js";
import type { EvalSuite } from "../contracts/index.js";

const SUITE = process.argv.includes("--suite")
  ? process.argv[process.argv.indexOf("--suite") + 1]
  : "eval/pipeline-smoke.json";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  pass: (s: string) => `\x1b[36m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  fail: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

async function main(): Promise<number> {
  let data: { suite: EvalSuite; cases: PipelineEvalCase[] };
  try {
    data = JSON.parse(readFileSync(SUITE, "utf8"));
  } catch (err) {
    console.error(`eval:pipeline: cannot read ${SUITE} — ${(err as Error).message}`);
    return 2;
  }

  /**
   * A pipeline case carries a `brief` and per-stage `stubs`. A single-stage case carries one
   * `stub`. Running the wrong kind here would repeat the defect this command was written to
   * fix, in the other direction.
   */
  const wrongShape = data.cases.filter((c) => !isPipelineCase(c));
  if (wrongShape.length > 0) {
    console.error(
      `eval:pipeline: ${SUITE} holds ${wrongShape.length} case(s) with no \`brief\`.\n` +
      "  That is a single-stage suite. Run it with `npm run eval -- --suite <path>`.",
    );
    return 2;
  }

  const { perCase, passed } = await runPipelineSuite({ cases: data.cases });

  console.log(`eval:pipeline — ${data.suite.suite_id}@${data.suite.version} (${data.suite.kind})`);
  console.log(C.dim(`  ${data.cases.length} case(s), each a full pipeline run\n`));

  for (const c of perCase) {
    const ran = c.stages.filter((s) => s.status === "SUCCEEDED").length;
    const skipped = c.stages.filter((s) => s.status === "SKIPPED").length;
    const demo = c.stages.filter((s) => s.status === "DEMO").length;
    const mark = c.passed ? C.pass("pass") : C.fail("FAIL");
    console.log(`  ${mark}  ${c.case_id.padEnd(38)} ${c.failure_mode}`);
    console.log(
      C.dim(
        `        ${c.stages.length} stage(s): ${ran} ok · ${skipped} skipped · ${demo} demo` +
        `   ${c.providerCalls} provider call(s)` +
        `   ${c.feedbackRounds} feedback round(s)` +
        `   demo_mode=${c.demoMode}`,
      ),
    );
    for (const s of c.scores.filter((s) => !s.passed)) {
      console.log(`        ${C.warn("↳")} ${s.detector_id}: ${s.detail}`);
    }
  }

  console.log(`\n  ${passed}/${perCase.length} cases · score ${(passed / perCase.length).toFixed(3)}`);

  /**
   * The pipeline-level facts, reported because they are the whole reason this suite exists.
   * A single-stage suite cannot produce any of them, and a runner that printed only a score
   * would be indistinguishable from the one that ran the wrong thing.
   */
  const totalStages = perCase.reduce((n, c) => n + c.stages.length, 0);
  const totalCalls = perCase.reduce((n, c) => n + c.providerCalls, 0);
  console.log(
    C.dim(
      `  ${totalStages} stage execution(s) across ${perCase.length} run(s), ${totalCalls} provider call(s).\n` +
      "  This measures pipeline SHAPE — depth plans, skips, partial degradation, the\n" +
      "  gate-feedback loop. It says nothing about a model: every stage answered from a\n" +
      "  per-stage stub, and the suite is below the size at which any comparison on it\n" +
      "  could reach significance (see scripts/suite-sizing-acknowledgments.json).",
    ),
  );

  return passed === perCase.length ? 0 : 1;
}

main().then((code) => process.exit(code));
