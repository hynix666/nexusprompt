/**
 * The repository's own hygiene: what must stay ignored, and what must never be tracked.
 *
 * ## Why this exists
 *
 * `.gitignore` has been emptied three times by automated commits — `7ede11a`, `83890f1`
 * (repaired by `bf1fd4d`), and `8ee5d0a`. The third one truncated it to zero bytes and
 * committed **3,677 node_modules files in the same commit**, which is how `.git` reached
 * 2.3 GB. At the moment it was found, `PDF/` (2.0 GB of third-party papers) and `LLM/`
 * (815 MB of model weights) were tracked by nothing and ignored by nothing: one `git add -A`
 * away from entering history permanently, because git keeps blobs forever and a later commit
 * removing a file does not shrink a single future clone.
 *
 * Every other checker here verifies the CONTENT of the repository. None verified its SHAPE,
 * so the same failure landed three times and was found three times by hand. That is the gap.
 *
 * ## What it checks, and why each rule earns its place
 *
 *   1. `.gitignore` still carries the rules whose absence is expensive. Pinned individually
 *      because these are the ones that cost gigabytes or correctness, not because the file
 *      is frozen — rules may be added freely.
 *   2. `.gitignore` still has at least `MIN_RULES` rules at all. The pinned set above cannot
 *      catch wholesale truncation of the rules it does NOT name, and truncation is the exact
 *      shape of all three incidents. This is the guard against the next one being a rule
 *      nobody thought to pin.
 *   3. Nothing under a vendor directory is tracked. `node_modules/` is the one that happened;
 *      the others are listed because the same commit would have taken them too.
 *   4. No tracked file exceeds `MAX_TRACKED_BYTES`. The largest legitimate tracked file is
 *      0.81 MB (`core/src/catalog/techniques.json`), so the 4 MB bound has fivefold headroom
 *      and still catches a model shard, a PDF, or a bundled binary. This is the rule that
 *      fires when something large arrives under a name nobody pinned.
 *
 * Rules 1 and 2 are deliberately redundant, and rules 3 and 4 are too. Each pair covers the
 * other's blind spot: a named rule catches a known cost, a bound catches an unknown one.
 *
 * ## What it does NOT do
 *
 * It does not remove anything already in history. `node_modules` was untracked with
 * `git rm -r --cached`, which stops the bleeding going forward; the 2.3 GB of existing blobs
 * are already on `origin` and clearing them means rewriting published history, which is the
 * repository owner's decision and not a checker's.
 *
 *   node scripts/check-repo-hygiene.mjs
 *
 * Exit 0 clean · 1 a hygiene rule is broken · 2 the repository cannot be inspected.
 */

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Rules that must be present. Matched against the rule lines verbatim, so a rule rewritten
 * into an equivalent form fails and has to be re-pinned deliberately — the point is that
 * removing one of these is a decision somebody makes on purpose, not a diff nobody reads.
 */
export const REQUIRED_IGNORES = [
  "node_modules/",
  "PDF/",
  "LLM/",
  ".promptnexus/",
  ".nexusprompt/",
  "dist/",
  "*.zip",
];

/** Below this, the file has been truncated rather than edited. It carried 23 when pinned. */
export const MIN_RULES = 20;

/** Prefixes that must never appear in the index, whatever `.gitignore` currently says. */
export const FORBIDDEN_TRACKED_PREFIXES = ["node_modules/", "PDF/", "LLM/", ".venv/", "venv/"];

/** Largest legitimate tracked file is 0.81 MB. Fivefold headroom, still catches a blob. */
export const MAX_TRACKED_BYTES = 4 * 1024 * 1024;

const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Rule lines only: comments and blanks carry no behaviour. */
export const ignoreRules = (text) =>
  text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

/** Tracked paths, from git. Injectable so the suite can plant an index without a repository. */
const gitTracked = (root) =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);

/**
 * Exported so the suite can point it at a fixture tree with a planted defect, and returns
 * rather than exits so a caller can assert on the failures themselves and not merely on an
 * exit code. `listTracked` is injectable; `sizeOf` is too, so a size case does not need a
 * four-megabyte fixture on disk.
 */
export function checkRepoHygiene(root = process.cwd(), opts = {}) {
  const listTracked = opts.listTracked ?? gitTracked;
  const sizeOf = opts.sizeOf ?? ((p) => {
    try {
      return statSync(join(root, p)).size;
    } catch {
      return 0; // Tracked but absent from the working tree: a different problem, not this one.
    }
  });

  const failures = [];

  let rules;
  try {
    rules = ignoreRules(readText(join(root, ".gitignore")));
  } catch {
    return {
      ok: false,
      fatalCode: 2,
      fatal: ".gitignore is missing entirely. It has been emptied three times by automated commits; restore it from the last good revision rather than writing a new one.",
      failures: [],
    };
  }

  for (const rule of REQUIRED_IGNORES) {
    if (!rules.includes(rule)) {
      failures.push(
        `.gitignore no longer carries \`${rule}\`. This rule is pinned because its absence is ` +
        `expensive — removing it is a decision, not a cleanup.`,
      );
    }
  }

  if (rules.length < MIN_RULES) {
    failures.push(
      `.gitignore holds ${rules.length} rule(s), below the floor of ${MIN_RULES}. That is the ` +
      `shape of all three previous incidents: the file was truncated, not edited. Restore it ` +
      `from the last good revision.`,
    );
  }

  let tracked;
  try {
    tracked = listTracked(root);
  } catch (err) {
    return {
      ok: false,
      fatalCode: 2,
      fatal: `cannot list tracked files: ${err.message}`,
      failures: [],
    };
  }

  for (const prefix of FORBIDDEN_TRACKED_PREFIXES) {
    const hits = tracked.filter((p) => p.startsWith(prefix));
    if (hits.length > 0) {
      failures.push(
        `${hits.length} tracked file(s) under \`${prefix}\` — e.g. ${hits[0]}. Untrack with ` +
        `\`git rm -r --cached ${prefix.replace(/\/$/, "")}\`. Note this does not shrink history; ` +
        `blobs already pushed stay in every clone.`,
      );
    }
  }

  const oversized = tracked
    .map((p) => [p, sizeOf(p)])
    .filter(([, bytes]) => bytes > MAX_TRACKED_BYTES)
    .sort((a, b) => b[1] - a[1]);

  for (const [path, bytes] of oversized) {
    failures.push(
      `\`${path}\` is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_TRACKED_BYTES / 1048576} MB ` +
      `bound. Large files are permanent: git keeps the blob whether or not a later commit ` +
      `removes it. If this one belongs here, raise the bound deliberately and say why.`,
    );
  }

  return { ok: failures.length === 0, failures, trackedCount: tracked.length, ruleCount: rules.length };
}

function main() {
  const result = checkRepoHygiene();

  if (result.fatal) {
    console.error(`check:hygiene — ${result.fatal}`);
    return result.fatalCode ?? 2;
  }
  if (!result.ok) {
    console.error(`check:hygiene — ${result.failures.length} problem(s):\n`);
    for (const f of result.failures) console.error(`  ${f}\n`);
    console.error(
      "  Every other check here verifies what the repository SAYS. This one verifies what it\n" +
      "  CONTAINS, because three automated commits emptied .gitignore and one of them tracked\n" +
      "  3,677 dependency files in the same change.",
    );
    return 1;
  }

  console.log(
    `check:hygiene — OK. ${result.ruleCount} ignore rule(s), ${result.trackedCount} tracked file(s), ` +
    `none vendored, none over ${MAX_TRACKED_BYTES / 1048576} MB.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
