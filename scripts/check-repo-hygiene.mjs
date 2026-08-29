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
 *   3. Nothing under a vendor directory is tracked, AT ANY DEPTH. `node_modules/` is the one
 *      that happened; the others are listed because the same commit would have taken them
 *      too. Depth matters here: a workspace has its own `node_modules`, and the first
 *      version of this rule matched only the repository root and missed one.
 *   4. No tracked file exceeds `MAX_TRACKED_BYTES`. The largest legitimate tracked file is
 *      0.81 MB (`core/src/catalog/techniques.json`), so the 4 MB bound has fivefold headroom
 *      and still catches a model shard, a PDF, or a bundled binary. This is the rule that
 *      fires when something large arrives under a name nobody pinned.
 *   5. Every tracked `.json` file parses. `2ba1b32` truncated `package-lock.json` and
 *      `shells/api/package.json` mid-file; the first made `npm ci` refuse outright, so CI
 *      could not install the project at all and every later failure was a symptom of that.
 *      It went unnoticed for a day because `npm ci` is the one command a local checkout
 *      never runs — `npm install` repairs quietly, which is precisely why the local tree
 *      looked healthy. `JSONC_ALLOWED` names the files that are deliberately not JSON.
 *
 * Rules 1 and 2 are deliberately redundant, and so are 3 and 4: a named rule catches a known
 * cost, a bound catches an unknown one. Rule 5 is the odd one out and belongs here anyway —
 * it is not about size or ignoring, it is the other way a commit can leave the repository
 * unbuildable while every local command still passes.
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

/**
 * Directory names that must never appear in the index, whatever `.gitignore` currently says.
 *
 * Matched at ANY depth, not as a leading prefix. The first version used `startsWith`, and a
 * tracked `shells/api/node_modules/.vite/…/results.json` walked straight past it while the
 * check printed "none vendored" — a workspace has its own `node_modules`, so the root-only
 * reading was wrong for exactly the layout this repository has. `.gitignore` gets this right
 * for free (`node_modules/` matches at any level) which is precisely why the index needs its
 * own rule: an ignore pattern does nothing about a path already tracked.
 *
 * Found by `npm ci` deleting the directory and git reporting the deletion of a file the check
 * had just called clean. Same shape as every other defect here — a matcher covering the case
 * its author had in mind and not its sibling.
 */
export const FORBIDDEN_TRACKED_DIRS = ["node_modules", "PDF", "LLM", ".venv", "venv"];

/** True when `dir` is any path segment of `path`, not merely its first. */
export const containsDir = (path, dir) => path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`);

/** Largest legitimate tracked file is 0.81 MB. Fivefold headroom, still catches a blob. */
export const MAX_TRACKED_BYTES = 4 * 1024 * 1024;

/** Files that carry comments on purpose and are read by tools that accept them. */
export const JSONC_ALLOWED = ["tsconfig.json"];

/**
 * Paths that must NEVER be ignored, whatever `.gitignore` says.
 *
 * Rules 1 and 2 check that the expensive things ARE ignored. Nothing checked the other
 * direction, and on 29 August 2026 a commit titled "configure AO workspace ignores" added
 * `/core/`, `/contracts/`, `/application/`, `/adapters/`, `/shells/`, `/scripts/`, `/test/`,
 * `/spec/`, `/sources/`, `/Documentation/` and `/.github/` to the ignore file — the entire
 * repository. `check:hygiene` reported OK, because every rule it had was about what should be
 * ignored and none about what must not be.
 *
 * The damage is quiet by construction: already-tracked files stay tracked, so `verify` passes,
 * the tests run, nothing is deleted. What breaks is the ability to ADD anything — every
 * `git add` of a new source file is refused, and a file that ever leaves the index becomes
 * invisible. It is the fourth `.gitignore` incident here and the first that inverts the file's
 * purpose rather than emptying it.
 *
 * This is the same lesson the gate work keeps producing: a matcher checked in one direction
 * only. `check:hygiene` was built after `.gitignore` was emptied three times, and it guarded
 * exactly the failure that had already happened.
 *
 * ## Rule 7, and why the list above was not enough
 *
 * `NEVER_IGNORED` is a hand-picked sentinel — one file per top-level tree. On 29 August 2026 a
 * fifth incident (#38) replaced the whole file with generic boilerplate, dropped `PDF/`, `LLM/`,
 * `.promptnexus/` and `.nexusprompt/`, and ADDED `build-hash.json`. Rule 1 caught the four
 * removals. Rule 6 walked past the addition, because `build-hash.json` is not a sentinel and
 * nobody had thought to make it one — the same sparse-sentinel failure, one layer up.
 *
 * Rule 7 asks the question rule 6 was approximating, without the guessing: is any file IN THE
 * INDEX ignored? That is derived from the repository rather than enumerated by hand, so it
 * cannot be sparse. It subsumes rule 6 for every path that is currently tracked; rule 6 is kept
 * because a sentinel still names what MUST exist, and a file deleted and then ignored would
 * leave rule 7 with nothing to find.
 *
 * It also found a defect nobody had reported. `promptnexus-v5/` was written as a loose-archive
 * rule and matches at ANY depth, so it also matched `sources/v5/promptnexus-v5/` — nine frozen,
 * SHA-256-pinned source files, ignored. Tracked, so `verify:sources` passed and nothing looked
 * wrong; but any one of them leaving the index would have become invisible, in the one directory
 * whose whole purpose is that its contents are pinned. The extraction rules are now anchored
 * with a leading `/`, which is what they always meant.
 */
export const NEVER_IGNORED = [
  "contracts/index.ts",
  "core/src/gates/registry.ts",
  "application/src/orchestrator.ts",
  "adapters/storage-local/src/index.ts",
  "shells/cli/src/index.ts",
  "scripts/check-repo-hygiene.mjs",
  "test/checkers.test.ts",
  "spec/manifest-shapes.json",
  "sources/MANIFEST.json",
  "Documentation/README.md",
  "project-knowledge/00-index.md",
  ".github/workflows/verify.yml",
  "package.json",
];

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

  for (const dir of FORBIDDEN_TRACKED_DIRS) {
    const hits = tracked.filter((p) => containsDir(p, dir));
    if (hits.length > 0) {
      failures.push(
        `${hits.length} tracked file(s) under a \`${dir}\` directory — e.g. ${hits[0]}. Untrack ` +
        `with \`git rm -r --cached\` on the path that names it. Note this does not shrink ` +
        `history; blobs already pushed stay in every clone.`,
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

  // Rule 6: the other direction. Nothing that the project is made of may be ignored.
  // Asked of git itself rather than by re-implementing pattern matching, because a
  // hand-rolled matcher would be a third opinion about what `.gitignore` means.
  const isIgnored = opts.isIgnored ?? ((p) => {
    try {
      // --no-index is load-bearing. Without it `check-ignore` reports a TRACKED path as
      // not-ignored even when a pattern matches it, so every path below came back clean while
      // the whole source tree was ignored. The question here is "would a NEW file here be
      // ignored?", which is exactly what --no-index answers.
      execFileSync("git", ["check-ignore", "-q", "--no-index", "--", p], { cwd: root, stdio: "ignore" });
      return true; // exit 0 means git ignores it
    } catch {
      return false; // exit 1 means it does not
    }
  });
  const ignoredButRequired = NEVER_IGNORED.filter((p) => isIgnored(p));
  if (ignoredButRequired.length > 0) {
    failures.push(
      `${ignoredButRequired.length} path(s) the project is MADE OF are ignored — e.g. ` +
      `${ignoredButRequired[0]}. Tracked files stay tracked, so the build still passes and ` +
      `nothing is deleted; what breaks is adding anything new. Check .gitignore for a rule ` +
      `that ignores a source directory.`,
    );
  }

  // Rule 7: rule 6, without the guessing. Every path in the index, asked at once.
  const listIgnored = opts.listIgnored ?? ((paths) => {
    if (paths.length === 0) return [];
    const run = () =>
      execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
        cwd: root,
        input: paths.join("\0") + "\0",
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    let out;
    try {
      out = run();
    } catch (err) {
      // Exit 1 means no path matched, which is the clean case and not a failure.
      if (err.status === 1) out = err.stdout ?? "";
      else throw err;
    }
    return out.split("\0").filter(Boolean);
  });

  const trackedAndIgnored = listIgnored(tracked);
  if (trackedAndIgnored.length > 0) {
    failures.push(
      `${trackedAndIgnored.length} TRACKED file(s) are also ignored — e.g. ` +
      `${trackedAndIgnored[0]}. A tracked file stays tracked whatever .gitignore says, so this ` +
      `costs nothing today and everything later: the file cannot be re-added if it ever leaves ` +
      `the index, and a fresh copy of it is invisible to \`git add\`. Anchor the rule to the ` +
      `repository root with a leading slash, or narrow it.`,
    );
  }

  for (const path of tracked.filter((p) => p.endsWith(".json"))) {
    if (JSONC_ALLOWED.includes(path)) continue;
    let raw;
    try {
      raw = readText(join(root, path));
    } catch {
      continue; // Tracked but absent: rule 3's problem, not this one.
    }
    try {
      JSON.parse(raw);
    } catch (err) {
      failures.push(
        `\`${path}\` is not valid JSON: ${err.message}. A malformed manifest or lockfile is ` +
        `invisible locally — \`npm ci\` is the one command a checkout never runs — and stops ` +
        `CI at install, where every later failure looks like something else.`,
      );
    }
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
