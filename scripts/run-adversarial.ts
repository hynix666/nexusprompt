#!/usr/bin/env tsx
/**
 * Run the adversarial suite as a ratchet.
 *
 * Unlike `npm run eval`, a failing case here is not automatically a build failure — the
 * suite encodes what the pipeline SHOULD do, and several things it should do are not
 * built yet. What fails the build is movement in the wrong direction:
 *
 *   - a case that fails and is not in the ledger   → a new evasion
 *   - a case that passes and IS in the ledger      → a stale entry; delete it
 *   - a ledger entry with no reason or fix_point   → an excuse, not a record
 *
 * The asymmetry is the point. Fixing a gate makes its case pass, which makes its entry
 * stale, which fails the build until the entry is deleted — so a fix is forced to update
 * the ledger. Had the suite encoded measured behaviour instead, a fix would have broken
 * the build and the suite would have been defending the weakness.
 *
 * Exit 0 the ratchet holds · 1 it moved backwards, or the ledger is wrong
 *      · 2 the suite or ledger cannot be read.
 */

import { readFileSync } from "node:fs";
import { runSuite, configurationId, type StubbedCase } from "../application/src/eval.js";
import type { Configuration, EvalSuite } from "../contracts/index.js";

const SUITE = "eval/compile-adversarial.json";
const LEDGER = "eval/adversarial-known-evasions.json";

interface Evasion { case_id: string; reason?: string; fix_point?: string }

async function main(): Promise<number> {
  let data: { suite: EvalSuite; cases: StubbedCase[] };
  let ledger: { evasions: Evasion[] };
  try {
    data = JSON.parse(readFileSync(SUITE, "utf8"));
    ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch (err) {
    console.error(`adversarial: cannot read the suite or its ledger — ${(err as Error).message}`);
    return 2;
  }

  const base = {
    prompt_template_ref: "core/src/stages/compile.ts",
    model_id: "pinned",
    decoding: { temperature: null, seed: null },
    topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
    retrieval_config: null,
    tool_config: null,
    gate_set_ref: "scripts/ported-gates.json",
    router_policy_ref: null,
  };
  const configuration: Configuration = { configuration_id: configurationId(base), ...base };
  const { perCase } = await runSuite({ suite: data.suite, cases: data.cases, configuration });

  const known = new Map(ledger.evasions.map((e) => [e.case_id, e]));
  const failed = new Set(perCase.filter((c) => !c.passed).map((c) => c.case_id));

  const newEvasions = [...failed].filter((id) => !known.has(id));
  const stale = [...known.keys()].filter((id) => !failed.has(id));
  const unreasoned = ledger.evasions.filter((e) => !e.reason?.trim() || !e.fix_point?.trim());

  console.log(`adversarial — ${data.suite.suite_id}@${data.suite.version} (perturbs ${data.suite.derived_from})`);
  console.log(`  ${perCase.length} cases · ${perCase.length - failed.size} caught · ${failed.size} evaded\n`);
  for (const c of perCase) {
    const tag = c.passed ? "caught " : known.has(c.case_id) ? "EVADED*" : "EVADED ";
    console.log(`  ${tag} ${c.case_id.padEnd(38)} ${c.failure_mode}`);
  }
  console.log(`\n  * recorded in ${LEDGER} with a reason and a fix point.`);
  console.log("  A green result here means the ratchet held, NOT that the pipeline is robust.");

  let bad = false;
  if (newEvasions.length) {
    console.error(`\nadversarial: ${newEvasions.length} case(s) evaded that were not recorded as evading:`);
    for (const id of newEvasions) console.error(`  ${id}`);
    console.error("  Either the pipeline regressed, or this is a real weakness that needs a ledger entry.");
    bad = true;
  }
  if (stale.length) {
    console.error(`\nadversarial: ${stale.length} ledger entr(ies) describe a weakness that is gone:`);
    for (const id of stale) console.error(`  ${id} now passes — delete its entry`);
    console.error("  A ledger that outlives its defect misreports the system's coverage.");
    bad = true;
  }
  if (unreasoned.length) {
    console.error(`\nadversarial: ${unreasoned.length} ledger entr(ies) lack a reason or a fix point:`);
    for (const e of unreasoned) console.error(`  ${e.case_id}`);
    bad = true;
  }
  return bad ? 1 : 0;
}

main().then((code) => process.exit(code));
