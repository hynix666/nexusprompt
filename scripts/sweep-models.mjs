/**
 * Run N trials of the eval suite per model, appending as it goes.
 *
 *   npm run sweep:models -- --models phi4-mini:latest,gemma4:e4b --trials 3 --out .sweep
 *
 * APPEND-ONLY, one line per completed run. The ad-hoc version of this was killed twice
 * mid-sweep and its partial data was still usable, which is the property worth keeping: a
 * twenty-minute model failing must not discard the three that already succeeded.
 *
 * Writes the two files `compare-models.ts` reads; that file documents the format.
 *
 * Stays `.mjs` while the rest of this sub-project is `.ts` because it imports nothing from
 * Core — it spawns the eval runner as a subprocess. The rule is the file's dependencies, not
 * its neighbours: a script importing Core must be `.ts` or vitest cannot load it transitively.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseSweepArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const models = (value("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error("sweep: --models needs a comma-separated list of model names.");
  }

  // Three by default: one trial gives no variance at all, and variance is the measurement.
  const raw = value("trials") ?? "3";
  const trials = Number(raw);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`sweep: --trials must be a positive integer, got ${JSON.stringify(raw)}.`);
  }

  return { models, trials, outDir: value("out") ?? ".sweep", suite: value("suite") };
}

/**
 * Exactly the shape `parseRuns` reads, built here so one format has one definition.
 *
 * Whitespace is collapsed because the runner indents its output, and that indentation would
 * otherwise reach the file and the parser's regexes.
 */
export function formatRunLine(model, trial, secs, exit, scoreLine, tokenLine) {
  const score = (scoreLine ?? "").trim().replace(/\s+/g, " ");
  const tokens = (tokenLine ?? "").trim().replace(/\s+/g, " ");
  return `RUN|${model}|${trial}|secs=${secs}|exit=${exit}|${score}|${tokens}`;
}

/** One line per case verdict. Output with no case lines yields none, which is legitimate. */
export function extractCaseLines(model, trial, output) {
  return output.split(/\r?\n/)
    .map((l) => l.match(/^\s{2}(pass|FAIL)\s{2}(\S+)/))
    .filter((m) => m !== null)
    .map((m) => `CASE|${model}|${trial}|${m[2]}|${m[1]}`);
}

function main(argv) {
  let args;
  try {
    args = parseSweepArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  mkdirSync(args.outDir, { recursive: true });
  const runsPath = join(args.outDir, "runs.txt");
  const casesPath = join(args.outDir, "cases.txt");
  writeFileSync(runsPath, "");
  writeFileSync(casesPath, "");
  // What was swept, beside what the sweep produced. `compare-models --write` reads it and
  // refuses to label a floor with a suite the sweep did not actually run — the sweep and the
  // artifact are written by different commands, and nothing else makes them agree.
  writeFileSync(join(args.outDir, "suite.txt"), `${args.suite ?? "eval/compile-smoke.json"}\n`);

  for (const model of args.models) {
    for (let trial = 1; trial <= args.trials; trial++) {
      const started = Date.now();
      const runnerArgs = [
        "node_modules/tsx/dist/cli.mjs", "scripts/run-eval.ts", "--local", "--model", model,
      ];
      if (args.suite) runnerArgs.push("--suite", args.suite);
      const r = spawnSync(process.execPath, runnerArgs, { encoding: "utf8" });
      const secs = Math.round((Date.now() - started) / 1000);
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const lines = out.split(/\r?\n/);
      const score = lines.find((l) => /cases · score/.test(l)) ?? "";
      const tokens = lines.find((l) => /tokens\s+\d+ in \/ \d+ out/.test(l)) ?? "";

      // Appended per run, never batched: a sweep killed halfway leaves every completed run
      // readable, which the ad-hoc predecessor proved worth having twice over.
      appendFileSync(runsPath, `${formatRunLine(model, trial, secs, r.status ?? -1, score, tokens)}\n`);
      const caseLines = extractCaseLines(model, trial, out);
      if (caseLines.length > 0) appendFileSync(casesPath, `${caseLines.join("\n")}\n`);
      console.log(`sweep: ${model} trial ${trial} — ${secs}s, exit ${r.status}, ${caseLines.length} case(s)`);
    }
  }

  console.log(`sweep: done. ${runsPath} and ${casesPath} are ready for compare:models.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
