#!/usr/bin/env node
/**
 * Compare several models on one suite, using the comparator's own statistics.
 *
 *   node scripts/compare-models.mjs <sweep-dir>
 *
 * ## Why this is not `eval --compare`
 *
 * `--compare` answers "is this prompt configuration better than that one?" and runs both arms
 * itself. This answers "do these models differ at all?", which is a different axis: the arms
 * are separate processes, hours apart, because a 27B model takes twenty minutes per pass.
 *
 * It computes nothing of its own. `clusteredPaired` is the exact test the comparator runs, and
 * `floorDiscordant` / `attainable` / `resolvableDelta` are the rules `check:sizing` prints. A
 * tool that reimplemented the statistics could disagree with the comparator about the same
 * data, and the disagreement would be invisible.
 *
 * ## Trials are clustered, not counted
 *
 * Three trials of fourteen cases are 14 independent units, not 42. Each case is one cluster
 * and its trials become a pass RATE; the sign test runs on the clusters. Counting trials as
 * units would inflate the sample by the trial factor and make every p-value anticonservative
 * — the reason `CaseOutcome.cluster_id` exists.
 *
 * ## Input format
 *
 * A directory holding two line-oriented files, which a sweep script appends to as it goes so
 * a crash halfway still leaves readable data:
 *
 *   runs.txt    RUN|<model>|<trial>|secs=<n>|exit=<n>|<x>/<y> cases · score <s>|tokens <a> in / <b> out
 *   cases.txt   CASE|<model>|<trial>|<case_id>|<pass|FAIL>
 *
 * Both come from the eval runner's TEXT output rather than `--json`, and that is a limitation
 * worth stating: the JSON EvalRun carries `detector_recall` but no per-case array, and the
 * text carries per-case results but no machine-readable recall block. Neither alone has both.
 * So this calls `clusteredPaired` directly and does NOT invoke the comparator's recall
 * equalization — check that every run reported full detector recall before trusting a verdict.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { clusteredPaired } from "../core/src/eval/compare.js";
import {
  floorDiscordant, attainable, minAttainableP, resolvableDelta, STATED_ASSUMPTIONS,
} from "../core/src/eval/sizing.js";

const lines = (text, prefix) =>
  text.split(/\r?\n/).filter((l) => l.startsWith(prefix)).map((l) => l.split("|"));

/** One record per run: model, trial, wall time, score. */
export function parseRuns(text) {
  return lines(text, "RUN|").map(([, model, trial, secs, , score]) => {
    const m = (score ?? "").match(/([0-9]+)\/([0-9]+) cases · score ([0-9.]+)/);
    return {
      model,
      trial: Number(trial),
      secs: Number((secs ?? "").replace("secs=", "")),
      passed: m ? Number(m[1]) : null,
      cases: m ? Number(m[2]) : null,
      score: m ? Number(m[3]) : null,
    };
  });
}

/**
 * Per-case outcomes, one `CaseOutcome` per (case, trial), clustered by case.
 *
 * `case_id` carries the trial so two trials of one case are distinct rows; `cluster_id` is the
 * bare case, which is what the sign test aggregates on.
 */
export function parseCases(text) {
  const byModel = new Map();
  for (const [, model, trial, caseId, verdict] of lines(text, "CASE|")) {
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push({
      case_id: `${caseId}#${trial}`, cluster_id: caseId, passed: verdict === "pass",
    });
  }
  return byModel;
}

/**
 * A case's pass rate per model, and whether every model agrees on it.
 *
 * The most useful column in the report. Ten of `compile-smoke`'s fourteen cases were constant
 * across four models and three trials on 1 September 2026 — nine always passed, one always
 * failed — so the suite's effective width for telling models apart was four cases, not
 * fourteen. Scaling such a suite would mostly buy noise.
 */
export function caseMatrix(byModel) {
  const models = [...byModel.keys()];
  const ids = [];
  for (const rows of byModel.values()) {
    for (const r of rows) if (!ids.includes(r.cluster_id)) ids.push(r.cluster_id);
  }
  return ids.map((id) => {
    const rates = models.map((m) => {
      const rows = byModel.get(m).filter((r) => r.cluster_id === id);
      return rows.length ? { passed: rows.filter((r) => r.passed).length, n: rows.length } : null;
    });
    const seen = rates.filter(Boolean).map((r) => r.passed / r.n);
    return { case_id: id, rates, constant: new Set(seen).size <= 1 };
  });
}

/** Every unordered pair, which is also the multiplicity family the correction divides by. */
export function pairsOf(models) {
  const out = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) out.push([models[i], models[j]]);
  }
  return out;
}

/**
 * The verdict for one pair, with the refusal separated from the null result.
 *
 * `refused` and `inconclusive` are different claims — "we could not have seen anything" versus
 * "we looked and saw nothing" — and collapsing them is the specific move this repository's
 * comparator refuses to make. A pair is refused when its discordant count could not reach the
 * corrected alpha under ANY arrangement of the signs.
 */
export function verdictFor(candidate, baseline, alpha) {
  const r = clusteredPaired(candidate, baseline);
  if (!attainable(r.discordant, alpha)) {
    return { ...r, verdict: "refused", best: minAttainableP(r.discordant) };
  }
  return { ...r, verdict: r.p <= alpha ? "significant" : "inconclusive", best: null };
}

export function report(runsText, casesText, { alpha = 0.05 } = {}) {
  const runs = parseRuns(runsText);
  const byModel = parseCases(casesText);
  const models = [...byModel.keys()];
  const out = [];

  out.push("## Runs\n");
  for (const r of runs) {
    out.push(`${r.model.padEnd(24)} t${r.trial}  ${String(r.secs).padStart(5)}s  ` +
      `${r.passed ?? "—"}/${r.cases ?? "—"}  ${r.score === null ? "—" : r.score.toFixed(3)}`);
  }

  out.push("\n## Score stability across trials\n");
  for (const m of models) {
    const v = runs.filter((r) => r.model === m && r.score !== null).map((r) => r.score);
    if (v.length === 0) continue;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    out.push(`${m.padEnd(24)} ${v.map((x) => x.toFixed(3)).join(" ").padEnd(20)} ` +
      `mean ${mean.toFixed(3)}  spread ${(Math.max(...v) - Math.min(...v)).toFixed(3)}`);
  }

  const matrix = caseMatrix(byModel);
  const constant = matrix.filter((row) => row.constant).length;
  out.push("\n## Per-case pass rate\n");
  out.push(`${"case".padEnd(36)}${models.map((m) => m.slice(0, 14).padStart(15)).join("")}`);
  for (const row of matrix) {
    const cells = row.rates.map((r) => (r ? `${r.passed}/${r.n}` : "—").padStart(15)).join("");
    out.push(`${row.case_id.padEnd(36)}${cells}${row.constant ? "   (constant)" : ""}`);
  }
  out.push(`\n  ${constant} of ${matrix.length} case(s) are constant across every model — ` +
    "they cannot tell two models apart.");

  const pairs = pairsOf(models);
  const corrected = alpha / Math.max(pairs.length, 1);
  out.push("\n## Pairwise — the comparator's own exact clustered sign test\n");
  out.push(`family of ${pairs.length} · alpha ${alpha} nominal, ${corrected.toFixed(5)} corrected`);
  out.push(`discordant clusters needed: ${floorDiscordant(alpha)} nominal, ` +
    `${floorDiscordant(corrected)} corrected\n`);
  for (const [a, b] of pairs) {
    const v = verdictFor(byModel.get(a), byModel.get(b), corrected);
    const tail = v.verdict === "refused" ? ` (best possible p=${v.best.toFixed(4)})` : "";
    out.push(`${a.padEnd(24)} ${b.padEnd(24)} disc ${String(v.discordant).padStart(2)}/` +
      `${v.clusters}  p ${v.p.toFixed(4)}  ${v.verdict}${tail}`);
  }

  out.push(`\n## What ${matrix.length} cases resolve at 80% power: ` +
    `${(resolvableDelta(matrix.length, STATED_ASSUMPTIONS) * 100).toFixed(1)} pp`);
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/compare-models.mjs <sweep-dir>");
    process.exit(2);
  }
  console.log(report(
    readFileSync(join(dir, "runs.txt"), "utf8"),
    readFileSync(join(dir, "cases.txt"), "utf8"),
  ));
}
