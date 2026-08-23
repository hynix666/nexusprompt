#!/usr/bin/env tsx
/**
 * Generate `eval/gate-recall-anchor.json` — the first suite in this repository sized to
 * certify a promotion.
 *
 * ## Why it is generated rather than written
 *
 * Every existing suite expresses a second configuration through `variant_stubs`, which
 * `application/src/eval.ts` describes as "how a second configuration is expressed without a
 * live provider". The outcomes are therefore chosen by whoever wrote the fixture. At fourteen
 * cases asserting honesty properties that is fine. At anchor size it is fatal: a few thousand
 * authored outcomes produce a p-value about the author, not about a configuration.
 *
 * So this suite has no authored outcomes. Inputs come from the shared seeded generator, and
 * each case's ground truth is *derived* — inject a fragment, ask the registry what newly
 * fires, keep the case only when exactly one previously-silent gate does. See
 * `core/src/eval/anchor.ts` for why that rule is what makes the label trustworthy.
 *
 * ## Where the size comes from
 *
 * Measured, then sized — not assumed. A 4,000-case pilot put the discordance rate between two
 * non-nested gate sets at 0.2477. Rounded up to 0.25 (conservative: a higher p_d asks for a
 * larger n), the sizing rule gives
 *
 *     requiredPairedSize(0.02, { alpha: 0.05, power: 0.80, discordanceRate: 0.25 }) = 4900
 *
 * All three assumptions are written into the suite because the whole finding of Phase ε was
 * that the old rule hid them.
 *
 * ## Why the comparison is non-nested
 *
 * The obvious comparison — the full sixteen against the full sixteen minus one gate — is
 * theatre. A subset cannot catch more than its superset, so the null hypothesis is known
 * false before any case is scored, and McNemar adds nothing to "the discordant count is above
 * zero". The pilot made that concrete: dropping one gate moved between 1 and 10 cases in
 * 4,000, always in the same direction.
 *
 * The two sets here partition the registry, so neither contains the other and either could
 * win. That is a question the data can actually answer.
 *
 *   npx tsx scripts/build-anchor.ts            # write
 *   npx tsx scripts/build-anchor.ts --check    # verify the committed file
 *
 * Exit 0 in sync · 1 the committed file differs · 2 the corpus could not be built.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildAnchorCorpus, AnchorCorpusExhausted, type GateSet } from "../core/src/eval/anchor.js";
import { listGates } from "../core/src/gates/registry.js";
import { requiredPairedSize } from "../core/src/eval/sizing.js";

const SUITE_PATH = "eval/gate-recall-anchor.json";

/** Every assumption the size rests on, in the file that uses them. */
export const SIZING = {
  seed: 1,
  target_delta: 0.02,
  alpha: 0.05,
  power: 0.8,
  /** Measured on a 4,000-case pilot at 0.2477, rounded up. Higher is conservative. */
  measured_discordance: 0.25,
} as const;

export const CASE_COUNT = requiredPairedSize(SIZING.target_delta, {
  alpha: SIZING.alpha,
  power: SIZING.power,
  discordanceRate: SIZING.measured_discordance,
});

/**
 * The two gate sets, partitioning the registry by index.
 *
 * An alternating split rather than a thematic one: a split chosen by what the gates *mean*
 * would be a split chosen by me, and the point of this suite is that nothing about the
 * outcome is chosen by me. Alternating over the sorted id list is arbitrary in the way a coin
 * is arbitrary, and it is reproducible from the registry alone.
 */
export function gateSets(): { a: GateSet; b: GateSet } {
  const ids = listGates().map((g) => g.id).sort();
  return {
    a: { gate_set_ref: "alternating-even", gate_ids: ids.filter((_, i) => i % 2 === 0) },
    b: { gate_set_ref: "alternating-odd", gate_ids: ids.filter((_, i) => i % 2 === 1) },
  };
}

export function buildSuite() {
  const corpus = buildAnchorCorpus({ seed: SIZING.seed, count: CASE_COUNT });
  const { a, b } = gateSets();
  return {
    _comment: [
      "GENERATED FILE — do not edit by hand. `npx tsx scripts/build-anchor.ts` writes it and",
      "`npm run check:anchor` fails the build when it is not what the repository produces.",
      "",
      "The first suite here sized to certify a promotion. Its cases are generated from a seed",
      "and their ground truth is derived, not authored: a fragment is injected, and the case is",
      "kept only when exactly one previously-silent gate starts firing. That gate is the",
      "planted defect. Labelling fragments by hand would have been wrong precisely where it",
      "matters -- this corpus contains a citation that silences both citation gates by",
      "declaring itself inside an empty ledger, and a secret that stops being a finding once it",
      "sits inside a fence. Context decides, so context is what gets asked.",
      "",
      `Sized from a measured discordance rate, not an assumed one: a 4,000-case pilot put it at`,
      `0.2477 between two non-nested gate sets. Rounded up to ${SIZING.measured_discordance},`,
      `requiredPairedSize(${SIZING.target_delta}, alpha ${SIZING.alpha}, power ${SIZING.power})`,
      `gives ${CASE_COUNT} cases. All three assumptions are recorded below because Phase epsilon's`,
      "finding was that the old sizing rule hid exactly these.",
      "",
      "The comparison is between two sets that PARTITION the registry. Full-versus-full-minus-one",
      "would be theatre: a subset cannot catch more than its superset, so the null is known false",
      "before any case is scored.",
    ],
    generator: {
      module: "core/src/eval/anchor.ts",
      seed: SIZING.seed,
      case_count: CASE_COUNT,
      sizing: {
        target_delta: SIZING.target_delta,
        alpha: SIZING.alpha,
        power: SIZING.power,
        measured_discordance: SIZING.measured_discordance,
        rule: "requiredPairedSize(delta, { alpha, power, discordanceRate })",
      },
    },
    comparison: {
      baseline_gate_set: a,
      candidate_gate_set: b,
      why_not_nested:
        "A subset can never catch more than its superset, so a nested comparison tests a null " +
        "that is known false before any case is scored. These two partition the registry.",
    },
    suite: {
      suite_id: "gate-recall-anchor",
      version: "1.0.0",
      kind: "anchor" as const,
      case_ids: corpus.map((c) => c.case_id),
      resolution: {
        // Score granularity: one case out of n. Not the statistical resolution -- that is
        // derived by the comparator from alpha and the observed discordance (eval-suite 2.0.1).
        detectable_delta: Number((1 / CASE_COUNT).toPrecision(3)),
        confidence: 1 - SIZING.alpha,
        sized_for: CASE_COUNT,
      },
      // Cases are drawn independently from the generator; nothing expands one case into
      // several, so there are no clusters and the independence assumption holds.
      significance_protocol: "exact-mcnemar" as const,
    },
  };
}

function main(): void {
  const check = process.argv.includes("--check");
  let produced: string;
  try {
    produced = JSON.stringify(buildSuite(), null, 2) + "\n";
  } catch (err) {
    if (err instanceof AnchorCorpusExhausted) {
      console.error(`build-anchor — ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (!check) {
    writeFileSync(SUITE_PATH, produced, "utf8");
    console.log(`build-anchor — wrote ${SUITE_PATH} (${CASE_COUNT} cases, seed ${SIZING.seed}).`);
    return;
  }

  const committed = existsSync(SUITE_PATH) ? readFileSync(SUITE_PATH, "utf8").replace(/\r\n/g, "\n") : "";
  if (committed.trimEnd() === produced.trimEnd()) {
    console.log(`check:anchor — OK. ${CASE_COUNT} cases, regenerated from seed ${SIZING.seed} and identical.`);
    return;
  }
  console.error(
    `check:anchor — ${SUITE_PATH} is not what the generator produces.\n\n` +
    `  This file is generated. If the gate registry or the generator changed, the corpus\n` +
    `  changed with it — run \`npx tsx scripts/build-anchor.ts\` and commit the result. If it\n` +
    `  was edited by hand, that is the failure this check exists for: an anchor whose cases\n` +
    `  anyone can edit is an anchor whose verdict anyone can choose.\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("build-anchor.ts")) main();
