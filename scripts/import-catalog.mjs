/**
 * Import the technique catalog out of the frozen sources and into Core.
 *
 * This is the boundary where inherited data becomes the project's own. Three things
 * happen here and nowhere else:
 *
 *   1. Corrections are applied. `sources/` is hash-pinned and is the record of what
 *      was inherited, defects included — it must never be edited. Eight citation
 *      titles are wrong there, verified against arXiv's own metadata, and they are
 *      fixed here so the fix is a reviewable diff with evidence attached.
 *   2. Every record is validated against `contracts/technique-record.schema.json`.
 *      Contract-first applies to data too: an import that emits a record the contract
 *      rejects fails rather than shipping it.
 *   3. The result is written as a JSON module that Core imports directly. Core stays
 *      pure — a module import is not I/O, which is why the catalog can live behind a
 *      registry with no filesystem access at runtime.
 *
 * **Deterministic by construction.** No timestamp is written: re-running produces
 * byte-identical output, so `--check` can assert the committed file is what the
 * current source and corrections produce. A generated file that cannot be
 * regenerated is just a file somebody edited once.
 *
 *   npm run import:catalog            write core/src/catalog/techniques.json
 *   npm run import:catalog -- --check verify the committed file is up to date
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv } from "ajv";

const SOURCE = "sources/catalog/data/prompt_technique_catalog.json";
const CORRECTIONS = "scripts/catalog-corrections.json";
const ADDITIONS = "scripts/catalog-additions.json";
const SCHEMA = "contracts/technique-record.schema.json";
const OUT = "core/src/catalog/techniques.json";

/** Set a dotted path, refusing if the current value is not what the correction expects. */
function applyCorrection(record, correction) {
  const path = correction.field.split(".");
  let node = record;
  for (const seg of path.slice(0, -1)) {
    if (node[seg] === undefined) return `path ${correction.field} does not exist`;
    node = node[seg];
  }
  const leaf = path[path.length - 1];
  if (node[leaf] !== correction.from) {
    return `expected ${JSON.stringify(correction.from)} but frozen data holds ${JSON.stringify(node[leaf])}`;
  }
  node[leaf] = correction.to;
  return null;
}

export function importCatalog(root = process.cwd()) {
  const at = (p) => join(root, p);

  const raw = readFileSync(at(SOURCE), "utf8");
  const techniques = JSON.parse(raw).techniques;
  const corrections = JSON.parse(readFileSync(at(CORRECTIONS), "utf8"));
  const schema = JSON.parse(readFileSync(at(SCHEMA), "utf8"));

  const problems = [];
  const byId = new Map(techniques.map((r) => [r.id, r]));

  // Deep copy so the frozen data in memory is never the thing we mutate.
  const out = JSON.parse(JSON.stringify(techniques));
  const outById = new Map(out.map((r) => [r.id, r]));

  let applied = 0;
  for (const c of corrections.corrections ?? []) {
    if (!c.reason || !c.evidence) {
      problems.push(`${c.technique}: correction has no reason or no evidence`);
      continue;
    }
    if (!byId.has(c.technique)) {
      problems.push(`${c.technique}: no such technique in the frozen catalog — stale correction`);
      continue;
    }
    const err = applyCorrection(outById.get(c.technique), c);
    if (err) problems.push(`${c.technique}: ${err}`);
    else applied++;
  }

  /**
   * Additions close gaps the inherited catalog has. They are held to the same bar as
   * everything else: same contract, no id that collides with a frozen record, and no
   * silent overwrite — a collision is a refusal, because a record that shadows a
   * frozen one is indistinguishable from a correction that forgot to say so.
   */
  const additions = JSON.parse(readFileSync(at(ADDITIONS), "utf8"));
  let added = 0;
  for (const rec of additions.records ?? []) {
    if (byId.has(rec.id)) {
      problems.push(`${rec.id}: addition collides with a record already in the frozen catalog`);
      continue;
    }
    if (outById.has(rec.id)) {
      problems.push(`${rec.id}: addition declared twice`);
      continue;
    }
    out.push(rec);
    outById.set(rec.id, rec);
    added++;
  }

  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  for (const r of out) {
    if (!validate(r)) {
      const first = (validate.errors ?? [])[0];
      problems.push(`${r.id}: fails ${SCHEMA} — ${first?.instancePath || "(root)"} ${first?.message}`);
    }
  }

  // Every `related_techniques` reference must resolve, or the graph has dangling edges.
  for (const r of out) {
    for (const ref of r.related_techniques ?? []) {
      if (!outById.has(ref)) problems.push(`${r.id}: related_techniques names "${ref}", which is not a record`);
    }
  }

  const payload = {
    _provenance: {
      note: "Generated by `npm run import:catalog`. Do not edit by hand.",
      source: SOURCE,
      source_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      corrections: CORRECTIONS,
      corrections_applied: applied,
      additions: ADDITIONS,
      records_added: added,
      contract: SCHEMA,
    },
    techniques: out,
  };

  return { ok: problems.length === 0, problems, applied, added, count: out.length, payload };
}

function main() {
  const check = process.argv.includes("--check");
  const r = importCatalog();

  if (!r.ok) {
    console.error(`import:catalog — refused. ${r.problems.length} problem(s):\n`);
    for (const p of r.problems) console.error(`  ${p}`);
    console.error(`\nNothing was written. Fix ${CORRECTIONS} or the contract; sources/ stays frozen.`);
    return 1;
  }

  const rendered = JSON.stringify(r.payload, null, 2) + "\n";

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== rendered) {
      console.error(`import:catalog --check — ${OUT} is not what the source and corrections produce.`);
      console.error(`  Run \`npm run import:catalog\` and commit the result.`);
      return 1;
    }
    console.log(`import:catalog --check — OK. ${r.count} records (${r.applied} corrected, ${r.added} added), output current.`);
    return 0;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rendered);
  console.log(`import:catalog — wrote ${OUT}`);
  console.log(`  ${r.count} records · ${r.applied} corrections applied · ${r.added} records added`);
  console.log(`  all validate against ${SCHEMA}; every related_techniques reference resolves`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
