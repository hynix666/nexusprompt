/**
 * verify:sources — re-hash every frozen source file against sources/MANIFEST.json.
 *
 * The frozen sources are inputs, not working files. If one changes, ported code may
 * no longer correspond to the revision it claims to come from, so this exits non-zero
 * and names the offending file rather than warning.
 *
 * Pure filesystem + hashing; no network.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Exported for the suite: a fixture tree with one altered byte must make this fail.
 * The check had been proven only by hand, which is exactly the gap that let a
 * line-ending bug ship in a sibling checker.
 */
export function verifySources(root = DEFAULT_ROOT) {
  const manifestPath = path.join(root, "sources", "MANIFEST.json");

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, fatal: `manifest not found at ${path.relative(root, manifestPath)}`,
             checked: 0, tracked: 0, problems: [], archiveNotes: [] };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const problems = [];
  let checked = 0;

  for (const entry of manifest.files) {
    const abs = path.join(root, entry.extracted_to);
    if (!fs.existsSync(abs)) {
      problems.push({ kind: "missing", file: entry.extracted_to, expected: entry.sha256 });
      continue;
    }
    const actual = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    checked++;
    if (actual !== entry.sha256) {
      problems.push({ kind: "modified", file: entry.extracted_to, expected: entry.sha256, actual });
    }
  }

  // Archives are historical once frozen; report drift without failing on it, since
  // sources/ is the authority and an archive may legitimately be moved or removed.
  const archiveNotes = [];
  for (const a of manifest.archives ?? []) {
    const abs = a.original_path.replace(/^~/, process.env.USERPROFILE || process.env.HOME || "~");
    if (!fs.existsSync(abs)) archiveNotes.push(`${a.archive_id}: origin archive no longer at ${a.original_path}`);
  }

  return { ok: problems.length === 0, fatal: null, checked, tracked: manifest.files.length, problems, archiveNotes };
}

function main() {
  const { ok, fatal, checked, tracked, problems, archiveNotes } = verifySources();

  if (fatal) {
    console.error(`verify:sources — ${fatal}`);
    return 1;
  }

  if (ok) {
    console.log(`verify:sources — OK. ${checked} files match MANIFEST.json.`);
    for (const n of archiveNotes) console.log(`  note: ${n}`);
    return 0;
  }

  console.error(`verify:sources — FAILED. ${problems.length} problem(s) across ${tracked} tracked files.\n`);
  for (const p of problems) {
    if (p.kind === "missing") {
      console.error(`  MISSING   ${p.file}`);
      console.error(`            expected sha256 ${p.expected}`);
    } else {
      console.error(`  MODIFIED  ${p.file}`);
      console.error(`            expected ${p.expected}`);
      console.error(`            actual   ${p.actual}`);
    }
  }
  console.error(`\nFrozen sources are inputs, not working files. Restore from the origin archive,`);
  console.error(`or if the change is intentional, re-run the freeze and review the manifest diff.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
