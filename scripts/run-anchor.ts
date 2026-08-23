#!/usr/bin/env tsx
/**
 * Run the gate-recall anchor through the real comparator.
 *
 * Nothing here is a special path: the outcomes go into `compare()` exactly as a smoke suite's
 * do, so the anchor is subject to every refusal the comparator already enforces — recall
 * equalization, protocol-versus-structure, the attainability floor, and multiplicity.
 *
 * ── The recall block is measured, not asserted ──────────────────────────────
 *
 * `compare()` refuses without measured detector recall, and rightly: "an unmeasured
 * instrument is not evidence". The anchor has one detector — *did some gate in the set fire
 * on the planted defect* — and both arms are scored by that same function, so the instrument
 * is identical across the comparison and the gap is exactly zero.
 *
 * That could have been written down as `recall: 1.0` and passed in. It is not. The corpus
 * construction *claims* every accepted case contains a defect the full registry detects, and
 * this script re-derives that over the actual corpus rather than trusting it. If the claim
 * were ever false the recall would drop below 1 and the comparator would widen its resolution
 * accordingly — which is the whole point of deriving the block instead of supplying it.
 *
 *   npm run eval:anchor
 *
 * Exit 0 the comparator reached a verdict · 1 it refused · 2 the corpus could not be built.
 */

import { readFileSync } from "node:fs";
import { buildAnchorCorpus, scoreGateSet, discordanceRate } from "../core/src/eval/anchor.js";
import { gateSets } from "./build-anchor.js";
import { listGates, runGate } from "../core/src/gates/registry.js";
import { compare } from "../core/src/eval/compare.js";
import { requiredPairedSize } from "../core/src/eval/sizing.js";
import type { DetectorRecallBlock, EvalSuite } from "../contracts/index.js";

const SUITE_PATH = "eval/gate-recall-anchor.json";
const DETECTOR_ID = "gate-set-catches-planted-defect";

interface AnchorFile {
  generator: { seed: number; case_count: number; sizing: { target_delta: number; alpha: number; power: number; measured_discordance: number } };
  suite: EvalSuite;
}

function main(): void {
  const file = JSON.parse(readFileSync(SUITE_PATH, "utf8")) as AnchorFile;
  const { seed, case_count } = file.generator;

  const corpus = buildAnchorCorpus({ seed, count: case_count });
  if (corpus.length !== file.suite.case_ids.length) {
    console.error(`eval:anchor — corpus is ${corpus.length} cases, the suite declares ${file.suite.case_ids.length}. Rebuild it.`);
    process.exit(2);
  }

  const { a, b } = gateSets();
  const baseline = scoreGateSet(corpus, a);
  const candidate = scoreGateSet(corpus, b);

  /**
   * Re-derive the construction invariant rather than trusting it: every accepted case should
   * contain a defect the FULL registry detects, because that is how the case was accepted.
   * `substrates` is the number of cases where the planted gate is the one that fires — the
   * substrate the detector had to work with.
   */
  const allIds = listGates().map((g) => g.id);
  let detected = 0;
  for (const k of corpus) {
    if (allIds.some((id) => {
      const v = runGate(id, k.text, k.options).verdict;
      return v === "FAIL" || v === "WARN";
    })) detected += 1;
  }
  const recall = detected / corpus.length;

  const block = (): DetectorRecallBlock => ({
    probe_corpus_version: `anchor-seed-${seed}`,
    detectors: [{
      detector_id: DETECTOR_ID,
      substrates: corpus.length,
      probes_run: corpus.length,
      probes_detected: detected,
      recall,
    }],
  });

  const d = discordanceRate(corpus, a, b);
  const basePassed = baseline.filter((o) => o.passed).length;
  const candPassed = candidate.filter((o) => o.passed).length;

  const result = compare({
    comparison_id: `anchor-${seed}`,
    candidate_run_id: b.gate_set_ref,
    baseline_id: a.gate_set_ref,
    candidate,
    baseline,
    suite: { resolution: file.suite.resolution, significance_protocol: file.suite.significance_protocol },
    comparisons_in_family: 1,
    alpha: file.generator.sizing.alpha,
    candidateRecall: block(),
    baselineRecall: block(),
    suiteDetectorIds: [DETECTOR_ID],
  });

  const s = file.generator.sizing;
  console.log(`anchor — ${file.suite.suite_id}@${file.suite.version} (${file.suite.kind})\n`);
  console.log(`  sized for  ${(100 * s.target_delta).toFixed(0)} pp at ${(100 * s.power).toFixed(0)}% power, alpha ${s.alpha},`);
  console.log(`             measured discordance ${s.measured_discordance} → ${requiredPairedSize(s.target_delta, { alpha: s.alpha, power: s.power, discordanceRate: s.measured_discordance })} cases`);
  console.log(`  ground truth derived on ${corpus.length} cases; full-registry recall ${recall.toFixed(4)} (measured, not asserted)\n`);
  console.log(`  ${a.gate_set_ref.padEnd(22)} ${a.gate_ids.length} gates   caught ${basePassed}/${corpus.length}`);
  console.log(`  ${b.gate_set_ref.padEnd(22)} ${b.gate_ids.length} gates   caught ${candPassed}/${corpus.length}`);
  console.log(`  discordant ${d.discordant}  (observed p_d ${d.rate.toFixed(4)})\n`);
  console.log(`  verdict  ${result.verdict.toUpperCase()}`);
  console.log(`  delta    ${result.delta === null ? "n/a" : (100 * result.delta).toFixed(2) + " pp"}`);
  console.log(`  p        ${result.protocol.p_value === null || result.protocol.p_value === undefined ? "n/a" : result.protocol.p_value.toExponential(3)}  (${result.protocol.test}, alpha ${result.protocol.alpha})`);
  console.log(`  attainable ${result.protocol.attainable}  · min attainable p ${result.protocol.min_attainable_p?.toExponential(3)}`);
  if (result.refusal_reason) console.log(`\n  ${result.refusal_reason}`);

  console.log(
    `\n  This certifies a difference in DETECTION between two gate sets over generated text.\n` +
    `  It says nothing about a model, a prompt's quality, or real user briefs — the population\n` +
    `  sampled is "text this generator can produce", which is the same population the\n` +
    `  differential oracle validates the gates against.`,
  );

  process.exit(result.verdict === "refused" ? 1 : 0);
}

main();
