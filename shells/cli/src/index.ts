#!/usr/bin/env node
/**
 * The CLI shell.
 *
 * It calls the Application protocol and nothing else. It does not import Core,
 * and it does not name an adapter — `composition-root.ts` does that, and it is
 * the only file in this Shell allowed to.
 *
 * The header used to claim "it does not call an adapter" while importing two of
 * them eleven lines below. That is now true rather than asserted, and
 * `npm run lint:boundaries` is what keeps it true.
 *
 *   nexusprompt lint <file>
 *   nexusprompt run --stage compile <file>
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { lint, listPortedGates, worstVerdict } from "../../../application/src/lint.js";
import { composeEvidence, composeOrchestrator, composePipeline } from "./composition-root.js";
import { current } from "../../../application/src/release.js";
import { runPipeline, MAX_FEEDBACK_ROUNDS } from "../../../application/src/pipeline.js";
import type { ObservabilityEvent, PipelineCommand } from "../../../contracts/index.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  pass: (s: string) => `\x1b[36m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  fail: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const paint = (v: string) => (v === "PASS" ? C.pass(v) : v === "WARN" ? C.warn(v) : C.fail(v));

/* ── argument parsing, once, for every command ─────────────────────────────── */

/**
 * Flags that consume the argv entry after them.
 *
 * This list is the one thing `fileArg` cannot derive: only the code reading a flag knows
 * whether it takes a value. So it is declared here and held to the code by a test —
 * `shells/cli/test/argument-parsing.test.ts` greps this file for every `flagValue(argv, "--x")`
 * call and fails if one is missing from these sets. Adding a value-taking flag without
 * listing it would otherwise make its VALUE parse as the filename, which is precisely the
 * confusing `ENOENT` the file-argument fix exists to prevent.
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--stage", "--stakes", "--depth", "--test", "--max-calls", "--model", "--timeout",
]);

/**
 * Flags whose value is optional, taken only when the next entry is a bare integer.
 *
 * `--reflexive` alone means one round, `--reflexive 3` means three. Consuming
 * unconditionally would eat the filename in `pipeline --reflexive brief.txt`; never
 * consuming would make `--reflexive 3 brief.txt` resolve the file as `3`.
 */
export const OPTIONAL_NUMERIC_FLAGS: ReadonlySet<string> = new Set(["--reflexive"]);

/**
 * The first argv entry that is neither a flag nor a flag's value.
 *
 * Every command that takes a file uses this. Three commands used to disagree about it:
 * `lint` read `argv[1]` unconditionally and handed `--foo` to `readFile`; `pipeline` refused
 * outright when `argv[1]` began with `--`, so `pipeline --stakes HIGH brief.txt` printed usage;
 * `run` scanned for the first non-flag but consulted a skip-list naming only its own flag.
 * The same invocation shape therefore worked, printed usage, or died on ENOENT depending on
 * which word came first.
 *
 * A leading `-` always marks a flag, so a filename cannot begin with one. That is the normal
 * POSIX trade and is worth stating: pass `./-weird.txt` for such a file.
 */
export function fileArg(argv: readonly string[], from = 1): string | undefined {
  for (let i = from; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      else if (OPTIONAL_NUMERIC_FLAGS.has(a) && /^\d+$/.test(argv[i + 1] ?? "")) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** The value after `--name`, or undefined. Shared so parsing and `fileArg` cannot disagree. */
export const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

/**
 * What the evidence plane holds, and what is currently promoted.
 *
 * Reports zero as zero. "No promotion has ever been recorded" is a true and useful thing for
 * this command to say — the release gate exists and is tested against each of its five
 * conditions, and it has never been run against a real evaluation because no run here has
 * ever reached a provider. A command that hid that behind an empty table would be the same
 * mistake `CAPABILITY_MATRIX.md` made for months.
 */
async function cmdEvidence(): Promise<number> {
  const store = composeEvidence({ sink: { emit() {} } });
  const kinds = ["eval-run", "comparison", "baseline", "promotion"] as const;

  console.log("evidence plane\n");
  let total = 0;
  for (const kind of kinds) {
    const rows = await store.list(kind);
    total += rows.length;
    console.log(`  ${kind.padEnd(12)} ${String(rows.length).padStart(4)}`);
    for (const r of rows.slice(0, 5)) console.log(`      ${C.dim(r.created_at)}  ${r.id}`);
    if (rows.length > 5) console.log(`      ${C.dim(`... and ${rows.length - 5} more`)}`);
  }

  const now = await current(store);
  console.log(
    now === null
      ? "\n  current: nothing has ever been promoted."
      : `\n  current: ${now.configuration_id.slice(0, 12)} via ${now.promotion_id} (${now.kind}), ` +
        `run ${now.eval_run_id}, comparison ${now.comparison_id}`,
  );
  if (total === 0) {
    console.log(
      "\n  The plane is empty. The release gate is built and tested; it has never been run\n" +
      "  against a real evaluation, because no run here has reached a provider.",
    );
  }
  return 0;
}

async function cmdLint(file: string): Promise<number> {
  const text = await readFile(file, "utf8");
  const report = lint(text);

  console.log(
    `${C.bold("lint")} ${file}   ` +
      C.dim(`${report.ported_gate_count} of ${report.source_gate_count} gates ported`),
  );
  for (const r of report.results) {
    console.log(`  ${paint(r.verdict.padEnd(4))} ${r.gate_id}`);
    if (r.verdict !== "PASS") console.log(`       ${C.dim(r.message)}`);
  }

  // Exit codes match the source linter: 0 PASS · 1 GATE_FAIL · 3 DEGRADED.
  // Precedence lives in the Application layer so two Shells cannot disagree.
  const worst = worstVerdict(report.results);
  return worst === "FAIL" ? 1 : worst === "WARN" ? 3 : 0;
}

/**
 * One stage, end to end. `--stage` accepts `compile` and refuses everything else.
 *
 * It used to accept anything and run `compile` regardless: `run --stage harden brief.txt`
 * printed `Stage "compile" did not run against a model.` The flag was parsed, skipped over by
 * the argument scanner, and then discarded — `cmdRun` took only a filename.
 *
 * Refusing rather than honouring it is the accurate fix, and the reason is one layer down.
 * `Orchestrator.run` imports `decide`/`reduce` directly from `core/src/stages/compile.js` and
 * uses `command.stage_id` only to LABEL the revision it persists. Passing `harden` through
 * would therefore write a revision recorded as `harden` whose output came from `compile` — a
 * provenance lie, strictly worse than ignoring the flag, in a repository whose whole claim is
 * that a stored record says what produced it. Running a different stage needs the Orchestrator
 * to select one, which is real work and not a Shell's decision to fake.
 */
const RUNNABLE_STAGES = ["compile"] as const;

async function cmdRun(file: string, stage: string): Promise<number> {
  if (!(RUNNABLE_STAGES as readonly string[]).includes(stage)) {
    console.error(
      `nexusprompt: --stage ${stage} is not available on \`run\`.\n` +
      `  The single-stage path runs ${RUNNABLE_STAGES.join(", ")} only — the Orchestrator is wired\n` +
      `  to that one stage, and accepting another would record a revision under a stage name\n` +
      `  that did not produce it. Use \`nexusprompt pipeline <file>\` for the full eleven.`,
    );
    return 2;
  }
  const brief = await readFile(file, "utf8");
  const run_id = randomUUID().replace(/-/g, "").slice(0, 16);

  const events: ObservabilityEvent[] = [];
  const orchestrator = composeOrchestrator({ sink: { emit: (e) => events.push(e) } });

  const command: PipelineCommand = {
    command_id: randomUUID(),
    run_id,
    stage_id: "compile",
    input: { brief },
  };

  const outcome = await orchestrator.run(command);

  if (outcome.demo_mode) {
    console.log(C.warn("\n  demo mode — no model produced this output\n"));
  }
  console.log(outcome.output.text);
  console.log(C.dim(`\n─── gates ───`));
  for (const r of outcome.gate_results) {
    console.log(`  ${paint(r.verdict.padEnd(4))} ${r.gate_id}`);
  }
  console.log(
    C.dim(
      `\nrun ${outcome.run_id} · revision ${outcome.revision_id.slice(0, 8)} · ` +
        `${events.length} events · core ${outcome.execution_provenance.core_build_hash}`,
    ),
  );

  return outcome.demo_mode ? 3 : 0;
}

/**
 * Run the whole pipeline over a brief.
 *
 * The Shell's job here is argument parsing and presentation. Every decision about WHICH
 * stages run belongs to Core's depth plan, and every effect to the Application — this
 * function chooses neither, which is what keeps the boundary rule checkable.
 *
 * Exit codes follow the linter's convention rather than inventing a second one:
 *   0  every stage ran and the gates were clean
 *   1  a gate FAILed, or a stage threw
 *   3  the run degraded, or the gates warned
 */
async function cmdPipeline(file: string, argv: string[]): Promise<number> {
  // Shared with `fileArg`, so the rule that decides which entries are values is the same rule
  // that decides which entries are not the filename. The local helper this replaced took an
  // undashed name and rebuilt `--${name}`, which meant the two could disagree silently.
  const flag = (name: string) => flagValue(argv, `--${name}`);

  const brief = await readFile(file, "utf8");
  const run_id = randomUUID().replace(/-/g, "").slice(0, 16);
  const stakes = flag("stakes") ?? "MEDIUM";

  /**
   * `--model NAME` sends the run to a model on this machine instead of through the proxy.
   *
   * Not the shell's first route to a model — `LocalProxyProvider` reaches api.anthropic.com
   * when `ANTHROPIC_API_KEY` is set. It is the first FREE one. Every persisted revision here
   * carries a null fingerprint and `check:fingerprint` reports "not armed" because the only
   * runs anyone made were keyless ones that degraded, and `npm run eval -- --local` reaches a
   * model but persists nothing. So the sole way to store a revision that is evidence about a
   * model was to spend money.
   */
  const localModel = flag("model");
  if (localModel !== undefined && localModel.trim() === "") {
    console.error(
      "nexusprompt: --model needs a model name, e.g. --model llama3.1:8b.\n" +
      "  `ollama list` shows what this machine has pulled. Without --model the run uses the\n" +
      "  local proxy, reaches no model, and labels every stage as demo output.",
    );
    return 2;
  }

  /**
   * `--timeout SECONDS` raises the per-generation ceiling for a local model.
   *
   * The adapter defaults to 120s and predicts its own limit: "a 27B model on CPU will exceed
   * it, which is a real configuration rather than a fault." What that costs is not a slow
   * run but an EMPTY one — `phi4-reasoning:plus` at LOW stakes timed out on its first
   * generating stage, so `compile` went DEMO, `preview` skipped behind the placeholder
   * guard, and the persisted bundle carried four revisions and zero fingerprints. Nothing to
   * pin, and `check:fingerprint` none the wiser.
   *
   * Refused without `--model`, for the reason `--model` is refused without a transport in the
   * eval runner: the hosted proxy has its own timeout and this flag does not reach it, so
   * accepting it there would silently do nothing.
   */
  const timeoutRaw = flag("timeout");
  let localTimeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (localModel === undefined) {
      console.error(
        "nexusprompt: --timeout applies to a local model, but --model was not given.\n" +
        "  Add --model <name>, or drop --timeout. The hosted proxy has its own timeout and\n" +
        "  this flag does not reach it.",
      );
      return 2;
    }
    const secs = Number(timeoutRaw);
    if (!Number.isInteger(secs) || secs < 1) {
      console.error(
        `nexusprompt: --timeout must be a positive whole number of seconds; got ${JSON.stringify(timeoutRaw)}.`,
      );
      return 2;
    }
    localTimeoutMs = secs * 1000;
  }

  const events: ObservabilityEvent[] = [];

  /**
   * `--max-calls` must be a positive integer when given at all.
   *
   * A silently-dropped budget flag is worse than no flag: the operator believes a cap is in
   * force and it is not. `run-eval.ts` refuses the same way for the same reason, and the
   * truth boundary's `live_requires_declared_budget` is the entry that rests on it.
   */
  const maxCallsRaw = flag("max-calls");
  let maxCalls: number | undefined;
  if (maxCallsRaw !== undefined) {
    maxCalls = Number(maxCallsRaw);
    if (!Number.isInteger(maxCalls) || maxCalls < 1) {
      console.error(
        `nexusprompt: --max-calls must be a positive integer; got ${JSON.stringify(maxCallsRaw)}.\n` +
        `  A budget that cannot be parsed must not become a run with no budget.`,
      );
      return 2;
    }
  }

  // `--reflexive` with no number means one round; the flag is opt-in either way.
  const reflexiveFlag = argv.indexOf("--reflexive");
  const reflexive = reflexiveFlag === -1
    ? undefined
    : Math.max(1, Number.parseInt(flag("reflexive") ?? "", 10) || 1);

  /**
   * Refuse above the declared cap rather than clamp silently.
   *
   * Core clamps as the backstop, so no caller can exceed it — but a Shell that accepted
   * `--reflexive 10` and quietly ran 3 would answer a different question than the one asked.
   * `contracts/reliability-budget.json` caps rounds because every round is two more stage
   * executions against the error budget: at 10 rounds a run reaches depth 31, where the
   * declared per-stage floor yields 85.6% against a 90% target.
   */
  if (reflexive !== undefined && reflexive > MAX_FEEDBACK_ROUNDS) {
    console.error(
      `nexusprompt: --reflexive ${reflexive} exceeds the declared max_feedback_rounds ` +
      `(${MAX_FEEDBACK_ROUNDS}).
` +
      `  Every round is two more stage executions against the error budget in
` +
      `  contracts/reliability-budget.json. Raising the cap is a deliberate change there,
` +
      `  and \`npm run check:depth\` fails the build if the budget cannot carry it.`,
    );
    return 2;
  }

  const result = await runPipeline(
    {
      command_id: randomUUID(),
      run_id,
      stage_id: "deconstruct",
      input: { brief },
      context: {
        stakes,
        // Depth is DERIVED from stakes unless given, which is the frozen component's own
        // binding. Passing neither runs the full eleven.
        depth: flag("depth"),
        testMessage: flag("test") ?? "Hello — can you help me with something?",
        // Opt-in. Without it the run is sequential and identical to what ran before gate
        // feedback existed; with it a gate FAIL routes back to `refine`, capped. The cap
        // is bounded by the depth budget, which check:depth enforces — every round is two
        // more stage executions.
        ...(reflexive === undefined ? {} : {
          topology: { kind: "reflexive" as const, max_iterations: reflexive },
        }),
      },
    },
    {
      ...composePipeline({
        sink: { emit: (e) => events.push(e) },
        // Absent keeps the degrading proxy. Naming a model is the whole opt-in: there is no
        // default, because one this machine has not pulled 404s in a way that reads like an
        // outage, and one it has bakes a local accident into shared wiring.
        ...(localModel === undefined ? {} : { localModel }),
        ...(localTimeoutMs === undefined ? {} : { localTimeoutMs }),
      }),
      coreBuildHash: "cli",
      /**
       * Opt-in, and absent means unbounded — the same rule `admitRun` states and the
       * evaluation path follows. Made reachable because the pipeline path is the one that
       * wires a real provider, and a budget no shell can declare is a guard nothing can
       * exercise.
       */
      ...(maxCalls === undefined ? {} : {
        budget: { on_exceed: "refuse" as const, max_provider_calls: maxCalls, max_usd: null },
      }),
    },
  );

  const plan = result.stages;
  console.log(
    `${C.bold("pipeline")} ${file}   ` +
      C.dim(`run ${run_id} · stakes ${stakes} · ${plan.length} stage(s)`),
  );

  const mark = (s: string) =>
    s === "SUCCEEDED" ? C.pass("ok  ") : s === "SKIPPED" ? C.dim("skip") : s === "DEMO" ? C.warn("demo") : C.fail("FAIL");
  for (const s of plan) console.log(`  ${mark(s.status)} ${s.stage_id}`);

  // A declared cap that could not be checked is reported, not swallowed. Silence here would
  // be indistinguishable from "the cap held".
  for (const u of result.budget_unenforced) {
    console.log(C.warn(`\nbudget NOT enforced: ${u}`));
  }

  const rounds = result.context.feedbackRounds ?? 0;
  if (rounds) {
    console.log(
      C.dim(`\n${rounds} gate-feedback round(s) — a gate FAIL routed back to refine, capped at ${reflexive}.`),
    );
  }

  if (result.context.lint) console.log(`\n${result.context.lint}`);

  // The artifact, or an honest statement that there is not one.
  const prompt = result.context.prompt;
  if (prompt) {
    console.log(`\n${C.bold("compiled prompt")}`);
    console.log(prompt);
  }

  console.log(
    `\n${C.dim(`bundle: ${result.revision_ids.length} revision(s) under run ${run_id}`)}`,
  );
  if (result.demo_mode) {
    // Said plainly rather than left for the reader to notice the marker. A degraded run
    // still produces an artifact; what it must never do is let that artifact pass as live.
    console.log(C.warn("\nThis run degraded — at least one stage never reached a model."));
    console.log(C.dim("Output above is labelled placeholder text, not model output."));
  }
  if (result.failed) console.log(C.fail("\nAt least one stage threw. See the bundle for which."));

  if (result.failed || result.context.lintStatus === "GATE_FAIL") return 1;
  if (result.demo_mode || result.context.lintStatus === "DEGRADED") return 3;
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  // All three file-taking commands resolve their argument the same way. They used to use
  // three different rules, which is why one invocation shape could work, print usage, or die
  // on ENOENT depending only on which command it named.
  const file = fileArg(argv);

  if (cmd === "lint" && file) {
    process.exit(await cmdLint(file));
  }
  if (cmd === "run" && file) {
    process.exit(await cmdRun(file, flagValue(argv, "--stage") ?? "compile"));
  }
  if (cmd === "pipeline" && file) {
    process.exit(await cmdPipeline(file, argv));
  }
  if (cmd === "evidence") {
    process.exit(await cmdEvidence());
  }
  if (cmd === "gates") {
    for (const g of listPortedGates()) console.log(`  ${g.id}  ${C.dim(g.version)}`);
    process.exit(0);
  }

  console.log(`nexusprompt — usage:
  nexusprompt lint <file>              run the registered gates
  nexusprompt run --stage compile <f>  run one pipeline stage end to end
  nexusprompt pipeline <file>          run the full pipeline over a brief
  nexusprompt gates                    list registered gates
  nexusprompt evidence                 what the evidence plane holds, and what is current

pipeline options:
  --stakes LOW|MEDIUM|HIGH|SAFETY-CRITICAL   selects depth (default MEDIUM)
  --depth  TINY|MINIMAL|STANDARD|COMPREHENSIVE   overrides the stakes mapping
  --test   "<message>"                       the turn the preview stage tries
  --reflexive [N]                            route a gate FAIL back to refine, at most N
                                             times (default 1). Each round costs two more
                                             stage executions against the depth budget.
  --max-calls N                              refuse before dispatch if the run could need
                                             more than N provider calls. Checked against the
                                             WORST case for the plan selected — generating
                                             stages, plus one per feedback round, times
                                             retries — so a run that fits is guaranteed to
                                             fit. Omit it and no budget is enforced.
  --timeout SECONDS                          how long ONE generation may take before the
                                             local adapter calls it a timeout (default 120).
                                             A model too slow for the default does not
                                             produce a slow run, it produces an empty one:
                                             the first stage degrades, later stages skip
                                             behind the placeholder guard, and the bundle
                                             records no fingerprint at all. Needs --model.
  --model NAME                               run against a model on this machine through
                                             Ollama on loopback — no key, no cost, no
                                             network beyond localhost. \`ollama list\` shows
                                             what is pulled. Omit it and the run uses the
                                             local proxy, reaches no model, and labels every
                                             stage as demo output.

Stakes selects depth: LOW runs six of eleven stages, SAFETY-CRITICAL all eleven.

Two transports, and --model picks between them. Without it the run uses the local
proxy, which reaches api.anthropic.com and needs ANTHROPIC_API_KEY — so with no
key set it degrades and every stage says so, which is the honesty guarantee
working rather than a failure, and WITH one set it spends money. With --model the
run never leaves this machine and costs nothing.

exit: 0 clean · 1 a gate FAILed or a stage threw · 3 degraded or gates warned`);
  process.exit(2);
}

/**
 * Run only when executed, not when imported.
 *
 * `main()` used to be called unconditionally at module scope, so importing this file to reach
 * anything in it — `fileArg`, the flag sets — parsed the TEST RUNNER's argv, printed the usage
 * block, and killed the process with `process.exit(2)`. That is why the argument parser had no
 * unit tests: it could not be imported. `shells/api/src/index.ts` has carried this guard since
 * it was adopted; the CLI never got one.
 *
 * `pathToFileURL` rather than string-building a `file://` URL: on Windows the raw path is
 * `C:\...`, which needs both separator translation and percent-encoding to compare equal to
 * `import.meta.url`.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`promptnexus: ${(err as Error).message}`);
    process.exit(2);
  });
}
