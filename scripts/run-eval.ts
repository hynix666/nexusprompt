#!/usr/bin/env tsx
/**
 * Run a pipeline suite and report the result.
 *
 *   npm run eval                 run the smoke suite, print the verdict
 *   npm run eval -- --json       emit the EvalRun for a baseline or a comparison
 *
 * Composition root for evaluation: the only place a concrete suite path is named.
 *
 * Exit 0 every case passed · 1 a case failed · 2 the suite cannot be read.
 *
 * A green run here says the pipeline kept its own guarantees on eight pinned cases.
 * It says nothing about a model — no live provider was called, no judge ran, and the
 * suite is three orders of magnitude below the size that could certify a promotion.
 */

import { readFileSync } from "node:fs";
import { runSuite, configurationId, type StubbedCase } from "../application/src/eval.js";
import type { Configuration, EvalSuite } from "../contracts/index.js";

const SUITE = process.argv.includes("--suite")
  ? process.argv[process.argv.indexOf("--suite") + 1]
  : "eval/compile-smoke.json";

async function main(): Promise<number> {
  let data: { suite: EvalSuite; cases: StubbedCase[] };
  try {
    data = JSON.parse(readFileSync(SUITE, "utf8"));
  } catch (err) {
    console.error(`eval: cannot read ${SUITE} — ${(err as Error).message}`);
    return 2;
  }

  const base = {
    prompt_template_ref: "core/src/stages/compile.ts",
    model_id: "pinned",
    decoding: { temperature: null, seed: null },
    topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
    retrieval_config: null,
    tool_config: null,
    gate_set_ref: "scripts/ported-gates.json",
    router_policy_ref: null,
  };
  const configuration: Configuration = { configuration_id: configurationId(base), ...base };

  const { run, perCase } = await runSuite({ suite: data.suite, cases: data.cases, configuration });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(run, null, 2));
    return run.aggregate.passed === run.aggregate.cases ? 0 : 1;
  }

  console.log(`eval — ${run.suite_id}@${run.suite_version} (${data.suite.kind})`);
  console.log(`  configuration ${run.configuration_id.slice(0, 12)} · ${run.cost.provider_calls} pinned provider call(s), no network\n`);

  for (const c of perCase) {
    console.log(`  ${c.passed ? "pass" : "FAIL"}  ${c.case_id.padEnd(34)} ${c.failure_mode}`);
    for (const s of c.scores) {
      if (!s.passed) console.error(`          ↳ ${s.detector_id}: ${s.detail}`);
    }
  }

  const { passed, cases, score } = run.aggregate;
  console.log(`\n  ${passed}/${cases} cases · score ${score.toFixed(3)}`);
  console.log(`  resolution: this suite can see a difference of ${data.suite.resolution.detectable_delta}; ` +
              `certifying a promotion needs an anchor, not a smoke suite`);

  return passed === cases ? 0 : 1;
}

process.exit(await main());
