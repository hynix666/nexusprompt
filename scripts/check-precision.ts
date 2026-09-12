/**
 * check:precision — every gate firing in the corpus carries a label, and every label still
 * describes a firing (Phase 9, Task 3).
 *
 * Precision is TP / firings. Counting firings is arithmetic; deciding whether each one is a
 * real defect is a judgement, and this check exists so that judgement cannot drift away from
 * the thing it judged. It fails when a firing has no adjudication (a gate that starts firing
 * somewhere new must be looked at, not absorbed), when an adjudication has no firing (the
 * stale rule `divergence-allowlist.json` already enforces), and when a corpus file's bytes no
 * longer match the ones that were judged.
 *
 * It prints counts only. The interval belongs to Core (Task 4) and the report to Task 5 —
 * a point estimate without `n` and an interval is the figure this phase exists to avoid.
 *
 * Labels here were made by Claude alone, which is the owner's D1 decision and a weaker warrant
 * than a human review: an uncalibrated model judging text. `adjudicated_by` records it on every
 * record so no reader has to take the figure on trust.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runGates } from "../core/src/gates/registry.js";

const CORPUS_DIR = "eval/precision-corpus";
const ADJUDICATIONS = "eval/precision-adjudications.json";

export interface Firing {
  output_sha256: string;
  gate_id: string;
  verdict: string;
  model: string;
  case_id: string;
  slice: "pilot" | "clean";
}

export interface Adjudication {
  output_sha256: string;
  gate_id: string;
  verdict: string;
  label: "TRUE" | "FALSE";
  reason: string;
  adjudicated_by: string;
}

export const firingKey = (f: { output_sha256: string; gate_id: string; verdict: string }): string =>
  `${f.output_sha256}:${f.gate_id}:${f.verdict}`;

/** Re-runs the registry over every committed corpus text. The firings are derived, never stored. */
export function deriveFirings(dir = CORPUS_DIR): Firing[] {
  const out: Firing[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const corpus = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const record of corpus.records) {
      for (const gate of runGates(record.text, {}).filter((g) => g.verdict !== "PASS")) {
        out.push({
          output_sha256: record.output_sha256,
          gate_id: gate.gate_id,
          verdict: gate.verdict,
          model: corpus.model,
          case_id: record.case_id,
          slice: record.slice,
        });
      }
    }
  }
  return out;
}

/**
 * The pin is on the text that was judged, not on the bytes it happens to sit in.
 *
 * Hashing raw bytes failed CI on the first attempt: this repository is developed on Windows
 * with `autocrlf` and verified on Linux, so every corpus hashed differently for a difference
 * no label depends on. Line endings are normalised before hashing, as `check-counts.mjs`
 * already does when it reads a document.
 */
export const contentHash = (text: string): string =>
  createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

export function corpusHashes(dir = CORPUS_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    out[file] = contentHash(readFileSync(join(dir, file), "utf8"));
  }
  return out;
}

export function validate(
  firings: Firing[],
  adjudications: Adjudication[],
  onDisk: Record<string, string>,
  judged: Record<string, string>,
): string[] {
  const problems: string[] = [];

  for (const file of new Set([...Object.keys(onDisk), ...Object.keys(judged)])) {
    if (!(file in judged)) problems.push(`${file}: a corpus file nothing has judged. Adjudicate its firings, then pin its hash.`);
    else if (!(file in onDisk)) problems.push(`${file}: judged, but no longer in ${CORPUS_DIR}.`);
    else if (onDisk[file] !== judged[file]) {
      problems.push(`${file}: hash differs from the bytes that were judged. Every label for it describes text that is no longer there.`);
    }
  }

  const byKey = new Map(adjudications.map((a) => [firingKey(a), a]));
  for (const f of firings) {
    const a = byKey.get(firingKey(f));
    if (!a) {
      problems.push(`${f.gate_id} ${f.verdict} on ${f.case_id} (${f.model}) has no adjudication.`);
      continue;
    }
    if (a.label !== "TRUE" && a.label !== "FALSE") problems.push(`${firingKey(f)}: label must be TRUE or FALSE, not ${JSON.stringify(a.label)}.`);
    if (!a.reason?.trim()) problems.push(`${firingKey(f)}: no reason. A label without one cannot be checked by anybody.`);
    if (!a.adjudicated_by?.trim()) problems.push(`${firingKey(f)}: no adjudicated_by. Who judged is part of what the figure means.`);
  }

  const seen = new Set(firings.map(firingKey));
  for (const a of adjudications) {
    if (!seen.has(firingKey(a))) problems.push(`${firingKey(a)}: adjudicated, but no firing produces it any more.`);
  }

  return problems;
}

function main(): number {
  const file = JSON.parse(readFileSync(ADJUDICATIONS, "utf8"));
  const firings = deriveFirings();
  const problems = validate(firings, file.adjudications, corpusHashes(), file.corpora);

  if (problems.length > 0) {
    console.error(`check:precision — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("\n  A firing is not a defect until somebody says which it is, and a label is not\n" +
                  "  evidence once the text under it has changed.");
    return 1;
  }

  const byGate = new Map<string, { n: number; tp: number }>();
  const labelOf = new Map(file.adjudications.map((a: Adjudication) => [firingKey(a), a.label]));
  for (const f of firings) {
    const g = byGate.get(f.gate_id) ?? { n: 0, tp: 0 };
    g.n += 1;
    if (labelOf.get(firingKey(f)) === "TRUE") g.tp += 1;
    byGate.set(f.gate_id, g);
  }

  const prompts = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"))
    .reduce((n, f) => n + JSON.parse(readFileSync(join(CORPUS_DIR, f), "utf8")).records.length, 0);
  console.log(`check:precision — OK. ${firings.length} firing(s) over ${prompts} compiled prompt(s), all adjudicated.`);
  for (const [gate, { n, tp }] of [...byGate].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${gate.padEnd(24)} ${String(tp).padStart(3)} of ${String(n).padStart(3)} firing(s) judged a real defect`);
  }
  console.log("  Counts only: no precision figure until Task 4 computes an interval, and every\n" +
              "  label here was made by an uncalibrated model (adjudicated_by: claude).");
  return 0;
}

if (process.argv[1]?.endsWith("check-precision.ts")) process.exit(main());
