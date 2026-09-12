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
 * It reports, per gate: how many firings were judged real, the exact (Clopper-Pearson) interval
 * from Core, and the same split by slice. Never a point estimate alone — at these counts one
 * would be the most misleading number this phase could produce. Gates that never fired are
 * named as such rather than left out of the table.
 *
 * Labels here were made by Claude alone, which is the owner's D1 decision and a weaker warrant
 * than a human review: an uncalibrated model judging text. `adjudicated_by` records it on every
 * record so no reader has to take the figure on trust.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listGates, runGates } from "../core/src/gates/registry.js";
import { precisionInterval } from "../core/src/eval/precision.js";

/** The interval's confidence level. Reported beside every bound, never left to be assumed. */
const CONFIDENCE = 0.95;

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

export interface GateActivity {
  /** Prompts the gate was run over. */
  prompts: number;
  /** Prompts on which it was actually armed — able to report a finding at all. */
  armed: number;
  /** The gate's own words for why it was not armed, or null when it always was. */
  notArmedMessage: string | null;
}

/**
 * Which gates could report anything at all over this corpus.
 *
 * Six of the sixteen return PASS immediately unless an option is set, and the corpus runs
 * `runGates(text, {})`: TOKEN_BUDGET wants a budget, QUTM_CEILING a stakes tier, CONTEXT_LIMIT
 * a provider, RECURSION_MACHINERY_PRESENT and RAG_SHIELD_GAP their targets, and
 * ADVERSARIAL_RESILIENCE a corpus. Reporting those as "never fired" invites the reading "the
 * models never produced that defect", which is not what happened — they were switched off.
 *
 * Derived from each gate's own `.not_armed` message code, never from a list of gate names: a
 * hand-kept list encodes what its author remembered, and the next option-gated gate would be
 * misreported exactly as these six were.
 */
export function deriveGateActivity(dir = CORPUS_DIR): Map<string, GateActivity> {
  const out = new Map<string, GateActivity>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const corpus = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const record of corpus.records) {
      for (const gate of runGates(record.text, {})) {
        const seen = out.get(gate.gate_id) ?? { prompts: 0, armed: 0, notArmedMessage: null };
        const armed = gate.message_code !== `${gate.gate_id}.not_armed`;
        out.set(gate.gate_id, {
          prompts: seen.prompts + 1,
          armed: seen.armed + (armed ? 1 : 0),
          notArmedMessage: armed ? seen.notArmedMessage : seen.notArmedMessage ?? gate.message,
        });
      }
    }
  }
  return out;
}

/**
 * Gates whose finding is arithmetic, not a judgement about the text.
 *
 * Each compares a token estimate against a number the CALLER declares — a budget, a provider's
 * context limit, a cost ceiling against a baseline. `tokens > budget` is either true or false,
 * so there is no wrong-but-fired: only a policy set well or badly. Precision (TP / firings) is
 * the wrong question for them, and reporting them as "unmeasured" implies a measurement is
 * merely missing when none is owed.
 *
 * Named rather than derived, because the property is semantic. `check-precision.test.ts` keeps
 * the list honest behaviourally: each gate here must FLIP its verdict on one unchanged text
 * when only the caller's number moves, which a detector cannot do.
 */
export const THRESHOLD_GATES: readonly string[] = ["CONTEXT_LIMIT", "QUTM_CEILING", "TOKEN_BUDGET"];

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

export interface GateSummary {
  gate: string;
  n: number;
  tp: number;
  interval: ReturnType<typeof precisionInterval>;
  bySlice: Record<"pilot" | "clean", { n: number; tp: number }>;
  /** Prompts on which the gate was armed. 0 means it could not have fired at all. */
  armed: number;
  notArmedMessage: string | null;
}

/**
 * One row per gate in the registry, including the gates that never fired.
 *
 * A gate absent from a table reads as "fine". A gate with no firings on this corpus has no
 * precision at all, which is a different statement from a precision of 1, so it is listed
 * with `interval: null` rather than left out.
 *
 * Split by slice because the two slices are not the same instrument: half the pilot briefs
 * plant a hazard on purpose, so a gate's true-positive share there says nothing about how it
 * behaves on the clean briefs, where nothing was planted.
 */
export function summarise(
  firings: Firing[],
  labelOf: Map<string, string>,
  gateIds: readonly string[],
  activity: Map<string, GateActivity> = new Map(),
): GateSummary[] {
  return gateIds.map((gate) => {
    const seen = activity.get(gate);
    const mine = firings.filter((f) => f.gate_id === gate);
    const tp = mine.filter((f) => labelOf.get(firingKey(f)) === "TRUE").length;
    const forSlice = (slice: "pilot" | "clean") => {
      const s = mine.filter((f) => f.slice === slice);
      return { n: s.length, tp: s.filter((f) => labelOf.get(firingKey(f)) === "TRUE").length };
    };
    return {
      gate, n: mine.length, tp,
      interval: precisionInterval(tp, mine.length, CONFIDENCE),
      bySlice: { pilot: forSlice("pilot"), clean: forSlice("clean") },
      armed: seen?.armed ?? 0,
      notArmedMessage: seen?.notArmedMessage ?? null,
    };
  });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

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

  const labelOf = new Map<string, string>(file.adjudications.map((a: Adjudication) => [firingKey(a), a.label]));
  const rows = summarise(firings, labelOf, listGates().map((g) => g.id), deriveGateActivity());

  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"));
  const corpora = files.map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), "utf8")));
  const prompts = corpora.reduce((n, c) => n + c.records.length, 0);
  const inSlice = (slice: string) => corpora.reduce((n, c) => n + c.records.filter((r: { slice: string }) => r.slice === slice).length, 0);

  console.log(`check:precision — OK. ${firings.length} firing(s) over ${prompts} compiled prompt(s), all adjudicated.`);
  console.log(`  Corpus: ${corpora.length} model(s), ${inSlice("pilot")} pilot prompt(s) (half the briefs plant a hazard) ` +
              `and ${inSlice("clean")} clean prompt(s) (nothing planted).\n`);
  console.log(`  ${"gate".padEnd(28)} ${"defect/fired".padStart(12)}   exact ${pct(CONFIDENCE)} interval        pilot     clean`);

  for (const r of [...rows].sort((a, b) => b.n - a.n || a.gate.localeCompare(b.gate))) {
    if (THRESHOLD_GATES.includes(r.gate)) {
      // Not "unmeasured": nothing is owed. Its verdict is tokens against a number the caller
      // declares, so a firing cannot be wrong about the text — only the policy can be.
      console.log(`  ${r.gate.padEnd(28)} ${"n/a".padStart(12)}   threshold gate — fires by arithmetic against a declared number; precision is not the question`);
      continue;
    }
    if (r.n === 0) {
      // Three states, not two. A gate that was never armed could not have fired whatever the
      // models wrote, and calling that "never fired" reads as evidence about the models.
      console.log(
        `  ${r.gate.padEnd(28)} ${"—".padStart(12)}   ` +
        (r.armed === 0
          ? `NOT ARMED on any prompt — ${r.notArmedMessage ?? "the gate needs an option this corpus does not set"}`
          : `armed on ${r.armed} prompt(s), never fired`),
      );
      continue;
    }
    const i = r.interval!;
    console.log(
      `  ${r.gate.padEnd(28)} ${`${r.tp}/${r.n}`.padStart(12)}   ${pct(i.lower).padStart(6)} – ${pct(i.upper).padEnd(6)}` +
      ` (point ${pct(i.point).padStart(6)})   ${`${r.bySlice.pilot.tp}/${r.bySlice.pilot.n}`.padStart(6)}` +
      ` ${`${r.bySlice.clean.tp}/${r.bySlice.clean.n}`.padStart(6)}`,
    );
  }

  console.log(
    "\n  no-fabrication-when-degraded, the keyword detector that inherits the same risk, is not\n" +
    "  measured here and cannot be: it only reads degraded output, and the corpus excludes every\n" +
    "  degraded answer by construction. Its precision is unmeasured, not good.",
  );
  console.log(
    "\n  What this is not. Every label was made by Claude alone, an uncalibrated model reviewed by\n" +
    "  nobody (adjudicated_by: claude). The figure belongs to THIS corpus — generated briefs, half\n" +
    "  the pilot slice planting a hazard on purpose — not to the gate: a gate's precision on prompts\n" +
    "  a person wrote is unmeasured. Recall and precision come from different corpora and do not\n" +
    "  compose. A gate that never fired has no precision here, which is not a precision of 1 —\n" +
    "  and a gate marked NOT ARMED did not even get the chance: it needs an option this corpus\n" +
    "  does not set, so its silence says nothing at all about what the models wrote.",
  );
  return 0;
}

if (process.argv[1]?.endsWith("check-precision.ts")) process.exit(main());
