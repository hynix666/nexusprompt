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
 *   promptnexus lint <file>
 *   promptnexus run --stage compile <file>
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { lint, listPortedGates, worstVerdict } from "../../../application/src/lint.js";
import { composeOrchestrator, composePipeline } from "./composition-root.js";
import { runPipeline } from "../../../application/src/pipeline.js";
import type { ObservabilityEvent, PipelineCommand } from "../../../contracts/index.js";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  pass: (s: string) => `\x1b[36m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  fail: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const paint = (v: string) => (v === "PASS" ? C.pass(v) : v === "WARN" ? C.warn(v) : C.fail(v));

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

async function cmdRun(file: string): Promise<number> {
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
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const brief = await readFile(file, "utf8");
  const run_id = randomUUID().replace(/-/g, "").slice(0, 16);
  const stakes = flag("stakes") ?? "MEDIUM";
  const events: ObservabilityEvent[] = [];

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
      },
    },
    { ...composePipeline({ sink: { emit: (e) => events.push(e) } }), coreBuildHash: "cli" },
  );

  const plan = result.stages;
  console.log(
    `${C.bold("pipeline")} ${file}   ` +
      C.dim(`run ${run_id} · stakes ${stakes} · ${plan.length} stage(s)`),
  );

  const mark = (s: string) =>
    s === "SUCCEEDED" ? C.pass("ok  ") : s === "SKIPPED" ? C.dim("skip") : s === "DEMO" ? C.warn("demo") : C.fail("FAIL");
  for (const s of plan) console.log(`  ${mark(s.status)} ${s.stage_id}`);

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

  if (cmd === "lint" && argv[1]) {
    process.exit(await cmdLint(argv[1]));
  }
  if (cmd === "run") {
    const file = argv[argv.indexOf("--stage") === -1 ? 1 : argv.length - 1];
    if (file) process.exit(await cmdRun(file));
  }
  if (cmd === "pipeline" && argv[1] && !argv[1].startsWith("--")) {
    process.exit(await cmdPipeline(argv[1], argv));
  }
  if (cmd === "gates") {
    for (const g of listPortedGates()) console.log(`  ${g.id}  ${C.dim(g.version)}`);
    process.exit(0);
  }

  console.log(`promptnexus — usage:
  promptnexus lint <file>              run the registered gates
  promptnexus run --stage compile <f>  run one pipeline stage end to end
  promptnexus pipeline <file>          run the full pipeline over a brief
  promptnexus gates                    list registered gates

pipeline options:
  --stakes LOW|MEDIUM|HIGH|SAFETY-CRITICAL   selects depth (default MEDIUM)
  --depth  TINY|MINIMAL|STANDARD|COMPREHENSIVE   overrides the stakes mapping
  --test   "<message>"                       the turn the preview stage tries

Stakes selects depth: LOW runs six of eleven stages, SAFETY-CRITICAL all eleven.
Without ANTHROPIC_API_KEY the run degrades and every stage says so — that is the
honesty guarantee working, not a failure.

exit: 0 clean · 1 a gate FAILed or a stage threw · 3 degraded or gates warned`);
  process.exit(2);
}

main().catch((err) => {
  console.error(`promptnexus: ${(err as Error).message}`);
  process.exit(2);
});
