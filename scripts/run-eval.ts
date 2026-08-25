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

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { runSuite, configurationId, type StubbedCase } from "../application/src/eval.js";
import { MemoryCacheStore } from "../application/src/cache.js";
import { isPipelineCase } from "../application/src/pipeline-eval.js";
// Naming a concrete adapter is what a composition root is for.
import { LocalProxyProvider } from "../adapters/provider-local-proxy/src/index.js";
import { compare } from "../core/src/eval/compare.js";
import { detectorsWithoutProbes, probesWithoutDetectors, deadDetectors } from "../core/src/eval/probes.js";
import type { Configuration, EvalSuite } from "../contracts/index.js";

/** The configuration a variant names, so two runs differ in exactly one recorded field. */
const DEGRADED = "degraded-prompt";

/**
 * `--live` swaps the pinned stubs for the real provider adapter.
 *
 * This file is the composition root for evaluation — "the only place a concrete suite path is
 * named" — so it is also the right place to name a concrete provider. Everything below it
 * still sees only the `ProviderTransport` port.
 *
 * The key is read by the adapter from `ANTHROPIC_API_KEY`; it is never passed through this
 * script, printed, or written to a run. A live run costs money and sends the suite's briefs
 * to Anthropic, so it happens only when the flag is given explicitly.
 */
const LIVE = process.argv.includes("--live");

const flagValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const intFlag = (name: string): number | undefined => {
  const raw = flagValue(name);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`eval: --${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
    process.exit(2);
  }
  return n;
};

const TRIALS = intFlag("trials") ?? 1;

/**
 * A live run must declare what it may spend, and there is no default.
 *
 * Phase γ's entry criterion was "budget enforcement written before the first real call".
 * `admitRun` has existed since then and this composition root never declared a budget, so the
 * FIRST live run would have been the unbounded one — `admitRun` would have returned
 * "no budget declared" and admitted all 1,400 calls of a 100-trial suite. A guard that exists
 * and is not wired is the defect this repository keeps finding, and it was sitting in the one
 * place where the cost of missing it is measured in money.
 *
 * Requiring the flag rather than defaulting it: both a generous default and a stingy one are
 * defensible, so picking either for the caller is the bug — the same reasoning that makes
 * `Budget.on_exceed` mandatory.
 */
const MAX_CALLS = intFlag("max-calls");

const SUITE = process.argv.includes("--suite")
  ? process.argv[process.argv.indexOf("--suite") + 1]
  : "eval/compile-smoke.json";

/**
 * Why this value cannot be a key — or null if nothing rules it out.
 *
 * Exported and pure so the refusal is testable without spawning the script or setting a
 * process-wide variable. It asserts NO vendor format: `sk-ant-` plus a length would fail
 * closed the day either changes, and this script has no business knowing that. It reports
 * only shapes a key can never have, which is a claim that stays true.
 */
export function implausibleKeyReason(key: string): string | null {
  if (/[<>"'\s]/.test(key)) return "contains a bracket, quote or whitespace";
  if (key.length < 20) return `is ${key.length} characters long`;
  return null;
}

async function main(): Promise<number> {
  let data: { suite: EvalSuite; cases: StubbedCase[] };
  try {
    data = JSON.parse(readFileSync(SUITE, "utf8"));
  } catch (err) {
    console.error(`eval: cannot read ${SUITE} — ${(err as Error).message}`);
    return 2;
  }

  /**
   * Refuse a suite this runner cannot actually run.
   *
   * `--suite eval/pipeline-smoke.json` used to report **5/5 passing and 5 provider calls** for
   * a suite whose five cases each describe an eleven-stage run. It was driving the
   * single-stage orchestrator, ignoring the per-stage `stubs` completely, and falling back to
   * a pinned failure for every case — so the detectors that are conditional on `demo_mode`
   * passed vacuously. A green result measuring something other than what its name says is the
   * defect this repository exists to catch, and it was living in the evaluation runner.
   *
   * The discriminator is the case shape, not the filename: a pipeline case carries a `brief`
   * and per-stage `stubs`, a single-stage case carries one `stub`.
   */
  const pipelineCases = data.cases.filter(isPipelineCase);
  if (pipelineCases.length > 0) {
    console.error(
      `eval: ${SUITE} holds ${pipelineCases.length} case(s) with a \`brief\` and per-stage stubs.\n` +
      "  That is a pipeline suite, and this runner drives the SINGLE-STAGE orchestrator. It\n" +
      "  would report a score for the compile stage alone while ignoring every other stage.\n\n" +
      `    npm run eval:pipeline -- --suite ${SUITE}`,
    );
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
    /**
     * Enforced by `admitRun` before anything is spent, and refusing rather than truncating:
     * a partially executed suite is not an EvalRun, because its aggregate would be a score
     * over whichever cases happened to fit, published under the name of a suite that means
     * something else.
     */
    budget: MAX_CALLS === undefined
      ? null
      : { max_provider_calls: MAX_CALLS, max_usd: null, on_exceed: "refuse" as const },
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

  /**
   * Caching is on for live runs so the Phase gamma prediction is testable at all: the claim
   * was that a second identical request reports a non-zero cache read. Without a cache there
   * is nothing to report. It stays off for stubbed runs, where every call is free and a hit
   * would only hide the accounting.
   */
  /**
   * Pre-flight. Without this a keyless `--live` run degrades all fourteen cases and reports a
   * score — honest, because demo mode labels every one of them, and unhelpful, because the
   * user still has no idea why. Refuse first and say what to do.
   *
   * Presence is all that is read. The value belongs to the adapter and to `process.env`;
   * routing it through this script would put it one careless log line away from a terminal.
   */
  if (LIVE && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "eval --live: ANTHROPIC_API_KEY is not set in this process's environment.\n\n" +
      "  Set it yourself — nothing here will ask you for it, store it, or print it.\n" +
      "  Replace the words YOUR_KEY_HERE; do not paste the line as written:\n" +
      "    PowerShell   $env:ANTHROPIC_API_KEY = 'YOUR_KEY_HERE'    (this session only)\n" +
      "    bash / zsh   export ANTHROPIC_API_KEY='YOUR_KEY_HERE'\n\n" +
      "  A live run sends this suite's briefs to api.anthropic.com and spends money.\n" +
      "  Without --live, `npm run eval` stays offline against pinned stubs.",
    );
    return 2;
  }

  /**
   * A key that cannot possibly be one is refused HERE, not by the API.
   *
   * Presence was the only test, and presence is the honest thing for this script to read —
   * but it means a placeholder passes and the failure relocates to a 401 partway through a
   * paid run, which is the worst place for it: the budget is already committed, the error is
   * remote, and the message names an HTTP status rather than the mistake.
   *
   * Observed, not hypothetical. `setx ANTHROPIC_API_KEY "<your key>"` was run verbatim from
   * a copy-pasted instruction, and the guard above waved through a ten-character value whose
   * first character is `<`. The message that produced it is fixed above; this is the check
   * that catches it whatever the wording does next.
   *
   * These are shapes NO key has, not a format assertion. Asserting `sk-ant-` and a length
   * would fail closed the day the vendor changes either, and this script has no business
   * knowing that. Angle brackets, quotes and whitespace mean "you pasted the wrong thing",
   * and they mean it permanently. Validating the key for real needs a network call, which is
   * the thing being guarded.
   */
  const rawKey = process.env.ANTHROPIC_API_KEY;
  if (LIVE && rawKey) {
    const looksPasted = implausibleKeyReason(rawKey);
    if (looksPasted) {
      console.error(
        `eval --live: ANTHROPIC_API_KEY is set, but its value ${looksPasted}.\n\n` +
        "  That is a placeholder or a truncated paste, not a key. Refusing here rather than\n" +
        "  letting api.anthropic.com reject it after the run has started spending.\n\n" +
        "  The value is not shown, and was not read for any purpose other than this check.",
      );
      return 2;
    }
  }

  /**
   * An unbounded live run is refused by construction.
   *
   * `admitRun` returns "no budget declared" and admits everything when `budget` is null, so
   * without this the first real 100-trial run would have been the unbounded one — 1,400 calls
   * with nothing able to stop them. Phase γ's entry criterion was "budget enforcement written
   * before the first real call"; the enforcement existed and nothing declared a budget for it
   * to enforce.
   */
  if (LIVE && MAX_CALLS === undefined) {
    console.error(
      "eval --live: no budget declared.\n\n" +
      `  This run would make up to ${data.suite.case_ids.length * TRIALS} provider call(s) ` +
      "with nothing able to stop it.\n" +
      "  Say what it may spend:\n\n" +
      `    npm run eval -- --live --trials ${TRIALS} --max-calls ${data.suite.case_ids.length * TRIALS}\n\n` +
      "  There is no default on purpose. A generous one and a stingy one are both defensible,\n" +
      "  so choosing either for you is the bug — the same reason Budget.on_exceed is mandatory.",
    );
    return 2;
  }

  const liveWiring = LIVE
    ? { provider: new LocalProxyProvider(), cache: new MemoryCacheStore() }
    : {};

  /**
   * The plan is printed before anything is spent, not after.
   *
   * A cost report that only appears once the money is gone is a receipt, not a control. This
   * is the number `admitRun` is about to check, shown while it can still be cancelled.
   */
  if (LIVE) {
    console.log(
      `\n  live run — ${data.suite.case_ids.length} case(s) x ${TRIALS} trial(s) = ` +
      `up to ${data.suite.case_ids.length * TRIALS} provider call(s)\n` +
      `    budget      ${MAX_CALLS === undefined ? "NONE DECLARED" : MAX_CALLS + " call(s), refuse on exceed"}\n` +
      `    destination api.anthropic.com (hard-coded, frozen allowlist)\n`,
    );
  }

  /**
   * A budget refusal is an expected outcome, not a crash.
   *
   * `runSuite` throws so a caller cannot ignore it, which is right. Presenting that as an
   * unhandled stack trace is not: "refused before dispatch, nothing was spent" is the guard
   * working exactly as designed, and it should read that way.
   */
  let result: Awaited<ReturnType<typeof runSuite>>;
  try {
    result = await runSuite({
      suite: data.suite, cases: data.cases, configuration, trials: TRIALS, ...liveWiring,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("refused before dispatch")) {
      console.error(`\neval: ${message}`);
      return 2;
    }
    throw err;
  }
  const { run, perCase } = result;

  if (LIVE) {
    const c = run.cost;
    console.log(
      `\n  live provider — ${run.provenance.provider}\n` +
      `    provider calls  ${c.provider_calls}\n` +
      `    cache hits      ${c.cache_hits ?? 0}\n` +
      `    tokens          ${c.tokens_in} in / ${c.tokens_out} out\n` +
      `    usd             ${c.usd === null ? "unmeasured (no rate supplied)" : c.usd}\n` +
      `    budget exceeded ${c.budget_exceeded}`,
    );
  }

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
  // "no network" was hard-coded and stopped being true the moment --live existed. The line
  // now reports which transport actually answered, because that is the difference between a
  // run that is evidence about a model and one that is evidence about the accounting.
  console.log(
    `  configuration ${run.configuration_id.slice(0, 12)} · ${run.cost.provider_calls} ` +
    `${LIVE ? "live" : "pinned"} provider call(s)${LIVE ? "" : ", no network"}\n`,
  );

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
