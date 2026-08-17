#!/usr/bin/env node
/**
 * Verify every falsifiable claim in `Documentation/IMPLEMENTATION_PLAN.md`.
 *
 * The plan was cited by six documents before it existed. Phase numbers were quoted
 * and exit gates referenced against a page nobody had written — the same failure
 * that put a wrong gate count in the documentation for months and produced
 * SOURCE_VERIFICATION.md. A planning document is exactly the artifact that goes
 * false silently, because nothing executes it.
 *
 * So the plan carries one machine-checked block and this script re-derives every
 * number in it from the repository. It does not check prose; it checks the counts
 * and the command names, which is where the previous drift actually happened.
 *
 * Exit 0 all claims verified · 1 a claim is false · 2 the plan cannot be read.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PLAN = "Documentation/IMPLEMENTATION_PLAN.md";
const LINTER = "sources/v5/prompt_lint.py";

/* ── read the declared status ─────────────────────────────────────────────── */

let plan;
try {
  plan = readFileSync(PLAN, "utf8");
} catch {
  console.error(`check:plan: cannot read ${PLAN}. The plan is the thing being checked.`);
  process.exit(2);
}

const block = plan.match(/```json plan-status\n([\s\S]*?)```/);
if (!block) {
  console.error(`check:plan: ${PLAN} has no \`\`\`json plan-status block.`);
  console.error("  Without it the plan asserts nothing and this check cannot run.");
  process.exit(2);
}

let declared;
try {
  declared = JSON.parse(block[1]);
} catch (err) {
  console.error(`check:plan: the plan-status block is not valid JSON — ${err.message}`);
  process.exit(2);
}

/* ── re-derive each claim from the repository ─────────────────────────────── */

const failures = [];
const checks = [];

function claim(label, expected, actual, hint) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  checks.push({ label, expected, actual, ok });
  if (!ok) failures.push({ label, expected, actual, hint });
}

const dirNames = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

// Gates. `scripts/ported-gates.json` is the pinned authority, and the differential
// oracle already cross-checks it against the live registry — so reading it here does
// not need the TypeScript module and cannot disagree with it silently.
const ported = JSON.parse(readFileSync("scripts/ported-gates.json", "utf8"));
claim("gates.ported", declared.gates.ported, ported.ported.length,
  "update the plan, or scripts/ported-gates.json if a gate was added");

const sourceGateIds = new Set(
  [...readFileSync(LINTER, "utf8").matchAll(/"gate":\s*"([A-Z_]+)"/g)].map((m) => m[1]),
);
claim("gates.source_total", declared.gates.source_total, sourceGateIds.size,
  `derived from distinct gate ids emitted by ${LINTER}`);

// Stages built: one module per stage under core/src/stages.
const stageFiles = existsSync("core/src/stages")
  ? readdirSync("core/src/stages").filter((f) => f.endsWith(".ts")).length
  : 0;
claim("stages.built", declared.stages.built, stageFiles,
  "count of core/src/stages/*.ts");

// Stage target: the STAGE_IDS tuple in the contract is the authority.
const stageIds = readFileSync("contracts/index.ts", "utf8")
  .match(/export const STAGE_IDS = \[([\s\S]*?)\] as const;/)?.[1]
  .match(/"[a-z_]+"/g) ?? [];
claim("stages.target", declared.stages.target, stageIds.length,
  "derived from STAGE_IDS in contracts/index.ts");

claim("contracts.schemas", declared.contracts.schemas,
  readdirSync("contracts").filter((f) => f.endsWith(".schema.json")).length,
  "count of contracts/*.schema.json");

claim("adapters", declared.adapters.slice().sort(), dirNames("adapters"),
  "directories under adapters/");

claim("shells", declared.shells.slice().sort(), dirNames("shells"),
  "directories under shells/");

// Catalog: what is available in the frozen source, and what has been imported.
const catalogSource = "sources/catalog/data/prompt_technique_catalog.json";
const available = existsSync(catalogSource)
  ? (JSON.parse(readFileSync(catalogSource, "utf8")).techniques ?? []).length
  : 0;
claim("catalog.records_available", declared.catalog.records_available, available,
  `derived from ${catalogSource}`);

const importedCatalog = existsSync("core/src/catalog")
  ? readdirSync("core/src/catalog").filter((f) => f.endsWith(".json")).length
  : 0;
claim("catalog.records_imported", declared.catalog.records_imported,
  importedCatalog === 0 ? 0 : available,
  "core/src/catalog does not exist yet; the plan must not claim records are imported");

claim("sources.frozen_files", declared.sources.frozen_files,
  JSON.parse(readFileSync("sources/MANIFEST.json", "utf8")).files.length,
  "entries in sources/MANIFEST.json");

claim("ci.configured", declared.ci.configured, existsSync(".github"),
  "presence of a .github directory — Phase 7 is blocked without a remote");

// Commands the plan says exist must exist.
const scripts = Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts);
const missing = declared.commands.filter((c) => !scripts.includes(c));
claim("commands (all present in package.json)", [], missing,
  "the plan lists a command that package.json does not define");

// …and commands the plan says are planned must NOT exist, or they are built and the
// plan is understating what is done.
const wronglyPlanned = declared.planned_commands.filter((c) => scripts.includes(c));
claim("planned_commands (none built yet)", [], wronglyPlanned,
  "a command listed as planned is already implemented — move it to `commands`");

/**
 * Every `npm run X` the plan mentions in prose must be either built or declared as
 * planned. This is what stops the plan from quietly citing tooling that does not
 * exist, which is how `scaffold:gate` ended up in contributor instructions.
 */
const mentioned = new Set([...plan.matchAll(/`npm run ([a-z:]+)`/g)].map((m) => m[1]));
const undeclared = [...mentioned].filter(
  (c) => !declared.commands.includes(c) && !declared.planned_commands.includes(c),
).sort();
claim("commands mentioned in prose are declared", [], undeclared,
  "add each to `commands` (built) or `planned_commands` (not built)");

/* ── report ───────────────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`check:plan — OK. ${checks.length} claims in ${PLAN} verified against the repo.`);
  const g = declared.gates;
  const s = declared.stages;
  console.log(
    `  gates ${g.ported}/${g.source_total} · stages ${s.built}/${s.target} · ` +
      `schemas ${declared.contracts.schemas} · adapters ${declared.adapters.length} · ` +
      `shells ${declared.shells.length} · catalog ${declared.catalog.records_imported}/${declared.catalog.records_available} · ` +
      `CI ${declared.ci.configured ? "configured" : "none"}`,
  );
  process.exit(0);
}

console.error(`check:plan — ${failures.length} false claim(s) in ${PLAN}:\n`);
for (const f of failures) {
  console.error(`  ${f.label}`);
  console.error(`    plan says: ${JSON.stringify(f.expected)}`);
  console.error(`    repo says: ${JSON.stringify(f.actual)}`);
  console.error(`    ${f.hint}\n`);
}
console.error("The plan is a claim about this repository. Fix whichever one is wrong.");
process.exit(1);
