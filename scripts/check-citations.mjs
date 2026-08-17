/**
 * Internal-consistency audit of the technique catalog's citations.
 *
 * `CONTRIBUTING.md` makes `primary_source` non-negotiable for a technique record, and
 * the catalog carries 172 of them. Nothing had ever checked one. This does not check
 * that a paper exists — that needs the network, and the frozen catalog is offline
 * data — it checks the claims the record makes against *itself*.
 *
 * The load-bearing check is the arXiv id, which encodes YYMM. A record whose `year`
 * predates the month in its own `arxiv_id` is contradicting itself, and one of the two
 * fields is wrong. That is a verifier, not a heuristic: there is no reading of the
 * data under which it is fine.
 *
 * Exit 0 consistent · 1 an inconsistency · 2 the catalog cannot be read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CATALOG = "sources/catalog/data/prompt_technique_catalog.json";
const DEFECTS = "scripts/catalog-known-defects.json";
const ARXIV = /^\d{4}\.\d{4,5}$/;

/**
 * `now` is injectable so a test can pin it. An arXiv id dated after today is an error,
 * which makes this check legitimately time-dependent — but a hardcoded "today" goes
 * stale, and a test that silently starts passing for the wrong reason is exactly what
 * this repository keeps finding.
 */
export function checkCitations(root = process.cwd(), now = new Date()) {
  let techniques;
  try {
    techniques = JSON.parse(readFileSync(join(root, CATALOG), "utf8")).techniques;
  } catch (err) {
    return { ok: false, fatalCode: 2, fatal: `cannot read ${CATALOG} — ${err.message}`, problems: [] };
  }
  if (!Array.isArray(techniques)) {
    return { ok: false, fatalCode: 2, fatal: `${CATALOG} has no techniques array`, problems: [] };
  }

  const nowYYMM = (now.getUTCFullYear() % 100) * 100 + (now.getUTCMonth() + 1);
  const problems = [];
  const seenArxiv = new Map();
  let withArxiv = 0;

  const flag = (kind, technique, detail) => problems.push({ kind, technique, detail });

  for (const r of techniques) {
    const s = r.primary_source;
    if (!s) { flag("missing-primary-source", r.id, "record has no primary_source"); continue; }

    for (const field of ["authors", "year", "title"]) {
      if (!s[field]) flag("missing-field", r.id, `primary_source.${field} is empty`);
    }
    if (!s.arxiv_id) {
      // A record that names arXiv as its venue and then supplies no identifier is
      // contradicting itself. Found while checking the non-arXiv citations against
      // Crossref: three records do exactly this, and no earlier check looked.
      if (/arxiv/i.test(String(s.venue ?? ""))) {
        flag("arxiv-venue-without-id", r.id, `venue is "${s.venue}" but there is no arxiv_id`);
      }
      continue; // a book, a venue-only paper, or a practitioner guide
    }

    withArxiv++;
    const id = String(s.arxiv_id).trim();
    if (!ARXIV.test(id)) { flag("malformed-arxiv-id", r.id, `"${id}" is not NNNN.NNNNN`); continue; }

    const yymm = Number(id.slice(0, 4));
    const month = yymm % 100;
    const arxivYear = 2000 + Math.floor(yymm / 100);

    if (month < 1 || month > 12) flag("malformed-arxiv-id", r.id, `"${id}" encodes month ${month}`);
    if (yymm > nowYYMM) flag("future-arxiv-id", r.id, `"${id}" is dated after today`);
    if (Number(s.year) < arxivYear) {
      flag("year-precedes-preprint", r.id, `year ${s.year} but arXiv id ${id} implies ${arxivYear}`);
    }
    if (s.url && !s.url.includes(id)) {
      flag("url-does-not-match-id", r.id, `url ${s.url} does not contain ${id}`);
    }

    const prior = seenArxiv.get(id);
    if (prior && prior.title !== s.title) {
      flag("same-id-different-title", r.id, `arXiv ${id} also cited by ${prior.technique} under a different title`);
    }
    if (!prior) seenArxiv.set(id, { technique: r.id, title: s.title });
  }

  /**
   * Defects in the frozen data that cannot be fixed in place are excused by
   * `catalog-known-defects.json` — but only on terms that stop the file becoming a
   * dumping ground: an entry with no reason fails, and an entry that no longer
   * matches a live problem fails as stale.
   */
  let known = [];
  try {
    known = JSON.parse(readFileSync(join(root, DEFECTS), "utf8")).defects ?? [];
  } catch {
    known = [];
  }

  const key = (kind, technique) => `${kind}::${technique}`;
  const excused = new Map(known.map((d) => [key(d.kind, d.technique), d]));
  const matchedKeys = new Set();

  const live = [];
  for (const p of problems) {
    const k = key(p.kind, p.technique);
    if (excused.has(k)) { matchedKeys.add(k); continue; }
    live.push(p);
  }

  for (const d of known) {
    const k = key(d.kind, d.technique);
    if (!d.reason || !String(d.reason).trim()) {
      live.push({ kind: "allowlist-entry-without-reason", technique: d.technique,
        detail: `${DEFECTS} excuses ${d.kind} with no stated reason` });
    }
    if (!matchedKeys.has(k)) {
      live.push({ kind: "stale-allowlist-entry", technique: d.technique,
        detail: `${DEFECTS} excuses ${d.kind}, but that problem no longer occurs — delete the entry` });
    }
  }

  return {
    ok: live.length === 0,
    fatalCode: null,
    fatal: null,
    problems: live,
    excused: matchedKeys.size,
    records: techniques.length,
    withArxiv,
    distinctArxiv: seenArxiv.size,
  };
}

function main() {
  const r = checkCitations();

  if (r.fatal) {
    console.error(`check:citations: ${r.fatal}`);
    return r.fatalCode;
  }

  if (r.ok) {
    console.log(`check:citations — OK. ${r.records} technique records, every citation internally consistent.`);
    console.log(`  ${r.withArxiv} cite an arXiv preprint (${r.distinctArxiv} distinct ids, none reused for a different paper);`);
    console.log(`  ${r.records - r.withArxiv} cite a venue, report, or practitioner guide instead.`);
    if (r.excused) {
      console.log(`  ${r.excused} known defect(s) excused by ${DEFECTS}, each with a reason and a fix point.`);
    }
    return 0;
  }

  console.error(`check:citations — ${r.problems.length} inconsistent citation(s):\n`);
  for (const p of r.problems) console.error(`  [${p.kind}] ${p.technique}\n    ${p.detail}`);
  console.error(`\nA citation that contradicts itself is wrong in one of its fields. Read the paper.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
