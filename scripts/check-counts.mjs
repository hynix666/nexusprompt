/**
 * Re-derive every pinned NUMBER in the documentation from the repository.
 *
 * `check:plan` does this for one file. It reads `Documentation/IMPLEMENTATION_PLAN.md`,
 * verifies fifteen claims, and passes — while four counts in other documents are wrong,
 * including one that is load-bearing:
 *
 *   corpus size            673 / "~700"    →  599 unique documents
 *   catalog records        180 (×4 docs)   →  195
 *   records added            8             →  23
 *   judge routing partition 137 / 8 / 35   →  151 / 10 / 34
 *
 * The last is named in ADR-0008 as "the routing rule" deciding which cases may reach a
 * judge, so a stale partition is a stale rule and not a cosmetic count.
 *
 * The cause is one guard whose scope is narrower than its name — the seventh found in
 * this repository. Fixing four numbers by hand leaves the fifth to drift, so the fix is
 * a checker that reads every document.
 *
 * ── Why this is `check:counts` and not `check:claims` ────────────────────────────
 *
 * It verifies numeric claims that resolve to a command over the tree. It does not and
 * cannot verify prose claims. Naming it `check:claims` would promise the broader thing
 * and deliver the narrower one, which is precisely the defect class it exists to close.
 * The honest name is the narrow one.
 *
 * ── Two rules that keep the pin file from rotting ───────────────────────────────
 *
 *  - An entry whose pattern matches ZERO times FAILS AS STALE. Otherwise deleting a
 *    sentence silently retires its check, and the pin file fills with entries guarding
 *    prose nobody has written for months.
 *  - Every match of a pattern must agree. A number repeated three times in one document
 *    is three chances to be wrong, and `673-paper corpus` appears three times.
 *
 * Same discipline as `scripts/catalog-known-defects.json` and `divergence-allowlist.json`.
 *
 * Exit 0 every pinned count is true · 1 a count is false or an entry is stale ·
 *      2 the pin file or a resolver is broken.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PINS = "scripts/counted-claims.json";

/** Line endings are normalised before any regex runs — the working tree is CRLF. */
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * Every resolver computes one number from the tree. A pinned claim names one, so a
 * document's number and this repository's number come from different places and can
 * be compared — the same reason the differential oracle keeps a second implementation.
 */
export function resolvers(root = process.cwd()) {
  const at = (p) => join(root, p);

  const catalog = () => {
    const raw = readJson(at("core/src/catalog/techniques.json"));
    return Array.isArray(raw) ? raw : raw.techniques ?? raw.records ?? [];
  };
  const byStatus = (status) => catalog().filter((r) => r.verification_status === status).length;
  const frozenRecords = () => readJson(at("sources/catalog/data/prompt_technique_catalog.json")).techniques.length;
  const corpus = () => readJson(at("scripts/corpus-manifest.json"));

  return {
    "catalog.records": () => catalog().length,
    "catalog.frozen_records": frozenRecords,
    "catalog.records_added": () => catalog().length - frozenRecords(),
    "catalog.verifier_checkable": () => byStatus("verifier-checkable"),
    "catalog.judge_checkable": () => byStatus("judge-checkable"),
    "catalog.unverifiable_by_text": () => byStatus("unverifiable-by-text"),

    // Consumes the manifest check:corpus writes, which is why check:corpus runs first.
    "corpus.unique_documents": () => corpus().unique_documents,
    "corpus.files": () => corpus().files,
    "corpus.megabytes": () => Math.round(corpus().bytes / 1e6),

    "sources.frozen_files": () => readJson(at("sources/MANIFEST.json")).files.length,
    "docs.markdown_files": () => readdirSync(at("Documentation")).filter((f) => f.endsWith(".md")).length,
    "gates.ported": () => readJson(at("scripts/ported-gates.json")).ported.length,
    "stages.built": () =>
      readdirSync(at("core/src/stages")).filter((f) => f.endsWith(".ts") && !["pipeline.ts", "stage-kit.ts"].includes(f)).length,
  };
}

/**
 * Exported so the suite can point it at a fixture tree with a planted false claim.
 * Returns rather than exits, so a caller can assert on the failures themselves.
 */
export function checkCounts(root = process.cwd()) {
  // Same keys from both branches — see the note in check-corpus.mjs.
  const fail = (code, message) => ({
    ok: false, fatalCode: code, fatal: message, failures: [], checked: 0, pins: 0,
  });

  const pinPath = join(root, PINS);
  if (!existsSync(pinPath)) return fail(2, `no ${PINS}. Nothing is pinned, so nothing is checked.`);

  let pins;
  try {
    pins = readJson(pinPath).claims;
  } catch (err) {
    return fail(2, `${PINS} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(pins)) return fail(2, `${PINS} has no claims array.`);

  const resolve = resolvers(root);
  const failures = [];
  let checked = 0;

  for (const pin of pins) {
    const { document, pattern, resolver, reason } = pin;

    if (!reason) {
      return fail(2, `a pin for ${document} has no reason. An unexplained pin is a number nobody can re-decide.`);
    }
    if (!resolve[resolver]) {
      return fail(2, `unknown resolver "${resolver}" pinned for ${document}. Known: ${Object.keys(resolve).sort().join(", ")}`);
    }

    let text;
    try {
      text = readText(join(root, document));
    } catch {
      failures.push({ document, pattern, kind: "unreadable", detail: "pinned document does not exist" });
      continue;
    }

    let expected;
    try {
      expected = resolve[resolver]();
    } catch (err) {
      return fail(2, `resolver "${resolver}" threw: ${err.message}`);
    }

    const re = new RegExp(pattern, "g");
    const matches = [...text.matchAll(re)];

    // An entry that no longer matches is stale. It cannot outlive the prose it guards.
    if (matches.length === 0) {
      failures.push({
        document, pattern, kind: "stale",
        detail: `pattern matches nothing. The sentence it guarded is gone — delete the pin or restore the claim.`,
      });
      continue;
    }

    for (const m of matches) {
      if (m[1] === undefined) {
        return fail(2, `pattern for ${document} has no capture group: /${pattern}/`);
      }
      // Strip every non-digit, not just commas. A pattern like /`judge-checkable` ([\d,]+)/
      // captures "8," from "8, unverifiable" — harmless to Number(), but it renders the
      // failure message as `says 8,,` and a checker whose own output looks broken gets
      // ignored. Thousands separators survive this too: "3,400" reads as 3400.
      const digits = m[1].replace(/\D/g, "");
      if (digits === "") {
        return fail(2, `pattern for ${document} captured no digits: /${pattern}/`);
      }
      const found = Number(digits);
      checked += 1;
      if (found !== expected) {
        const at = text.slice(0, m.index).split("\n").length;
        failures.push({
          document, pattern, kind: "false", line: at, expected, found, resolver, reason,
          detail: `${document}:${at} says ${digits}, the repository says ${expected}`,
        });
      }
    }
  }

  return { ok: failures.length === 0, fatalCode: null, fatal: null, failures, checked, pins: pins.length };
}

function main() {
  const { ok, fatal, fatalCode, failures, checked, pins } = checkCounts();

  if (fatal) {
    console.error(`check:counts: ${fatal}`);
    return fatalCode;
  }

  if (ok) {
    console.log(`check:counts — OK. ${checked} occurrence(s) of ${pins} pinned count(s) re-derived from the repo.`);
    return 0;
  }

  console.error(`check:counts — ${failures.length} problem(s):\n`);
  for (const f of failures) {
    if (f.kind === "false") {
      console.error(`  ${f.detail}`);
      console.error(`    resolver: ${f.resolver}`);
      console.error(`    why pinned: ${f.reason}\n`);
    } else {
      console.error(`  ${f.kind.toUpperCase()} ${f.document}`);
      console.error(`    /${f.pattern}/`);
      console.error(`    ${f.detail}\n`);
    }
  }
  console.error(
    "A number in prose is a claim about this repository. Fix whichever one is wrong —\n" +
      "and if a document was right and the code drifted, that is the more interesting case.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
