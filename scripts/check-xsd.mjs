/**
 * Validate the catalog against the frozen XSD.
 *
 * `sources/catalog/schema/prompt_technique_catalog_1.3.0.xsd` came with the inherited
 * catalog and had never been used. Its own header says what it is for: it enforces the
 * element sequence, the controlled vocabularies, slug and arXiv-id forms, and the
 * agreement between `technique/@id` and `technique/id` — and it lists, honestly, the
 * five things it cannot express and which other validators must therefore keep.
 *
 * Reading it was worth the trip before running it. The eight records added to close the
 * ensembling gap carried a `source_audit.description` of "abstract-verified" and three
 * `determinism` values of the form "deterministic-given-…". None of those exist in any
 * schema; the JSON Schema typed both fields as free strings and accepted them. They are
 * fixed, and `contracts/technique-record.schema.json` now carries the same enumerations
 * so the offline check catches this class too.
 *
 * Two documents are validated:
 *   1. the frozen XML export, as a baseline — does the inherited data satisfy the
 *      inherited schema at all?
 *   2. XML generated from the imported 180-record catalog, which is the real check.
 *
 * XSD validation runs through a WebAssembly build of libxml2, so it needs no system
 * xmllint, no Java, and no native compilation — `npm run verify` stays offline and
 * portable.
 *
 * Exit 0 both valid · 1 a document fails · 2 the schema or input cannot be read.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { XmlDocument, XsdValidator } from "libxml2-wasm";

const XSD = "sources/catalog/schema/prompt_technique_catalog_1.3.0.xsd";
const FROZEN_XML = "sources/catalog/data/prompt_technique_catalog.xml";
const IMPORTED = "core/src/catalog/techniques.json";
const FROZEN_JSON = "sources/catalog/data/prompt_technique_catalog.json";

/* ── XML generation, in the shape the XSD declares ───────────────────────── */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

const el = (name, value, indent) => `${indent}<${name}>${esc(value)}</${name}>`;

/** markedString / markedArxivId: a null is `nil="true"`, not an empty element. */
const marked = (name, value, indent) =>
  value === null || value === undefined
    ? `${indent}<${name} nil="true"/>`
    : `${indent}<${name}>${esc(value)}</${name}>`;

/** An empty list carries empty="true" so "known to be absent" differs from "forgotten". */
function list(container, item, values, indent) {
  const vals = values ?? [];
  if (vals.length === 0) return `${indent}<${container} empty="true"/>`;
  const inner = vals.map((v) => `${indent}  <${item}>${esc(v)}</${item}>`).join("\n");
  return `${indent}<${container}>\n${inner}\n${indent}</${container}>`;
}

function source(tag, s, indent) {
  return [
    `${indent}<${tag}>`,
    el("authors", s.authors, indent + "  "),
    el("year", s.year, indent + "  "),
    el("title", s.title, indent + "  "),
    el("venue", s.venue, indent + "  "),
    marked("arxiv_id", s.arxiv_id, indent + "  "),
    marked("url", s.url, indent + "  "),
    `${indent}</${tag}>`,
  ].join("\n");
}

function template(t, indent) {
  const vars = (t.variables ?? []).map((v) =>
    [
      `${indent}    <variable>`,
      el("name", v.name, indent + "      "),
      marked("description", v.description, indent + "      "),
      marked("example", v.example, indent + "      "),
      `${indent}    </variable>`,
    ].join("\n"),
  );
  const variables = vars.length
    ? `${indent}  <variables>\n${vars.join("\n")}\n${indent}  </variables>`
    : `${indent}  <variables empty="true"/>`;

  return [
    `${indent}<template>`,
    el("template_name", t.template_name, indent + "  "),
    el("template", t.template, indent + "  "),
    el("template_id", t.template_id, indent + "  "),
    el("determinism", t.determinism, indent + "  "),
    marked("reproducibility_note", t.reproducibility_note, indent + "  "),
    variables,
    `${indent}</template>`,
  ].join("\n");
}

/** Element order below is the XSD's xs:sequence, which differs from the JSON's key order. */
function technique(r) {
  const i = "      ";
  const parts = [
    `    <technique id="${escAttr(r.id)}">`,
    el("id", r.id, i),
    el("name", r.name, i),
    el("category", r.category, i),
    el("subcategory", r.subcategory, i),
    el("executive_summary", r.executive_summary, i),
    el("description", r.description, i),
    el("verification_status", r.verification_status, i),
    el("cost_profile", r.cost_profile, i),
    el("status", r.status, i),
  ];
  if (r.corpus_file !== null && r.corpus_file !== undefined) parts.push(el("corpus_file", r.corpus_file, i));
  parts.push(el("schema_version", r.schema_version, i));
  parts.push(list("aliases", "alias", r.aliases, i));
  parts.push(list("when_to_use", "item", r.when_to_use, i));
  parts.push(list("when_not_to_use", "item", r.when_not_to_use, i));
  parts.push(list("known_pitfalls", "pitfall", r.known_pitfalls, i));
  parts.push(list("related_techniques", "technique_id", r.related_techniques, i));
  parts.push(list("tags", "tag", r.tags, i));
  parts.push(source("primary_source", r.primary_source, i));
  if ((r.secondary_sources ?? []).length > 0) {
    parts.push(`${i}<secondary_sources>`);
    for (const s of r.secondary_sources) parts.push(source("source", s, i + "  "));
    parts.push(`${i}</secondary_sources>`);
  }
  parts.push(`${i}<usage_templates>`);
  for (const t of r.usage_templates) parts.push(template(t, i + "  "));
  parts.push(`${i}</usage_templates>`);
  parts.push(`${i}<source_audit>`);
  parts.push(el("description", r.source_audit.description, i + "  "));
  parts.push(el("pitfalls", r.source_audit.pitfalls, i + "  "));
  parts.push(`${i}</source_audit>`);
  parts.push(`    </technique>`);
  return parts.join("\n");
}

export function buildXml(root = process.cwd()) {
  const records = JSON.parse(readFileSync(join(root, IMPORTED), "utf8")).techniques;
  const meta = JSON.parse(readFileSync(join(root, FROZEN_JSON), "utf8")).catalog_metadata;

  // generated_at is carried over from the frozen metadata rather than read from a
  // clock: the output has to be byte-identical run to run, like the JSON import.
  const categories = [...new Set(records.map((r) => r.category))].sort();
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<PromptTechniqueCatalog schema_version="${escAttr(meta.schema_version)}" ` +
    `catalog_version="${escAttr(meta.catalog_version)}" ` +
    `generated_at="${escAttr(meta.generated_at)}" entry_count="${records.length}">\n` +
    `  <catalog_metadata>\n` +
    el("catalog_name", meta.catalog_name, "    ") + "\n" +
    el("schema_version", meta.schema_version, "    ") + "\n" +
    el("catalog_version", meta.catalog_version, "    ") + "\n" +
    el("generated_at", meta.generated_at, "    ") + "\n" +
    el("entry_count", records.length, "    ") + "\n" +
    `    <categories>\n` +
    categories.map((c) => `      <category>${esc(c)}</category>`).join("\n") + "\n" +
    `    </categories>\n` +
    el("source_note", meta.source_note, "    ") + "\n" +
    `  </catalog_metadata>\n  <techniques>\n`;

  return head + records.map(technique).join("\n") + `\n  </techniques>\n</PromptTechniqueCatalog>\n`;
}

/* ── validation ──────────────────────────────────────────────────────────── */

export function validateAgainstXsd(xml, xsdText) {
  const schemaDoc = XmlDocument.fromString(xsdText);
  const validator = XsdValidator.fromDoc(schemaDoc);
  const doc = XmlDocument.fromString(xml);
  try {
    validator.validate(doc);
    return { valid: true, errors: [] };
  } catch (err) {
    const detail = err?.details ?? [{ message: String(err?.message ?? err) }];
    return { valid: false, errors: detail.map((d) => d.message ?? String(d)) };
  } finally {
    doc.dispose();
    validator.dispose();
    schemaDoc.dispose();
  }
}

export function checkXsd(root = process.cwd()) {
  let xsdText;
  try {
    xsdText = readFileSync(join(root, XSD), "utf8");
  } catch (err) {
    return { fatalCode: 2, fatal: `cannot read ${XSD} — ${err.message}` };
  }

  const results = {};
  try {
    results.frozen = validateAgainstXsd(readFileSync(join(root, FROZEN_XML), "utf8"), xsdText);
  } catch (err) {
    return { fatalCode: 2, fatal: `cannot read ${FROZEN_XML} — ${err.message}` };
  }

  let generated;
  try {
    generated = buildXml(root);
  } catch (err) {
    return { fatalCode: 2, fatal: `cannot build XML from ${IMPORTED} — ${err.message}` };
  }
  results.imported = validateAgainstXsd(generated, xsdText);

  return {
    ok: results.frozen.valid && results.imported.valid,
    fatalCode: null,
    fatal: null,
    results,
    generated,
  };
}

function main() {
  const emit = process.argv.indexOf("--emit");
  const r = checkXsd();

  if (r.fatal) {
    console.error(`check:xsd: ${r.fatal}`);
    return r.fatalCode;
  }

  if (emit !== -1 && process.argv[emit + 1]) {
    writeFileSync(process.argv[emit + 1], r.generated);
    console.log(`check:xsd — wrote ${process.argv[emit + 1]}`);
  }

  for (const [label, res] of Object.entries(r.results)) {
    if (res.valid) {
      console.log(`check:xsd — ${label} catalog validates against ${XSD}`);
    } else {
      console.error(`check:xsd — ${label} catalog FAILS ${XSD}:`);
      for (const e of res.errors.slice(0, 15)) console.error(`    ${String(e).trim()}`);
      if (res.errors.length > 15) console.error(`    … and ${res.errors.length - 15} more`);
    }
  }

  if (r.ok) {
    console.log(`  the XSD names five constraints it cannot express; check:citations and`);
    console.log(`  import:catalog carry those. A green result here is necessary, not sufficient.`);
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
