/**
 * `Documentation/CONTRACTS.md`, checked against the schemas it describes.
 *
 * The audit at `34206e9` found this file documenting 6 of 18 schemas, three of those at wrong
 * versions, and one carrying enum values that exist in no schema. Every other derived document
 * here has a guard — `CAPABILITY_MATRIX.md`, `TRUTH_BOUNDARY.md`, `MANIFEST_SHAPES.md`, the
 * fence explainer — and this one, which describes the cross-boundary interface itself, had
 * none. So it drifted for as long as nobody happened to read it beside the schemas.
 *
 * ## Why this checks rather than generates
 *
 * The obvious move is `docs:matrix`'s: derive the whole file and diff it. That is wrong here.
 * Most of these 458 lines are curated prose — the effect-ownership principle, why four
 * contracts are TypeScript-only, what a binding surface is — and none of it is derivable from
 * a schema. Generating the file would delete the part worth having in order to guard the part
 * that drifts.
 *
 * So the split is: the INVENTORY table is generated between markers, and the prose's version
 * claims are verified in place. Two failure modes, both mechanical:
 *
 *   1. an inline `contracts/<name>/<x.y.z>` that disagrees with that schema's `$id`;
 *   2. a schema file the inventory does not account for, or an inventory row for a schema
 *      that does not exist.
 *
 * ## The `$id` is the authority, always
 *
 * A version lives in the schema's own `$id` and nowhere else. This script never writes one and
 * never reads a version from anywhere but a `.schema.json`. If the doc and the schema
 * disagree, the doc is wrong by construction — which is the only rule that makes a check like
 * this worth running.
 *
 * ## Illustrative ids are declared, not guessed
 *
 * Six ids in the prose name no schema file: four are TypeScript-only interfaces in
 * `contracts/index.ts` and two describe contracts that exist in neither place. Left to
 * inference, "no schema file" is indistinguishable from "schema file missing", so the doc
 * declares them in a machine-readable list and this script requires that every non-schema id
 * appear there. Adding a new illustrative id without declaring it fails.
 *
 *   node scripts/check-contracts-doc.mjs           write the inventory table
 *   node scripts/check-contracts-doc.mjs --check   fail if the committed file is not current
 *
 * Exit 0 current · 1 stale or inconsistent · 2 the tree cannot be read.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DOC = "Documentation/CONTRACTS.md";
const SCHEMA_DIR = "contracts";

const BEGIN = "<!-- BEGIN GENERATED: schema-inventory -->";
const END = "<!-- END GENERATED: schema-inventory -->";

/** Ids that appear in the prose and name no schema file, declared by the doc itself. */
const DECLARED_BEGIN = "<!-- BEGIN DECLARED: no-schema-file -->";
const DECLARED_END = "<!-- END DECLARED: no-schema-file -->";

const read = (root, p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

/** Every schema on disk, with the version from its own `$id` — the only authority. */
export function schemaVersions(root = process.cwd(), opts = {}) {
  const list = opts.listSchemas ?? (() => readdirSync(join(root, SCHEMA_DIR)).filter((f) => f.endsWith(".schema.json")));
  const readSchema = opts.readSchema ?? ((f) => JSON.parse(read(root, join(SCHEMA_DIR, f))));
  const out = new Map();
  for (const file of list().sort()) {
    const id = readSchema(file).$id ?? "";
    const m = /\/contracts\/([a-z0-9-]+)\/(\d+\.\d+\.\d+)$/.exec(id);
    if (!m) throw new Error(`${file}: $id "${id}" is not .../contracts/<name>/<x.y.z>`);
    const stem = file.replace(/\.schema\.json$/, "");
    if (m[1] !== stem) throw new Error(`${file}: $id names "${m[1]}" but the file is "${stem}"`);
    out.set(m[1], m[2]);
  }
  return out;
}

const section = (text, begin, end, label) => {
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`${DOC}: the ${label} markers are missing or out of order`);
  }
  return { before: text.slice(0, a + begin.length), body: text.slice(a + begin.length, b), after: text.slice(b) };
};

/** Names the doc declares as having no schema file, one per `- \`name\`` line. */
export const declaredNoSchema = (text) =>
  new Set(
    [...section(text, DECLARED_BEGIN, DECLARED_END, "declared no-schema-file").body.matchAll(/^-\s+`([a-z0-9-]+)`/gm)]
      .map((m) => m[1]),
  );

/** Every `contracts/<name>/<version>` the prose claims, outside the generated table. */
export const inlineClaims = (text) => {
  const { before, after } = section(text, BEGIN, END, "schema-inventory");
  const prose = before.slice(0, before.length - BEGIN.length) + after.slice(END.length);
  const out = [];
  for (const m of prose.matchAll(/contracts\/([a-z0-9-]+)\/(\d+\.\d+\.\d+)/g)) {
    out.push({ name: m[1], version: m[2] });
  }
  return out;
};

export function renderInventory(versions, documented) {
  const rows = [...versions.entries()].map(([name, version]) => {
    const here = documented.has(name) ? "yes" : "—";
    return `| \`${name}\` | ${version} | ${here} |`;
  });
  return [
    "",
    `All ${versions.size} schema files under \`contracts/\`, with the version from each \`$id\`.`,
    "Generated by `npm run docs:contracts`; `check:contracts` fails when it is not current.",
    "**Described below** says whether this document has prose for it — most do not, and that is",
    "recorded rather than implied.",
    "",
    "| schema | version | described below |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** Which schemas the prose actually describes: it cites their id. */
const documentedNames = (text) => new Set(inlineClaims(text).map((c) => c.name));

export function checkContractsDoc(root = process.cwd(), opts = {}) {
  const problems = [];
  let versions;
  let text;
  try {
    versions = schemaVersions(root, opts);
    text = opts.readDoc ? opts.readDoc() : read(root, DOC);
  } catch (err) {
    return { ok: false, fatalCode: 2, fatal: err.message };
  }

  let declared;
  let claims;
  try {
    declared = declaredNoSchema(text);
    claims = inlineClaims(text);
  } catch (err) {
    return { ok: false, fatalCode: 2, fatal: err.message };
  }

  for (const { name, version } of claims) {
    const real = versions.get(name);
    if (real === undefined) {
      if (!declared.has(name)) {
        problems.push(
          `\`${name}\` is cited at ${version} and has no schema file. If it is illustrative, ` +
          `declare it in the no-schema-file list; if the file is missing, that is the bug.`,
        );
      }
      continue;
    }
    if (real !== version) {
      problems.push(`\`${name}\` is cited at ${version}; its \$id says ${real}. The \$id is the authority.`);
    }
  }

  for (const name of declared) {
    if (versions.has(name)) {
      problems.push(
        `\`${name}\` is declared as having no schema file, but \`contracts/${name}.schema.json\` exists. ` +
        `Remove it from the list — a stale exemption hides a real contract.`,
      );
    }
  }

  const rendered = renderInventory(versions, documentedNames(text));
  const current = section(text, BEGIN, END, "schema-inventory").body;
  if (current !== rendered) {
    problems.push(`the schema inventory is not what the repository produces — run \`npm run docs:contracts\`.`);
  }

  return { ok: problems.length === 0, problems, rendered, schemaCount: versions.size, claimCount: claims.length };
}

function main() {
  const root = process.cwd();
  const check = process.argv.includes("--check");

  const result = checkContractsDoc(root);
  if (result.fatal) {
    console.error(`check:contracts — ${result.fatal}`);
    return result.fatalCode;
  }

  if (!check) {
    const text = read(root, DOC);
    const { before, after } = section(text, BEGIN, END, "schema-inventory");
    writeFileSync(join(root, DOC), before + result.rendered + after, "utf8");
    console.log(`docs:contracts — wrote ${DOC}. ${result.schemaCount} schema(s), ${result.claimCount} inline version claim(s).`);
    // The inventory is now current; any remaining problem is a prose claim, which this
    // command must not silently rewrite — a version is the schema's to state, not the doc's.
    const after2 = checkContractsDoc(root);
    for (const p of after2.problems) console.error(`  still wrong: ${p}`);
    return after2.problems.length === 0 ? 0 : 1;
  }

  if (!result.ok) {
    console.error(
      `check:contracts — ${result.problems.length} problem(s) in ${DOC}:\n\n` +
      result.problems.map((p) => `  ${p}`).join("\n") +
      `\n\n  This document describes the cross-boundary interface, and until 6 September 2026 it\n` +
      `  was the one derived document with no guard. It drifted to 6 of 18 schemas, three at\n` +
      `  wrong versions. A version lives in the schema's \$id and nowhere else.`,
    );
    return 1;
  }
  console.log(`check:contracts — OK. ${result.schemaCount} schema(s), ${result.claimCount} inline version claim(s) agree with their \$id.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
