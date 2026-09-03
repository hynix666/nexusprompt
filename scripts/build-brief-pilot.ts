#!/usr/bin/env tsx
/**
 * Generate `eval/brief-pilot.json`.
 *
 * A 100-case suite targeting the four dimensions that varied across models in sub-project 1:
 * secret (credential not echoed), unicode (script token survives), placeholder (template
 * not left in output), and structure (header present). Every case carries a pinned stub so
 * the suite runs offline; the stub is the correct output the generator guarantees its own
 * case against before including it.
 *
 * See `core/src/eval/brief-generator.ts` for the construction invariant and why these four
 * dimensions rather than others.
 *
 *   npx tsx scripts/build-brief-pilot.ts            # write
 *   npx tsx scripts/build-brief-pilot.ts --check    # verify the committed file
 *
 * Exit 0 in sync · 1 the committed file differs · 2 the corpus could not be built.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildBriefCorpus, BriefCorpusExhausted } from "../core/src/eval/brief-generator.js";

const SUITE_PATH = "eval/brief-pilot.json";
const SEED = 1;
const COUNT = 100;

export function buildBriefPilotSuite() {
  const cases = buildBriefCorpus({ seed: SEED, count: COUNT });
  return {
    _comment: [
      "A 100-case smoke suite testing four dimensions that varied across models in sub-project 1.",
      "",
      "Every case carries a pinned stub so the full suite runs offline. The stub is the output",
      "the generator verifies each case against before including it — a case no stub can pass is",
      "a broken case, not a model failure. See core/src/eval/brief-generator.ts.",
      "",
      "Four shapes, round-robin: secret (credential not echoed), unicode (script token survives),",
      "placeholder (template not left in output), structure (header present). 25 each.",
      "",
      "`detectable_delta` is 1/100 = 0.01, the score granularity. 100 cases is above the exact",
      "McNemar floor of 6 and can attain significance when used with compare-models — that is",
      "what Task 4 (the sweep measurement) is for. This run verifies wiring and internal",
      "consistency; it does not compare configurations.",
    ],
    suite: {
      suite_id: "brief-pilot",
      version: "1.0.0",
      kind: "smoke",
      case_ids: cases.map((c) => c.case_id),
      resolution: {
        detectable_delta: Number((1 / COUNT).toPrecision(3)),
        confidence: 0.95,
        sized_for: COUNT,
      },
      significance_protocol: "exact-mcnemar",
    },
    cases,
  };
}

function main(): void {
  const check = process.argv.includes("--check");
  let produced: string;
  try {
    produced = JSON.stringify(buildBriefPilotSuite(), null, 2) + "\n";
  } catch (err) {
    if (err instanceof BriefCorpusExhausted) {
      console.error(`build:brief-pilot — ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (!check) {
    writeFileSync(SUITE_PATH, produced, "utf8");
    console.log(`build:brief-pilot — wrote ${SUITE_PATH} (${COUNT} cases, seed ${SEED}).`);
    return;
  }

  const committed = existsSync(SUITE_PATH)
    ? readFileSync(SUITE_PATH, "utf8").replace(/\r\n/g, "\n")
    : "";
  if (committed.trimEnd() === produced.trimEnd()) {
    console.log(
      `check:brief-pilot — OK. ${COUNT} cases, regenerated from seed ${SEED} and identical.`,
    );
    return;
  }
  console.error(
    `check:brief-pilot — ${SUITE_PATH} is not what the generator produces.\n\n` +
    `  This file is generated. If the brief generator or its parameters changed, run\n` +
    `  \`npx tsx scripts/build-brief-pilot.ts\` and commit the result. If it was edited\n` +
    `  by hand, that is the failure this check exists for.\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("build-brief-pilot.ts")) main();
