/**
 * Pin the research corpus's inventory, and publish the one number every document
 * about it gets wrong.
 *
 * `Documentation/` cites the corpus as the warrant for its design decisions, and
 * four documents state a size no command reproduces: "673-paper corpus" three
 * times, "~700 papers" once. The tree holds 661 files, of which 62 are
 * byte-identical duplicates of another file — the same paper filed under two topic
 * directories. Deduplicated, that is 599 documents.
 *
 * `sources/` has had a hash manifest since day one. The corpus that motivates the
 * architecture had none, which made it the LESS verified of the two inputs.
 *
 * ── What this checks ─────────────────────────────────────────────────────────
 *
 * Every pinned file, re-read and re-hashed, plus a scan for unpinned PDFs. There is
 * one mode and it verifies contents.
 *
 * This was nearly shipped with a fast inventory-only default and a `--deep` flag,
 * on a measurement that said hashing the corpus cost eleven seconds. That number was
 * an artifact of the way it was measured — 661 `sha256sum` process spawns, not the
 * hashing. Read through one process, 2.08 GB re-hashes in **1.4 s**, so the whole
 * fast/deep split existed to excuse a weakness that was not there. A flag surface
 * whose only purpose is to narrow a guard's scope is worth deleting; this repository
 * has found six guards quietly narrower than their names, and declining to add a
 * seventh cost nothing.
 *
 * `unique_documents` is an UPPER BOUND on independent sources: content hashing
 * catches byte-identical duplicates, not the same paper under two filenames and not
 * a v1/v2 pair. Documents citing it must say "at most", and check:counts holds them
 * to the manifest's number rather than to a remembered one.
 *
 * Exit 0 inventory matches · 1 the corpus drifted · 2 the manifest cannot be read.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST = "scripts/corpus-manifest.json";
const CORPUS = "PDF";

/** Every *.pdf under the corpus root, as repo-relative POSIX paths, sorted. */
export function listCorpus(root = process.cwd()) {
  const base = join(root, CORPUS);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".pdf")) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(base);
  return out.sort();
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Build the manifest from the tree.
 *
 * Duplicates are RECORDED, never removed. `sources/` is frozen and corrected at the
 * import boundary rather than edited, and the same rule applies here: that a paper
 * was filed under two topics is evidence about how the corpus was assembled, and
 * deleting it would destroy the only record that the count was ever inflated.
 */
export function buildManifest(root = process.cwd()) {
  const paths = listCorpus(root);
  const entries = [];
  const byHash = new Map();

  for (const p of paths) {
    const full = join(root, p);
    const hash = sha256(full);
    const bytes = statSync(full).size;
    entries.push({ path: p, sha256: hash, bytes });
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(p);
  }

  const duplicates = [...byHash.entries()]
    .filter(([, ps]) => ps.length > 1)
    .map(([hash, ps]) => ({ sha256: hash, paths: ps }))
    .sort((a, b) => a.paths[0].localeCompare(b.paths[0]));

  return {
    _comment: [
      "Inventory pin for the research corpus under PDF/, which is .gitignore'd.",
      "",
      "unique_documents is an UPPER BOUND on independent sources: identical bytes are",
      "detected, the same paper under two filenames is not. Documents citing this number",
      "must say 'at most', and scripts/check-counts.mjs holds them to it.",
      "",
      "Regenerate with `node scripts/check-corpus.mjs --write` after deliberately adding",
      "to the corpus, and say in the commit message what was added and why.",
    ],
    generated_at: new Date().toISOString(),
    root: CORPUS,
    algorithm: "sha256",
    files: entries.length,
    unique_documents: byHash.size,
    duplicate_files: entries.length - byHash.size,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
    duplicates,
    entries,
  };
}

/**
 * Exported so the suite can point it at a fixture tree with a planted defect.
 * Returns rather than exits, so a caller can assert on the failures themselves.
 */
export function checkCorpus(root = process.cwd()) {
  // Both branches return the same keys. A fatal path that omits the success fields
  // makes the union have no properties in common, and every caller then needs a
  // narrowing check before reading anything — which is how check-plan does it too.
  const fail = (code, message) => ({
    ok: false, fatalCode: code, fatal: message, failures: [], manifest: null, checked: 0,
  });

  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) {
    return fail(2, `no ${MANIFEST}. Generate it with \`node scripts/check-corpus.mjs --write\`.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return fail(2, `${MANIFEST} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(manifest.entries)) {
    return fail(2, `${MANIFEST} has no entries array.`);
  }

  const pinned = new Map(manifest.entries.map((e) => [e.path, e]));
  const present = new Set(listCorpus(root));
  const failures = [];

  for (const [path, entry] of pinned) {
    if (!present.has(path)) {
      failures.push({ path, kind: "missing", detail: "pinned in the manifest, absent from the tree" });
      continue;
    }
    const bytes = statSync(join(root, path)).size;
    if (bytes !== entry.bytes) {
      failures.push({ path, kind: "resized", detail: `pinned ${entry.bytes} bytes, found ${bytes}` });
      continue;
    }
    const hash = sha256(join(root, path));
    if (hash !== entry.sha256) {
      failures.push({ path, kind: "modified", detail: `pinned ${entry.sha256.slice(0, 12)}…, found ${hash.slice(0, 12)}…` });
    }
  }

  for (const path of present) {
    if (!pinned.has(path)) {
      failures.push({ path, kind: "unpinned", detail: "present in the tree, absent from the manifest" });
    }
  }

  return { ok: failures.length === 0, fatalCode: null, fatal: null, failures, manifest, checked: pinned.size };
}

function main(argv) {
  if (argv.includes("--help")) {
    console.log(`check:corpus — pin the research corpus under ${CORPUS}/

  (no flags)  re-read and re-hash every pinned file, and refuse any unpinned PDF.
              ~1.4s against 2 GB. This is what verify runs.
  --write     regenerate ${MANIFEST} from the tree.`);
    return 0;
  }

  if (argv.includes("--write")) {
    const manifest = buildManifest();
    writeFileSync(join(process.cwd(), MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      `check:corpus — wrote ${MANIFEST}: ${manifest.files} files, ` +
        `${manifest.unique_documents} unique (${manifest.duplicate_files} duplicate), ` +
        `${(manifest.bytes / 1e9).toFixed(2)} GB.`,
    );
    return 0;
  }

  const { ok, fatal, fatalCode, failures, manifest, checked } = checkCorpus();

  if (fatal) {
    console.error(`check:corpus: ${fatal}`);
    return fatalCode;
  }

  if (ok) {
    console.log(
      `check:corpus — OK. ${checked} files re-hashed. ` +
        `${manifest.unique_documents} unique documents (at most; ${manifest.duplicate_files} duplicate files).`,
    );
    return 0;
  }

  console.error(`check:corpus — the corpus drifted from ${MANIFEST}. ${failures.length} difference(s):\n`);
  for (const f of failures.slice(0, 25)) {
    console.error(`  ${f.kind.padEnd(9)} ${f.path}`);
    console.error(`            ${f.detail}`);
  }
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more.`);
  console.error(
    "\nThe corpus is the evidence base for the catalog and for every design claim that\n" +
      "cites it. If the change was deliberate, regenerate with --write and say what changed.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
