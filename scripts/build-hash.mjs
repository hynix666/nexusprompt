/**
 * The build hash: same source in, same hash out, on any machine.
 *
 * Phase 7's exit gate has three parts. Two were met — the capability matrix is generated, and
 * an orphaned contract or unproven claim fails the build. The third, *an independent build
 * produces an identical artifact hash*, had nothing behind it at all: there was no build hash.
 *
 * ## What it covers, and why not everything
 *
 * The RUNTIME artifact only: `contracts/`, `core/src/`, `application/src/`,
 * `adapters/*​/src/`, `shells/*​/src/`, plus `package.json` and `package-lock.json` because a
 * dependency version changes behaviour as surely as a source line does.
 *
 * Deliberately excluded: `test/`, `scripts/`, `spec/`, `Documentation/`. Those decide what is
 * CHECKED, not what runs. Folding them in would make the hash change whenever a comment moves
 * in a checker, which trains people to ignore a mismatch — and a hash nobody reads is worse
 * than none, because it looks like provenance.
 *
 * ## The trap this had to be designed around
 *
 * `core.autocrlf` is `true` here and `.gitattributes` pins only `sources/**` to LF. So a
 * Windows checkout and a Linux checkout of the SAME COMMIT hold different bytes for every
 * other file. Hashing raw bytes would have produced a hash that differs by platform — which
 * is not a reproducibility check, it is a platform check wearing one, and it would have failed
 * on its first CI run while passing locally.
 *
 * So content is normalised to LF before hashing. This is the third time line endings have been
 * the deciding detail in this repository: `check:catalog` was red on every Windows checkout
 * for 195 byte-identical records, and a fence regex was silently disabled on every CRLF file
 * because `\r` is a JavaScript line terminator.
 *
 * A BOM is stripped for the same reason — it is a checkout artifact, not content.
 *
 * ## What this claim is, and what it is not
 *
 * It establishes that two checkouts of one commit produce one hash. It does NOT establish that
 * the build is deterministic in any deeper sense: nothing is compiled, no bundle is produced,
 * and `tsx` transpiles at run time. Calling this "reproducible builds" would be borrowing
 * credibility from a much stronger claim — see the three claims kept separate in
 * `Documentation/TRUTH_BOUNDARY.md`.
 *
 *   node scripts/build-hash.mjs           print the hash
 *   node scripts/build-hash.mjs --write   write build-hash.json
 *   node scripts/build-hash.mjs --check   fail if the committed hash is not what the tree gives
 *
 * Exit 0 match · 1 mismatch or missing · 2 the tree cannot be read.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OUT = "build-hash.json";

/**
 * Path prefixes whose tracked files constitute the artifact. Prefix matching, not globs, so
 * the set is readable and a new adapter or shell is included without editing this list.
 */
export const ARTIFACT_PREFIXES = [
  "contracts/",
  "core/src/",
  "application/src/",
  "adapters/",
  "shells/",
];

/** Individually named files that change behaviour without living under a prefix above. */
export const ARTIFACT_FILES = ["package.json", "package-lock.json"];

/** Under the prefixes above, these are checked rather than shipped. */
export const EXCLUDED_SEGMENTS = ["/test/", "/node_modules/"];

export const isArtifactPath = (p) => {
  if (EXCLUDED_SEGMENTS.some((seg) => p.includes(seg))) return false;
  if (ARTIFACT_FILES.includes(p)) return true;
  if (!ARTIFACT_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  // `adapters/` and `shells/` are prefixes for whole workspaces; only their src counts.
  if (p.startsWith("adapters/") || p.startsWith("shells/")) return p.includes("/src/");
  return true;
};

/** LF, no BOM. See the header: bytes differ by platform, content does not. */
export const normalise = (text) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const gitTracked = (root) =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);

/**
 * Exported so the suite can point it at a fixture tree. `listTracked` is injectable for the
 * same reason it is in `check-repo-hygiene`: a fixture should not need to be a git repository.
 */
export function computeBuildHash(root = process.cwd(), opts = {}) {
  const listTracked = opts.listTracked ?? gitTracked;
  const readFile = opts.readFile ?? ((p) => readFileSync(join(root, p), "utf8"));

  const files = listTracked(root).filter(isArtifactPath).sort();
  // Sorted by path so the digest does not depend on directory-walk order, which differs by
  // filesystem. `git ls-files` is already sorted; sorting again makes that independent of it.
  const entries = files.map((p) => `${p} ${sha256(normalise(readFile(p)))}`);
  return { hash: sha256(entries.join("\n") + "\n"), files: files.length, entries };
}

export function checkBuildHash(root = process.cwd(), opts = {}) {
  let computed;
  try {
    computed = computeBuildHash(root, opts);
  } catch (err) {
    return { ok: false, fatalCode: 2, fatal: `cannot read the tree: ${err.message}` };
  }

  let committed;
  try {
    committed = JSON.parse(readFileSync(join(root, OUT), "utf8"));
  } catch {
    return {
      ok: false,
      fatalCode: 2,
      fatal: `${OUT} is missing or unreadable. Run \`npm run build:hash\` to write it.`,
    };
  }

  if (committed.hash === computed.hash) {
    return { ok: true, hash: computed.hash, files: computed.files };
  }
  return {
    ok: false,
    hash: computed.hash,
    committed: committed.hash,
    files: computed.files,
    committedFiles: committed.files,
  };
}

function main() {
  const root = process.cwd();
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");

  if (!check) {
    const { hash, files } = computeBuildHash(root);
    if (write) {
      writeFileSync(
        join(root, OUT),
        JSON.stringify(
          {
            _comment: [
              "The artifact hash: contracts, Core, Application, adapter and Shell sources,",
              "plus package.json and the lockfile. Content is normalised to LF before hashing",
              "because core.autocrlf is true here, so raw bytes differ by platform.",
              "",
              "This says two checkouts of one commit agree. It does NOT say the build is",
              "deterministic in a deeper sense: nothing is compiled and tsx transpiles at run",
              "time. See Documentation/TRUTH_BOUNDARY.md, which keeps the three",
              "reproducibility claims separate.",
            ],
            algorithm: "sha256 over sorted `path sha256(lf-normalised content)` lines",
            files,
            hash,
          },
          null,
          2,
        ) + "\n",
      );
      console.log(`build:hash — wrote ${OUT}. ${files} artifact file(s), hash ${hash.slice(0, 16)}…`);
      return 0;
    }
    console.log(`${hash}  (${files} artifact files)`);
    return 0;
  }

  const result = checkBuildHash(root);
  if (result.fatal) {
    console.error(`check:hash — ${result.fatal}`);
    return result.fatalCode;
  }
  if (!result.ok) {
    console.error(
      `check:hash — the artifact hash does not match ${OUT}.\n\n` +
      `  committed  ${result.committed}  (${result.committedFiles} files)\n` +
      `  computed   ${result.hash}  (${result.files} files)\n\n` +
      "  If you changed a runtime source, run `npm run build:hash` and commit the result.\n" +
      "  If you did NOT, this is the interesting case: the artifact changed without anyone\n" +
      "  editing it. Find out what before regenerating.",
    );
    return 1;
  }
  console.log(`check:hash — OK. ${result.files} artifact file(s), hash ${result.hash.slice(0, 16)}…`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
