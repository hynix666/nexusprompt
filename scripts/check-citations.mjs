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
const IMPORTED = "core/src/catalog/techniques.json";
const ADDITIONS = "scripts/catalog-additions.json";
const DEFECTS = "scripts/catalog-known-defects.json";
const ARXIV = /^\d{4}\.\d{4,5}$/;

/**
 * Records added at import were never reached by this check.
 *
 * It read the frozen catalog and only the frozen catalog, so it audited 172 records
 * while the shipped artifact carried 195. The twenty-three added ones — the newly
 * authored records, whose citations were typed by hand and are therefore the ones most
 * able to be wrong — were the exact set nothing verified. A checker whose name says
 * "citations" and whose scope is "some citations" is the failure this repository has
 * now found in four separate guards.
 *
 * Added records are audited with **no excusals**. `catalog-known-defects.json` exists
 * because frozen data cannot be edited in place; a record written this week has no such
 * excuse, and grandfathering one would make the allowlist a place to put mistakes.
 */
const readTechniques = (path) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? raw : (raw.techniques ?? raw.records ?? null);
};

/**
 * `now` is injectable so a test can pin it. An arXiv id dated after today is an error,
 * which makes this check legitimately time-dependent — but a hardcoded "today" goes
 * stale, and a test that silently starts passing for the wrong reason is exactly what
 * this repository keeps finding.
 */
export function checkCitations(root = process.cwd(), now = new Date(), opts = {}) {
  const source = opts.catalog ?? CATALOG;
  const only = opts.only ?? null;          // Set of ids to restrict to, or null for all
  const useExcusals = opts.excusals ?? true;

  let techniques;
  try {
    techniques = readTechniques(join(root, source));
  } catch (err) {
    return { ok: false, fatalCode: 2, fatal: `cannot read ${source} — ${err.message}`, problems: [] };
  }
  if (!Array.isArray(techniques)) {
    return { ok: false, fatalCode: 2, fatal: `${source} has no techniques array`, problems: [] };
  }
  if (only) techniques = techniques.filter((r) => only.has(r.id));

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
  if (useExcusals) {
    try {
      known = JSON.parse(readFileSync(join(root, DEFECTS), "utf8")).defects ?? [];
    } catch {
      known = [];
    }
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

/** Ids introduced at import. Empty is legitimate — it means nothing was added. */
function addedIds(root = process.cwd()) {
  try {
    return new Set((JSON.parse(readFileSync(join(root, ADDITIONS), "utf8")).records ?? []).map((r) => r.id));
  } catch {
    return new Set();
  }
}

function report(label, r) {
  console.error(`check:citations — ${r.problems.length} inconsistent citation(s) in ${label}:\n`);
  for (const p of r.problems) console.error(`  [${p.kind}] ${p.technique}\n    ${p.detail}`);
  console.error(`\nA citation that contradicts itself is wrong in one of its fields. Read the paper.`);
}

function main() {
  const frozen = checkCitations();
  if (frozen.fatal) {
    console.error(`check:citations: ${frozen.fatal}`);
    return frozen.fatalCode;
  }
  if (!frozen.ok) {
    report("the frozen catalog", frozen);
    return 1;
  }

  // Second pass: the records added at import, which the frozen catalog does not contain
  // and which this check did not reach until 2026-08-18. No excusals — see the note above.
  const added = addedIds();
  const imported = added.size
    ? checkCitations(process.cwd(), new Date(), { catalog: IMPORTED, only: added, excusals: false })
    : null;

  if (imported?.fatal) {
    console.error(`check:citations: ${imported.fatal}`);
    return imported.fatalCode;
  }
  if (imported && !imported.ok) {
    report(`the ${added.size} records added at import`, imported);
    console.error(`These were authored, not inherited. ${DEFECTS} does not apply to them.`);
    return 1;
  }

  const total = frozen.records + (imported?.records ?? 0);
  console.log(`check:citations — OK. ${total} technique records, every citation internally consistent.`);
  console.log(`  ${frozen.records} frozen + ${imported?.records ?? 0} added at import, both audited;`);
  console.log(`  ${frozen.withArxiv + (imported?.withArxiv ?? 0)} cite an arXiv preprint;`);
  console.log(`  ${total - frozen.withArxiv - (imported?.withArxiv ?? 0)} cite a venue, report, or practitioner guide instead.`);
  if (frozen.excused) {
    console.log(`  ${frozen.excused} known defect(s) excused by ${DEFECTS}, frozen records only.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
