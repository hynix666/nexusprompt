/**
 * Check the pipeline's depth against its declared error budget.
 *
 * End-to-end success across m stages is p^m, so depth and per-stage reliability are
 * not independent design choices — they are one choice expressed twice. This script
 * makes the arithmetic a build step rather than a remark, so that adding a stage
 * forces a visible decision: raise the per-stage floor, lower the end-to-end target,
 * or do not add the stage.
 *
 * Depth comes from `STAGE_IDS` in the contract, which is the same source
 * `check:plan` uses for `stages.target` — so the two checks cannot disagree about
 * how deep the pipeline is.
 *
 * The numbers in `reliability-budget.json` are declared, not measured. This check
 * therefore constrains the design; it does not certify the system. That distinction
 * is printed on every run so a green result is not read as more than it is.
 *
 * Exit 0 budget is attainable · 1 it is not · 2 inputs unreadable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT = "contracts/index.ts";
const BUDGET = "contracts/reliability-budget.json";

const readText = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

export function checkDepthBudget(root = process.cwd()) {
  let depth, budget;

  try {
    const ids = readText(join(root, CONTRACT))
      .match(/export const STAGE_IDS = \[([\s\S]*?)\] as const;/)?.[1]
      .match(/"[a-z_]+"/g) ?? [];
    depth = ids.length;
  } catch (err) {
    return { fatalCode: 2, fatal: `cannot read ${CONTRACT} — ${err.message}` };
  }
  if (depth < 1) return { fatalCode: 2, fatal: `no STAGE_IDS found in ${CONTRACT}` };

  try {
    budget = JSON.parse(readText(join(root, BUDGET)));
  } catch (err) {
    return { fatalCode: 2, fatal: `cannot read ${BUDGET} — ${err.message}` };
  }

  const { end_to_end_target: target, per_stage_floor: floor } = budget;
  if (typeof target !== "number" || typeof floor !== "number") {
    return { fatalCode: 2, fatal: `${BUDGET} must declare numeric end_to_end_target and per_stage_floor` };
  }
  if (!(target > 0 && target < 1) || !(floor > 0 && floor <= 1)) {
    return { fatalCode: 2, fatal: `${BUDGET}: target must be in (0,1) and floor in (0,1]` };
  }

  const achievable = Math.pow(floor, depth);
  // The per-stage reliability the declared depth and target actually demand.
  const required = Math.pow(target, 1 / depth);
  // How much deeper the pipeline could go at the declared floor before missing target.
  const headroom = Math.floor(Math.log(target) / Math.log(floor)) - depth;

  return {
    ok: achievable >= target,
    fatalCode: null,
    fatal: null,
    depth, target, floor, achievable, required, headroom,
    status: budget.status ?? "unknown",
  };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

function main() {
  const r = checkDepthBudget();
  if (r.fatal) {
    console.error(`check:depth: ${r.fatal}`);
    return r.fatalCode;
  }

  const head = `check:depth — ${r.depth} stages · floor ${pct(r.floor)}/stage · target ${pct(r.target)} end to end`;

  if (r.ok) {
    console.log(`${head} — OK`);
    console.log(`  attainable at the declared floor: ${pct(r.achievable)}`);
    console.log(`  headroom: ${r.headroom} further stage(s) before the target is missed`);
    console.log(`  budget is ${r.status}; this constrains the design, it does not certify the system`);
    return 0;
  }

  console.error(`${head} — FAILS`);
  console.error(`  attainable at the declared floor: ${pct(r.achievable)}, below the target of ${pct(r.target)}`);
  console.error(`  ${r.depth} stages at ${pct(r.target)} end to end requires ${pct(r.required)} per stage.\n`);
  console.error(`  Three ways out, and the point of this check is that one must be chosen visibly:`);
  console.error(`    · raise per_stage_floor to ${pct(r.required)} and show the stages can hold it`);
  console.error(`    · lower end_to_end_target to ${pct(r.achievable)} and say so where users read it`);
  console.error(`    · reduce depth — the deepest pipeline this floor supports is ${Math.floor(Math.log(r.target) / Math.log(r.floor))} stages`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
