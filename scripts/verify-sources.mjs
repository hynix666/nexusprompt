#!/usr/bin/env node
/**
 * verify:sources — re-hash every frozen source file against sources/MANIFEST.json.
 *
 * The frozen sources are inputs, not working files. If one changes, ported code may
 * no longer correspond to the revision it claims to come from, so this exits non-zero
 * and names the offending file rather than warning.
 *
 * Runs before Core tests in CI. Pure filesystem + hashing; no network.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "sources", "MANIFEST.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`verify:sources — manifest not found at ${path.relative(root, manifestPath)}`);
  process.exit(1);
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
for (const a of manifest.archives) {
  const abs = a.original_path.replace(/^~/, process.env.USERPROFILE || process.env.HOME || "~");
  if (!fs.existsSync(abs)) archiveNotes.push(`${a.archive_id}: origin archive no longer at ${a.original_path}`);
}

if (problems.length === 0) {
  console.log(`verify:sources — OK. ${checked} files match MANIFEST.json.`);
  for (const n of archiveNotes) console.log(`  note: ${n}`);
  process.exit(0);
}

console.error(`verify:sources — FAILED. ${problems.length} problem(s) across ${manifest.files.length} tracked files.\n`);
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
process.exit(1);
