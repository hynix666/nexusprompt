/**
 * Check every arXiv-cited catalog record against arXiv's own metadata.
 *
 * **Deliberately not part of `npm run verify`.** That command is offline by design —
 * a build that needs the network is a build that fails for reasons unrelated to the
 * code. This is a separate, occasional audit, and its results are written down in
 * `Documentation/LITERATURE_CORPUS.md` rather than assumed to still hold.
 *
 * ## Why arXiv and not the PDF
 *
 * The first version of this audit compared citations against the PDFs and reported a
 * defect that was not one. `chain-of-symbol` cites "…Elicits Planning in Large Langauge
 * Models", misspelling included; the v7 PDF is titled "…for Spatial Reasoning in Large
 * Language Models". The catalog is right: the authors retitled the camera-ready for
 * COLM 2024 and never updated the arXiv metadata, so the record matches the authority
 * for what a preprint is *called*, and the typo is arXiv's own.
 *
 * A PDF is not the authority for its own citation.
 *
 * Batched forty at a time with the 3-second pause arXiv's API terms request.
 *
 * Exit 0 every title matches · 1 at least one differs · 2 the catalog cannot be read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CATALOG = "sources/catalog/data/prompt_technique_catalog.json";
const ENDPOINT = "http://export.arxiv.org/api/query";
const BATCH = 40;
const PAUSE_MS = 3500;

const unescape = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Titles are compared on alphanumerics only: arXiv renders LaTeX like `$k$NN`. */
const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

export async function checkCitationsOnline(root = process.cwd(), fetchImpl = fetch) {
  let techniques;
  try {
    techniques = JSON.parse(readFileSync(join(root, CATALOG), "utf8")).techniques;
  } catch (err) {
    return { ok: false, fatalCode: 2, fatal: `cannot read ${CATALOG} — ${err.message}` };
  }

  const records = techniques
    .filter((r) => r.primary_source?.arxiv_id)
    .map((r) => ({ tech: r.id, id: String(r.primary_source.arxiv_id).trim(), title: r.primary_source.title }));

  const found = new Map();
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    const url = `${ENDPOINT}?id_list=${slice.map((r) => r.id).join(",")}&max_results=${slice.length}`;
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false, fatalCode: 2, fatal: `arXiv returned HTTP ${res.status}` };
    const xml = await res.text();
    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const e = m[1];
      const abs = (e.match(/<id>(http:\/\/arxiv\.org\/abs\/[^<]+)<\/id>/) ?? [])[1] ?? "";
      const bare = abs.replace(/^http:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
      const title = unescape(((e.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "").replace(/\s+/g, " ").trim());
      if (bare) found.set(bare, { title, version: abs.split("/").pop() });
    }
    if (i + BATCH < records.length) await new Promise((s) => setTimeout(s, PAUSE_MS));
  }

  const matches = [], differs = [], unresolved = [];
  for (const r of records) {
    const a = found.get(r.id);
    if (!a) { unresolved.push(r); continue; }
    (norm(r.title) === norm(a.title) ? matches : differs).push({ ...r, arxivTitle: a.title, version: a.version });
  }

  return { ok: differs.length === 0 && unresolved.length === 0, fatalCode: null, fatal: null,
           total: records.length, matches, differs, unresolved };
}

async function main() {
  const r = await checkCitationsOnline();
  if (r.fatal) { console.error(`check:citations:online: ${r.fatal}`); return r.fatalCode; }

  console.log(`check:citations:online — ${r.total} arXiv-cited records checked against arXiv.`);
  console.log(`  ${r.matches.length} titles match · ${r.differs.length} differ · ${r.unresolved.length} unresolved`);

  if (r.unresolved.length) {
    console.error(`\nidentifiers arXiv did not resolve:`);
    for (const u of r.unresolved) console.error(`  ${u.tech}  ${u.id}`);
  }
  if (r.differs.length) {
    console.error(`\ntitles differing from arXiv (see Documentation/LITERATURE_CORPUS.md for adjudication):`);
    for (const d of r.differs) {
      console.error(`  ${d.tech}  (${d.version})`);
      console.error(`     catalog: ${d.title}`);
      console.error(`     arXiv  : ${d.arxivTitle}`);
    }
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
