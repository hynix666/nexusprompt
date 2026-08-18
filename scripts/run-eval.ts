#!/usr/bin/env tsx
/**
 * Run a pipeline suite and report the result.
 *
 *   npm run eval                 run the smoke suite, print the verdict
 *   npm run eval -- --json       emit the EvalRun for a baseline or a comparison
 *   npm run eval -- --compare    run the baseline and the degraded variant, compare them
 *
 * Composition root for evaluation: the only place a concrete suite path is named.
 *
 * Exit 0 every case passed · 1 a case failed · 2 the suite cannot be read
 *      · 3 the instrument itself is broken — a detector has no probe, or probes ran
 *        against it and caught nothing, which makes it dead code behind a clean suite.
 *      · 4 `--compare` did not reach the verdict it exists to demonstrate.
 *
 * A green run here says the pipeline kept its own guarantees on eight pinned cases.
 * It says nothing about a model — no live provider was called, no judge ran, and the
 * suite is three orders of magnitude below the size that could certify a promotion.
 */

import { readFileSync } from "node:fs";
import { runSuite, configurationId, type StubbedCase } from "../application/src/eval.js";
import { compare } from "../core/src/eval/compare.js";
import { detectorsWithoutProbes, probesWithoutDetectors, deadDetectors } from "../core/src/eval/probes.js";
import type { Configuration, EvalSuite } from "../contracts/index.js";

/** The configuration a variant names, so two runs differ in exactly one recorded field. */
const DEGRADED = "degraded-prompt";

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

  // The instrument is checked before anything it measures is reported. A detector with no
  // probe has never been shown to fire, and a score computed from it is not evidence.
  const uncovered = detectorsWithoutProbes();
  const orphaned = probesWithoutDetectors();
  if (uncovered.length > 0 || orphaned.length > 0) {
    if (uncovered.length) console.error(`eval: no mutation probe for ${uncovered.join(", ")}.`);
    if (orphaned.length) console.error(`eval: probe(s) target a detector nobody wrote: ${orphaned.join(", ")}.`);
    console.error("  Every detector needs a probe. A detector that has never been shown to fire\n" +
                  "  is dead code behind a passing suite, and no score built on it means anything.");
    return 3;
  }

  const { run, perCase } = await runSuite({ suite: data.suite, cases: data.cases, configuration });

  const dead = run.detector_recall ? deadDetectors(run.detector_recall) : [];
  if (dead.length > 0) {
    console.error(`eval: probes ran against ${dead.join(", ")} and caught nothing — recall 0.`);
    console.error("  Measured and dead, which is different from unmeasurable. The detector is\n" +
                  "  reporting success it cannot have earned.");
    return 3;
  }

  if (process.argv.includes("--compare")) return compareRuns(data, configuration, base);

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

  const recall = run.detector_recall;
  if (recall) {
    console.log(`\n  detector recall (probe corpus ${recall.probe_corpus_version}) — measured on this run's own outcomes:`);
    for (const d of recall.detectors) {
      const value = d.recall === null
        ? "  n/a  (no substrate — the detector fired on every outcome)"
        : `${(d.recall * 100).toFixed(1).padStart(5)}%  ${d.probes_detected}/${d.probes_run} probe(s) on ${d.substrates} substrate(s)`;
      console.log(`    ${d.detector_id.padEnd(30)} ${value}`);
    }
    console.log("    recall 1.0 means these detectors caught everything we thought to plant.\n" +
                "    It is not a claim they catch everything.");
  }

  console.log(`\n  resolution: this suite's score granularity is ${data.suite.resolution.detectable_delta}, but ` +
              `evidencing a\n  difference takes six one-directional flips (p=0.031); five gives 0.063 and does not.\n` +
              `  Certifying a promotion needs an anchor, not a smoke suite.`);

  return passed === cases ? 0 : 1;
}

/**
 * Run the same suite under two configurations and compare them.
 *
 * The point is not the number. It is that a deliberately worse configuration is *measured*
 * as worse, with the instrument check in front of it — Phase 2b's exit gate. Both runs are
 * pinned, so the regression is declared rather than sampled; what is being demonstrated is
 * the harness's ability to report one, not a model's behaviour.
 */
async function compareRuns(
  data: { suite: EvalSuite; cases: StubbedCase[] },
  baselineConfig: Configuration,
  base: Omit<Configuration, "configuration_id">,
): Promise<number> {
  const candidateBase = { ...base, prompt_template_ref: `${base.prompt_template_ref}#${DEGRADED}` };
  const candidateConfig: Configuration = { configuration_id: configurationId(candidateBase), ...candidateBase };

  const baseline = await runSuite({ suite: data.suite, cases: data.cases, configuration: baselineConfig });
  const candidate = await runSuite({
    suite: data.suite, cases: data.cases, configuration: candidateConfig, variant: DEGRADED,
  });

  const suiteDetectorIds = [...new Set(data.cases.flatMap((c) => c.detector_ids))].sort();

  const comparison = compare({
    comparison_id: `${baseline.run.run_id}-vs-${candidate.run.run_id}`,
    candidate_run_id: candidate.run.run_id,
    baseline_id: baseline.run.run_id,
    candidate: candidate.perCase.map((c) => ({ case_id: c.case_id, passed: c.passed })),
    baseline: baseline.perCase.map((c) => ({ case_id: c.case_id, passed: c.passed })),
    suite: data.suite,
    comparisons_in_family: 1,
    alpha: 0.05,
    candidateRecall: candidate.run.detector_recall,
    baselineRecall: baseline.run.detector_recall,
    suiteDetectorIds,
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(comparison, null, 2));
    return comparison.verdict === "regressed" ? 0 : 4;
  }

  const eq = comparison.equalization;
  console.log(`compare — ${data.suite.suite_id}@${data.suite.version}`);
  console.log(`  baseline  ${baselineConfig.configuration_id.slice(0, 12)}  ${baseline.run.aggregate.passed}/${baseline.run.aggregate.cases}`);
  console.log(`  candidate ${candidateConfig.configuration_id.slice(0, 12)}  ${candidate.run.aggregate.passed}/${candidate.run.aggregate.cases}  (${DEGRADED})\n`);

  console.log("  equalization — derived from both runs' measured recall, not asserted:");
  console.log(`    equalized          ${eq.equalized}`);
  console.log(`    max gap            ${eq.max_gap === null ? "n/a" : eq.max_gap.toFixed(4)}  (bound ${eq.gap_bound}, derived from the suite's resolution)`);
  console.log(`    effective recall   ${eq.effective_recall === null ? "n/a" : eq.effective_recall.toFixed(4)}  — the blunter of the two instruments`);
  console.log(`    resolution         ${eq.adjusted_resolution === null ? "n/a" : eq.adjusted_resolution.toFixed(4)}\n`);

  const p = comparison.protocol.p_value;
  console.log(`  verdict  ${comparison.verdict.toUpperCase()}`);
  if (comparison.delta !== null) console.log(`  delta    ${comparison.delta.toFixed(4)}`);
  if (p !== null && p !== undefined) console.log(`  p        ${p.toFixed(5)}  (${comparison.protocol.test}, alpha ${comparison.protocol.alpha})`);
  if (comparison.refusal_reason) console.log(`  reason   ${comparison.refusal_reason}`);

  if (comparison.verdict !== "regressed") {
    console.error("\n  Expected `regressed`. The exit gate is that a deliberately worse configuration is\n" +
                  "  measured as worse — a harness that has never reported a regression has not been\n" +
                  "  shown to detect one.");
    return 4;
  }
  console.log("\n  A deliberately worse configuration was measured as worse, with the instrument\n" +
              "  checked first. This says nothing about any model.");
  return 0;
}

process.exit(await main());
