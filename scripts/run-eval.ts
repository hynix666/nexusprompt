#!/usr/bin/env tsx
/**
 * Run a pipeline suite and report the result.
 *
 *   npm run eval                 run the smoke suite, print the verdict
 *   npm run eval -- --json       emit the EvalRun for a baseline or a comparison
 *   npm run eval -- --compare    run the baseline and the degraded variant, compare them
 *   npm run eval -- --local      run against a model on this machine (Ollama, no key, no cost)
 *   npm run eval -- --live --dry-run --max-calls N
 *                                decide, print the plan, dispatch nothing
 *
 * Three transports, and only one per run. The stub is free and offline; `--local` reaches an
 * Ollama daemon on loopback and needs a model named; `--live` reaches api.anthropic.com and
 * needs a key AND a declared budget. `provenance.provider` records which answered, which is
 * the only thing separating evidence about a model from evidence about this accounting.
 *
 * Composition root for evaluation: the only place a concrete suite path is named.
 *
 * Exit 0 every case passed, or a dry run's plan is valid and within budget
 *      · 1 a case failed
 *      · 2 the suite cannot be read, OR any live-run precondition refused: no key, a key
 *        whose shape says placeholder, no declared budget, or a budget the plan does not
 *        fit. One code for every refusal on purpose — a refusal predicted by `--dry-run`
 *        and the same refusal enforced by the live run are one decision, and `3` already
 *        means something else. `TRUTH_BOUNDARY.md` pins this.
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
import { OllamaProvider } from "../adapters/provider-ollama/src/index.js";
import { compare } from "../core/src/eval/compare.js";
import { detectorsWithoutProbes, probesWithoutDetectors, deadDetectors } from "../core/src/eval/probes.js";
import { preflight, type PreflightVerdict, type Transport } from "../core/src/eval/preflight.js";
import { partitionByTransport } from "../core/src/eval/transport-validity.js";
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

/**
 * `--local` swaps the pinned stubs for a model running on this machine.
 *
 * The third transport, and the cheapest one: no credential, no money, no network beyond
 * loopback. It is what makes an honest measured run possible at all here — `--live` needs a
 * key and a budget, and until one exists every figure this repository reports came from the
 * pinned stub.
 *
 * Mutually exclusive with `--live`. Accepting both would leave the composition root picking
 * one silently, and the run would record a `provenance.provider` the operator did not choose.
 */
const LOCAL = process.argv.includes("--local");

/**
 * Which transport this run uses, named once.
 *
 * `LIVE ? "live" : LOCAL ? "local" : "stub"` was written out at the `preflight` call and
 * nowhere else, so every other site that needed to know re-derived it from `LIVE` alone —
 * and re-derived it as a two-way choice. Deriving it once is what makes the report and the
 * preflight incapable of disagreeing about what the run is. Safe at module scope: it reads
 * argv and cannot throw, unlike the flag parsing that had to move into `main()`.
 */
const TRANSPORT: Transport = LIVE ? "live" : LOCAL ? "local" : "stub";

/**
 * How a run describes the calls it made — three transports, not two.
 *
 * This was `LIVE ? "live" : "pinned"`, a two-way branch written when there were two
 * transports. `--local` landed with ADR-0015 and fell into the else, so a run against a real
 * model on this machine printed `14 pinned provider call(s), no network`. Measured: a
 * `--local --model phi4-mini:latest` run took 69 seconds, reached the daemon fourteen times,
 * and said `pinned`.
 *
 * That is the worst direction for this particular sentence to be wrong in. `provenance.provider`
 * recorded `ollama-local` correctly the whole time, so the artifact was right and only the
 * line a person reads was wrong — which is exactly the gap between a run that is evidence
 * about a model and one that is evidence about the accounting.
 *
 * Pure and transport-taking so all three can be asserted without a daemon, a key, or money.
 */
export function callsPhrase(transport: Transport, calls: number): string {
  const noun =
    transport === "live" ? "live provider call(s)"
    : transport === "local" ? "local provider call(s), loopback only"
    : "pinned provider call(s), no network";
  return `${calls} ${noun}`;
}

const flagValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

/** Thrown rather than exited, so parsing a flag cannot kill a process that merely IMPORTED us. */
class FlagError extends Error {}

/**
 * A bad flag REPORTS; it does not exit.
 *
 * This called `process.exit(2)` directly, and `TRIALS` was parsed at module scope — so
 * importing this file to unit-test `implausibleKeyReason` could terminate the host. Verified:
 * with `--trials not-a-number` in the importer's argv, `await import(...)` never returned and
 * the process died with exit 2 before any test ran.
 *
 * The entry-point guard added for testability stopped `main()` from running but not the
 * module-level constants above it, which is the half that is easy to miss. Flags are parsed
 * inside `main()` now, and the failure is a thrown value the caller decides what to do with.
 */
const intFlag = (name: string): number | undefined => {
  const raw = flagValue(name);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new FlagError(`eval: --${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return n;
};

/**
 * Every flag this script accepts, and whether it consumes the token after it.
 *
 * A table rather than nine scattered `argv.includes` calls, because an unrecognised flag used
 * to be ignored in silence. `npm run eval -- --provider ollama-local --model llama3.1:8b
 * --max-calls 100` — from a study merged on 30 August 2026, now in
 * `proposals/external-analysis-2026-08/` — exits 0 at `score 1.000` against pinned stubs.
 * The REPORT is honest: it prints "14 pinned provider call(s), no network", and
 * `provenance.provider` records `pinned-stub`. What was missing is a refusal at the point the
 * operator's request and this script's transport disagree, which is the same shape as a
 * budget that is not declared: the answer given is not wrong, it is to a different question.
 *
 * The `--flag=value` form is deliberately NOT accepted here. `flagValue` matches an exact
 * token, so `--trials=5` never set trials and silently ran one — refusing it is the point.
 *
 * `test/eval-flags.test.ts` re-derives these names from THIS FILE's source, so a tenth flag
 * added the old way fails the suite instead of quietly re-opening the hole.
 */
export const KNOWN_FLAGS: Readonly<Record<string, "boolean" | "value">> = Object.freeze({
  live: "boolean",
  local: "boolean",
  "dry-run": "boolean",
  compare: "boolean",
  json: "boolean",
  suite: "value",
  model: "value",
  "max-calls": "value",
  trials: "value",
});

/** `--provider` is the one that actually happened, so it gets the sentence that explains it. */
const FLAG_HINTS: Readonly<Record<string, string>> = Object.freeze({
  "--provider":
    "  Transport is chosen with --live or --local — never by naming a provider. Without\n" +
    "  either, the suite runs against pinned stubs, which is a real answer but not the one\n" +
    "  --provider was asking for.",
});

const flagList = (): string =>
  Object.entries(KNOWN_FLAGS)
    .map(([n, kind]) => (kind === "value" ? `--${n} <value>` : `--${n}`))
    .join(", ");

/**
 * The whole of argv's well-formedness, as one pure decision.
 *
 * Pure and argv-taking rather than reading the module-level `LIVE`/`LOCAL`, so a test can
 * ask it about an argv the test process does not have. Returns the operator's message or
 * `null`; `main` decides that a message means exit 2.
 */
export function flagError(argv: readonly string[]): string | null {
  const unknown = argv.filter((t) => t.startsWith("--") && t !== "--" && !(t.slice(2) in KNOWN_FLAGS));
  if (unknown.length > 0) {
    const hints = unknown.map((f) => FLAG_HINTS[f]).filter((h): h is string => h !== undefined);
    return (
      `eval: unrecognised flag ${unknown.join(", ")}.\n\n` +
      `  Accepted: ${flagList()}.\n` +
      (hints.length > 0 ? `\n${hints.join("\n")}\n` : "")
    );
  }

  // `--model` is read into `localModel` and consulted only by the local transport, so under
  // any other transport it is accepted and inert — the operator names a model and none is
  // used. Keyed on the FLAG, never on the resolved model: `OLLAMA_MODEL` is a legitimate
  // fallback in the environment, and refusing a plain `npm run eval` because a shell happens
  // to export it would break the offline default this repository runs on.
  if (argv.includes("--model") && !argv.includes("--local")) {
    return (
      "eval: --model names a model for the local transport, but --local was not given.\n\n" +
      "  Add --local to run against it, or drop --model. A stub run reaches no model at all,\n" +
      "  and a live run's model is not chosen here."
    );
  }

  return null;
}

/**
 * `--dry-run` decides, prints and stops. Nothing is dispatched.
 *
 * It exists because the only way to find out whether a live invocation was well-formed was to
 * start one, and starting one spends money. The plan it prints is computed by
 * `core/src/eval/preflight.ts` — the same function the live path uses — so an approved dry run
 * is a real prediction rather than a second implementation that agrees by luck.
 */
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Turn a refusal into the message the operator reads.
 *
 * The wording lives here rather than in Core because it is presentation: which of these
 * sentences is printed is Core's decision, how it reads is the Shell's. Both the live path and
 * the dry run route through this one function, so a refusal cannot be worded one way when
 * predicted and another when enforced.
 */
function refusalMessage(v: Extract<PreflightVerdict, { ok: false }>, trials: number): string {
  const { plan } = v;
  switch (v.reason) {
    case "no_local_model":
      return (
        "eval --local: no model named.\n\n" +
        "  A local run asks an Ollama daemon for a specific model, and there is no default —\n" +
        "  a default names one this machine may not have pulled. Say which:\n\n" +
        "    PowerShell   $env:OLLAMA_MODEL = 'llama3.2'\n" +
        "    bash / zsh   export OLLAMA_MODEL=llama3.2\n\n" +
        "  `ollama list` shows what is already pulled. Unlike --live this costs nothing and\n" +
        "  needs no key, so there is no budget to declare."
      );
    case "key_missing":
      return (
        "eval --live: ANTHROPIC_API_KEY is not set in this process's environment.\n\n" +
        "  Set it yourself — nothing here will ask you for it, store it, or print it.\n" +
        "  Replace the words YOUR_KEY_HERE; do not paste the line as written:\n" +
        "    PowerShell   $env:ANTHROPIC_API_KEY = 'YOUR_KEY_HERE'    (this session only)\n" +
        "    bash / zsh   export ANTHROPIC_API_KEY='YOUR_KEY_HERE'\n\n" +
        "  A live run sends this suite's briefs to api.anthropic.com and spends money.\n" +
        "  Without --live, `npm run eval` stays offline against pinned stubs."
      );
    case "key_implausible":
      return (
        `eval --live: ANTHROPIC_API_KEY is set, but its value ${v.detail}.\n\n` +
        "  That is a placeholder or a truncated paste, not a key. Refusing here rather than\n" +
        "  letting api.anthropic.com reject it after the run has started spending.\n\n" +
        "  The value is not shown, and was not read for any purpose other than this check."
      );
    case "budget_undeclared":
      return (
        "eval --live: no budget declared.\n\n" +
        `  This run would make ${v.detail}.\n` +
        "  Say what it may spend:\n\n" +
        `    npm run eval -- --live --trials ${trials} --max-calls ${plan.plannedCalls}\n\n` +
        "  There is no default on purpose. A generous one and a stingy one are both defensible,\n" +
        "  so choosing either for you is the bug — the same reason Budget.on_exceed is mandatory."
      );
    case "budget_refused":
      return (
        `eval --live: ${v.detail}.\n\n` +
        `  ${plan.plannedCalls} planned call(s) against a cap of ${plan.maxCalls}. Nothing was spent.\n` +
        "  Raise --max-calls, lower --trials, or run a smaller suite."
      );
  }
}

/**
 * The plan, printed before anything is spent rather than after.
 *
 * A cost report that appears once the money is gone is a receipt, not a control. Every number
 * here comes from the preflight verdict, so this cannot show one plan and execute another.
 */
function printPlan(plan: PreflightVerdict["plan"], suiteId: string, dry: boolean): void {
  const perCase = plan.deterministic
    ? `1 distinct call per case — the configuration is deterministic, so trials 2..${plan.trials} would be cache hits`
    : `${plan.distinctPerCase} call(s) per case — the configuration is stochastic, so every trial is a distinct request`;

  console.log(
    `\n  ${dry ? "DRY RUN — nothing will be dispatched" : "live run"}\n\n` +
    `    suite       ${suiteId}\n` +
    `    cases       ${plan.caseCount}\n` +
    `    trials      ${plan.trials}   (${perCase})\n` +
    `    planned     ${plan.plannedCalls} provider call(s), worst case, nothing cached\n` +
    `    budget      ${plan.maxCalls === null ? "NONE DECLARED" : `${plan.maxCalls} call(s), refuse on exceed`}\n` +
    `    admission   ${plan.admission.reason}\n` +
    // The transport, said plainly. A plan that named the wrong destination would be worse
    // than one that named none — `provenance.provider` is what separates evidence about a
    // model from evidence about this system's accounting, and the plan should agree with it.
    `    transport   ${plan.transport}\n` +
    `    destination ${
      plan.transport === "live"
        ? "api.anthropic.com (hard-coded, frozen allowlist)"
        : plan.transport === "local"
          ? "an Ollama daemon on loopback (no network beyond this machine, no cost)"
          : "the pinned stub (nothing leaves this process)"
    }\n`,
  );

  for (const u of plan.admission.unenforced) {
    console.log(`  budget NOT enforced: ${u}`);
  }

  if (dry) {
    console.log(
      "\n  This is a prediction, not a reservation. `plannedCalls` is the worst case with\n" +
      "  nothing cached; the real run re-checks it through the same `admitRun` before it\n" +
      "  spends anything. No token or dollar estimate is printed: this repository has no\n" +
      "  pinned rate, and a made-up one is a claim about the world that would decay silently.\n\n" +
      "  Drop --dry-run to execute it.\n",
    );
  }
}

async function main(): Promise<number> {
  /**
   * A live run must declare what it may spend, and there is no default.
   *
   * Phase γ's entry criterion was "budget enforcement written before the first real call".
   * `admitRun` has existed since then and this composition root never declared a budget, so
   * the FIRST live run would have been the unbounded one — `admitRun` would have returned
   * "no budget declared" and admitted all 1,400 calls of a 100-trial suite. A guard that
   * exists and is not wired is the defect this repository keeps finding, and it was sitting
   * in the one place where the cost of missing it is measured in money.
   *
   * Requiring the flag rather than defaulting it: both a generous default and a stingy one
   * are defensible, so picking either for the caller is the bug — the same reasoning that
   * makes `Budget.on_exceed` mandatory.
   */
  let TRIALS: number;
  let MAX_CALLS: number | undefined;
  try {
    // Before anything is parsed, and long before anything is dispatched: a flag this script
    // does not have means the operator asked for a run it cannot do.
    const bad = flagError(process.argv);
    if (bad !== null) throw new FlagError(bad);
    TRIALS = intFlag("trials") ?? 1;
    MAX_CALLS = intFlag("max-calls");
  } catch (err) {
    if (!(err instanceof FlagError)) throw err;
    console.error(err.message);
    return 2;
  }

  const SUITE = process.argv.includes("--suite")
    ? process.argv[process.argv.indexOf("--suite") + 1]
    : "eval/compile-smoke.json";

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

  /**
   * Cases that only mean what they say under the pinned stub are excluded, and SAID.
   *
   * `secret-in-output-is-flagged` asserts `SECRET_LEAK_SCAN → WARN`, reachable only because
   * the stub content carries a planted key. A real transport replaces that stub, the gate
   * correctly passes, and the case fails — so failing means the model did NOT leak a secret.
   * Measured: it failed 0/9 across three local models, and its overclaim twin PASSED once,
   * for a model that wrote guarantee language. The suite was scoring the defect.
   *
   * Printed rather than filtered in silence. The denominator changes, and a denominator that
   * changes without saying so is the same kind of quiet rescale as the inversion itself.
   *
   * ABOVE the preflight deliberately. The plan reports the cases and the provider calls this
   * run will make; a plan promising fourteen while the run scores twelve would describe a
   * different run, which is the disagreement between printed plan and executed run that
   * `--dry-run` exists to make impossible.
   */
  const { runnable, excluded } = partitionByTransport(data.cases, TRANSPORT);

  /**
   * Computed here, REPORTED after the preflight. A run that is about to refuse for want of a
   * key should not first announce which cases it selected — `example:refuse` exists to show
   * that a keyless live run produces nothing, and the refusal has to be the first thing read.
   */
  const reportExclusions = (): void => {
    if (excluded.length === 0) return;
    console.log(
      `eval: ${excluded.length} of ${data.cases.length} case(s) excluded — they assert a gate FIRES,\n` +
      `  which needs the content the pinned stub plants. On the ${TRANSPORT} transport the model\n` +
      "  writes the output, the gate correctly stays quiet, and the case would score a model\n" +
      "  that behaved WELL as a failure:\n" +
      excluded.map((c) => `    ${c.case_id}`).join("\n") +
      `\n  Scoring ${runnable.length} case(s).\n`,
    );
  };

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
   * A dry run plans a LIVE run. Without --live there is nothing to plan.
   *
   * Silently printing a free plan would be the worse behaviour: the operator would come away
   * believing they had validated an invocation, when a stubbed run needs no key, applies no
   * budget and spends nothing, so approving it says nothing about the run they meant.
   */
  /**
   * One transport per run, chosen explicitly.
   *
   * Accepting both flags would leave this composition root picking one silently, and the
   * artifact would record a `provenance.provider` the operator did not choose — which is the
   * one field separating evidence about a model from evidence about this system's accounting.
   */
  if (LIVE && LOCAL) {
    console.error(
      "eval: --live and --local name two different transports.\n\n" +
      "  --live  sends the suite to api.anthropic.com. Needs a key and a declared budget.\n" +
      "  --local sends it to an Ollama daemon on this machine. Needs a model named.\n\n" +
      "  Pick one. The run records which answered, and it cannot record both.",
    );
    return 2;
  }

  if (DRY_RUN && !LIVE && !LOCAL) {
    console.error(
      "eval --dry-run: --dry-run plans a run against a real transport, and this invocation\n" +
      "  names neither --live nor --local.\n\n" +
      "  Against pinned stubs no key is read, no budget applies, and nothing is spent. There\n" +
      "  is no plan to approve.\n\n" +
      "  Add --live or --local to plan a real run, or drop --dry-run and just run it.",
    );
    return 2;
  }

  /**
   * Every precondition for a live run, decided in one place.
   *
   * Four checks — no key, a key whose shape says placeholder, no declared budget, and a budget
   * the plan does not fit — used to sit inline here. `--dry-run` made a second caller, and a
   * dry run that approves what the real run then refuses is worse than no dry run: it converts
   * a safety check into a source of false confidence. `preflight` is the only thing that
   * decides now, and it reaches its budget verdict by calling the same `plannedCalls` and
   * `admitRun` that `runSuite` calls, so the prediction and the enforcement are one code path.
   *
   * `runSuite` still calls `admitRun` itself. A decision made at the top of `main()` is a
   * prediction; the enforcement has to sit where the spending starts.
   *
   * Presence of the key is all that is read here. The value belongs to the adapter and to
   * `process.env`; routing it through this script would put it one careless log line away from
   * a terminal, and `implausibleKeyReason` is written never to quote it back.
   */
  /** Explicit flag wins; `OLLAMA_MODEL` is the fallback. No default model name anywhere. */
  const localModel = flagValue("model") ?? process.env.OLLAMA_MODEL;

  const verdict = preflight({
    transport: TRANSPORT,
    key: process.env.ANTHROPIC_API_KEY,
    budget: configuration.budget,
    trials: TRIALS,
    // What will RUN, not what the suite file lists — see the partition above. A plan that
    // counted excluded cases would over-state the budget a live run needs.
    caseCount: runnable.length,
    decoding: configuration.decoding,
    localModel,
  });

  if (!verdict.ok) {
    console.error(refusalMessage(verdict, TRIALS));
    return 2;
  }

  reportExclusions();
  if (LIVE || LOCAL) printPlan(verdict.plan, data.suite.suite_id, DRY_RUN);

  /**
   * A dry run stops here, having dispatched nothing.
   *
   * Exit 0 means the plan is valid and within budget — not that the run succeeded, which it was
   * never asked to do. Every refusal above returns 2, the same code the other live-path
   * refusals use and the one `TRUTH_BOUNDARY.md` pins. Giving the dry run its own exit codes
   * would have made a prediction and an enforcement report different numbers for one decision,
   * and `3` in particular already means "degraded or gates warned" on every command here.
   */
  if (DRY_RUN) return 0;

  /**
   * Naming a concrete adapter is what a composition root is for. Everything below still sees
   * only the `ProviderTransport` port.
   *
   * The cache is on for both real transports, for different reasons. Hosted: a second
   * identical request must report a non-zero cache read, which is the only way to tell a
   * working cache from a silently invalidated one. Local: a 27B model on CPU takes seconds
   * per call, so a repeat is worth minutes rather than money.
   */
  const liveWiring = LIVE
    ? { provider: new LocalProxyProvider(), cache: new MemoryCacheStore() }
    : LOCAL
      ? { provider: new OllamaProvider({ model: localModel }), cache: new MemoryCacheStore() }
      : {};

  /**
   * A budget refusal is an expected outcome, not a crash.
   *
   * `runSuite` throws so a caller cannot ignore it, which is right. Presenting that as an
   * unhandled stack trace is not: "refused before dispatch, nothing was spent" is the guard
   * working exactly as designed, and it should read that way.
   */
  /**
   * The suite runs what the partition above left runnable.
   */
  /**
   * BOTH halves narrowed, because `runSuite` iterates the SUITE's `case_ids`, not the array.
   *
   * Filtering only `cases` does not skip the excluded ones — it makes them fail as missing:
   * `runSuite` looks each `case_id` up in the array and records `failure_mode: "unknown"` for
   * anything absent, under the correct rule that "a suite naming a case nobody wrote must
   * fail, not silently shrink". So the first attempt at this exclusion made the two inverting
   * cases score 0 instead of not scoring at all, which is worse than the defect it was fixing:
   * the run reported 11/14 where an honest exclusion reports 11/12.
   *
   * Measured before this line existed: `--local --model phi4-mini:latest` printed
   * "2 of 14 case(s) excluded / Scoring 12 case(s)" and then listed all fourteen, with
   * `secret-in-output-is-flagged` and `overclaim-in-output-is-flagged` FAILED as "unknown".
   */
  const runnableSuite = { ...data.suite, case_ids: runnable.map((c) => c.case_id) };

  let result: Awaited<ReturnType<typeof runSuite>>;
  try {
    result = await runSuite({
      suite: runnableSuite, cases: runnable, configuration, trials: TRIALS, ...liveWiring,
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

  /**
   * Printed for BOTH real transports, not just the paid one.
   *
   * `provenance.provider` is the single field separating evidence about a model from
   * evidence about this accounting, and it was shown only under `--live`. So the transport a
   * person can actually run — no key, no cost — was the one that never told them which
   * provider answered. Gating a fact on whether it was expensive to obtain is backwards.
   */
  if (TRANSPORT !== "stub") {
    const c = run.cost;
    console.log(
      `\n  ${TRANSPORT} provider — ${run.provenance.provider}\n` +
      `    provider calls  ${c.provider_calls}\n` +
      `    cache hits      ${c.cache_hits ?? 0}\n` +
      `    tokens          ${c.tokens_in} in / ${c.tokens_out} out\n` +
      // A local run spends nothing, and "unmeasured" would read as "we did not check".
      `    usd             ${TRANSPORT === "local" ? "0 — runs on this machine"
        : c.usd === null ? "unmeasured (no rate supplied)" : c.usd}\n` +
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
  // Three-way since ADR-0015's local tier: the two-way version called a 69-second run
  // against phi4-mini "pinned". `callsPhrase` is where all three are decided and asserted.
  console.log(
    `  configuration ${run.configuration_id.slice(0, 12)} · ` +
    `${callsPhrase(TRANSPORT, run.cost.provider_calls)}\n`,
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
