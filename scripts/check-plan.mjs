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
import { pathToFileURL } from "node:url";

const PLAN = "Documentation/IMPLEMENTATION_PLAN.md";
const LINTER = "sources/v5/prompt_lint.py";

/**
 * Normalise line endings before any regex touches the text.
 *
 * This is not defensive garnish. The first version anchored on `plan-status\n` and
 * passed on the branch it was written on, then exited 2 the moment `git checkout`
 * re-materialised the file with CRLF — the working tree is Windows and only
 * `sources/**` is pinned to LF by `.gitattributes`. A checker that depends on which
 * branch you last switched from is worse than no checker, because it fails loudly
 * for the wrong reason and trains you to ignore it.
 */
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/**
 * Exported so the suite can point it at a fixture tree with a planted false claim.
 * Returns rather than exits, so a caller can assert on the failures themselves and
 * not merely on an exit code.
 */
export function checkPlan(root = process.cwd()) {
  const at = (p) => join(root, p);
  const fail = (code, message) => ({ ok: false, fatalCode: code, fatal: message, checks: [], failures: [] });

  let plan;
  try {
    plan = readText(at(PLAN));
  } catch {
    return fail(2, `cannot read ${PLAN}. The plan is the thing being checked.`);
  }

  const block = plan.match(/```json plan-status\n([\s\S]*?)```/);
  if (!block) {
    return fail(2, `${PLAN} has no \`\`\`json plan-status block.\n  Without it the plan asserts nothing and this check cannot run.`);
  }

  let declared;
  try {
    declared = JSON.parse(block[1]);
  } catch (err) {
    return fail(2, `the plan-status block is not valid JSON — ${err.message}`);
  }

  const failures = [];
  const checks = [];

  const claim = (label, expected, actual, hint) => {
    const ok = JSON.stringify(expected) === JSON.stringify(actual);
    checks.push({ label, expected, actual, ok });
    if (!ok) failures.push({ label, expected, actual, hint });
  };

  const dirNames = (dir) =>
    existsSync(at(dir))
      ? readdirSync(at(dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      : [];

  // Gates. `scripts/ported-gates.json` is the pinned authority, and the differential
  // oracle already cross-checks it against the live registry — so reading it here does
  // not need the TypeScript module and cannot disagree with it silently.
  const ported = JSON.parse(readText(at("scripts/ported-gates.json")));
  claim("gates.ported", declared.gates.ported, ported.ported.length,
    "update the plan, or scripts/ported-gates.json if a gate was added");

  const sourceGateIds = new Set(
    [...readText(at(LINTER)).matchAll(/"gate":\s*"([A-Z_]+)"/g)].map((m) => m[1]),
  );
  claim("gates.source_total", declared.gates.source_total, sourceGateIds.size,
    `derived from distinct gate ids emitted by ${LINTER}`);

  // Stages built: one module per stage under core/src/stages.
  const stageFiles = existsSync(at("core/src/stages"))
    ? readdirSync(at("core/src/stages")).filter((f) => f.endsWith(".ts")).length
    : 0;
  claim("stages.built", declared.stages.built, stageFiles, "count of core/src/stages/*.ts");

  // Stage target: the STAGE_IDS tuple in the contract is the authority.
  const stageIds = readText(at("contracts/index.ts"))
    .match(/export const STAGE_IDS = \[([\s\S]*?)\] as const;/)?.[1]
    .match(/"[a-z_]+"/g) ?? [];
  claim("stages.target", declared.stages.target, stageIds.length,
    "derived from STAGE_IDS in contracts/index.ts");

  claim("contracts.schemas", declared.contracts.schemas,
    readdirSync(at("contracts")).filter((f) => f.endsWith(".schema.json")).length,
    "count of contracts/*.schema.json");

  claim("adapters", declared.adapters.slice().sort(), dirNames("adapters"), "directories under adapters/");
  claim("shells", declared.shells.slice().sort(), dirNames("shells"), "directories under shells/");

  // Catalog: what is available in the frozen source, and what has been imported.
  const catalogSource = "sources/catalog/data/prompt_technique_catalog.json";
  const available = existsSync(at(catalogSource))
    ? (JSON.parse(readText(at(catalogSource))).techniques ?? []).length
    : 0;
  claim("catalog.records_available", declared.catalog.records_available, available,
    `derived from ${catalogSource}`);

  // Count the records actually imported, rather than inferring "all of them" from the
  // presence of a file. The earlier version did the latter, which would have reported
  // 172 for a partial import.
  let importedCatalog = 0;
  const importedPath = at("core/src/catalog/techniques.json");
  if (existsSync(importedPath)) {
    try {
      importedCatalog = (JSON.parse(readText(importedPath)).techniques ?? []).length;
    } catch {
      importedCatalog = -1; // unreadable — never silently equal to the declared number
    }
  }
  claim("catalog.records_imported", declared.catalog.records_imported, importedCatalog,
    "count of techniques in core/src/catalog/techniques.json — run `npm run import:catalog`");

  claim("sources.frozen_files", declared.sources.frozen_files,
    JSON.parse(readText(at("sources/MANIFEST.json"))).files.length,
    "entries in sources/MANIFEST.json");

  claim("ci.configured", declared.ci.configured, existsSync(at(".github")),
    "presence of a .github directory — Phase 7 is blocked without a remote");

  // Commands the plan says exist must exist.
  const scripts = Object.keys(JSON.parse(readText(at("package.json"))).scripts);
  claim("commands (all present in package.json)", [],
    declared.commands.filter((c) => !scripts.includes(c)),
    "the plan lists a command that package.json does not define");

  // …and commands the plan says are planned must NOT exist, or they are built and the
  // plan is understating what is done.
  claim("planned_commands (none built yet)", [],
    declared.planned_commands.filter((c) => scripts.includes(c)),
    "a command listed as planned is already implemented — move it to `commands`");

  /**
   * Every `npm run X` the plan mentions in prose must be either built or declared as
   * planned. This is what stops the plan from quietly citing tooling that does not
   * exist, which is how `scaffold:gate` ended up in contributor instructions.
   */
  const mentioned = new Set([...plan.matchAll(/`npm run ([a-z:]+)`/g)].map((m) => m[1]));
  claim("commands mentioned in prose are declared", [],
    [...mentioned].filter(
      (c) => !declared.commands.includes(c) && !declared.planned_commands.includes(c),
    ).sort(),
    "add each to `commands` (built) or `planned_commands` (not built)");

  return { ok: failures.length === 0, fatalCode: null, fatal: null, checks, failures, declared };
}

function main() {
  const { ok, fatal, fatalCode, checks, failures, declared } = checkPlan();

  if (fatal) {
    console.error(`check:plan: ${fatal}`);
    return fatalCode;
  }

  if (ok) {
    console.log(`check:plan — OK. ${checks.length} claims in ${PLAN} verified against the repo.`);
    const g = declared.gates;
    const s = declared.stages;
    console.log(
      `  gates ${g.ported}/${g.source_total} · stages ${s.built}/${s.target} · ` +
        `schemas ${declared.contracts.schemas} · adapters ${declared.adapters.length} · ` +
        `shells ${declared.shells.length} · catalog ${declared.catalog.records_imported}/${declared.catalog.records_available} · ` +
        `CI ${declared.ci.configured ? "configured" : "none"}`,
    );
    return 0;
  }

  console.error(`check:plan — ${failures.length} false claim(s) in ${PLAN}:\n`);
  for (const f of failures) {
    console.error(`  ${f.label}`);
    console.error(`    plan says: ${JSON.stringify(f.expected)}`);
    console.error(`    repo says: ${JSON.stringify(f.actual)}`);
    console.error(`    ${f.hint}\n`);
  }
  console.error("The plan is a claim about this repository. Fix whichever one is wrong.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
