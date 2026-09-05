/**
 * Detect merged pull requests whose content never reached `master`.
 *
 * **Deliberately not part of `npm run verify`.** That command is offline by design —
 * a build that needs the network is a build that fails for reasons unrelated to the
 * code. This check reads the GitHub API and the git object store. Its command is
 * `npm run check:merge-integrity`.
 *
 * ## Why two stages
 *
 * This repository squash-merges. A squash produces a new commit, so a merged PR's
 * `merge_commit_sha` is routinely not an ancestor of `master` even when its content
 * landed perfectly. Stage 1 (ancestor check) is fast and catches the normal case;
 * stage 2 (git cherry patch equivalence against refs/pull/N/head) separates a
 * landed-via-squash PR from a genuinely stranded one. See the design spec:
 * docs/superpowers/specs/2026-09-04-merge-integrity-check-design.md
 *
 * ## Exit codes
 *
 * Exit 0 whenever the check ran, whatever it found.
 * Exit 2 when it could not run (no token, shallow clone, API error).
 * Never exit 1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const LEDGER_PATH = "scripts/merge-integrity-ledger.json";

function defaultGitRunner(args, cwd) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trimEnd() };
}

async function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const tok = (r.stdout ?? "").trim();
  return tok || null;
}

function parseRemote(git) {
  const r = git(["remote", "get-url", "origin"]);
  if (r.status !== 0) return null;
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function fetchAllMergedPRs(repo, token, fetchImpl) {
  const prs = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=closed&per_page=100&page=${page}`;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (err) {
      return { error: `network error — ${err.message}`, data: null };
    }
    if (res.status === 403) return { error: "rate limited or forbidden (HTTP 403)", data: null };
    if (res.status === 401) return { error: "unauthorized (HTTP 401) — token invalid or expired", data: null };
    if (!res.ok) return { error: `GitHub API returned HTTP ${res.status}`, data: null };
    const batch = await res.json();
    for (const pr of batch) {
      if (pr.merged_at) prs.push(pr);
    }
    if (batch.length < 100) break;
    page++;
  }
  return { error: null, data: prs };
}

function fatalResult(msg) {
  return {
    ok: false, fatalCode: 2, fatal: msg,
    checked: 0, silent: 0, findings: [], explained: [], stale_ledger: [], unclassified: [],
  };
}

export async function checkMergeIntegrity({
  root = process.cwd(),
  fetchImpl = globalThis.fetch,
  git = (args) => defaultGitRunner(args, root),
  token,
} = {}) {
  if (!token) return fatalResult("no auth token — set GITHUB_TOKEN or run `gh auth login`");

  // Shallow clone detection. A shallow clone causes every ancestor test to fail,
  // producing false findings. Testing for a parent commit would not do: a legitimate
  // root commit has no parent either.
  const shallowCheck = git(["rev-parse", "--is-shallow-repository"]);
  if (shallowCheck.stdout.trim() === "true") {
    return fatalResult("shallow clone — run git fetch --unshallow or set fetch-depth: 0 in CI");
  }

  const repo = parseRemote(git);
  if (!repo) return fatalResult("cannot determine GitHub repo from `git remote get-url origin`");

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(join(root, LEDGER_PATH), "utf8"));
  } catch (err) {
    return fatalResult(`cannot read ${LEDGER_PATH} — ${err.message}`);
  }
  const ledgerByPr = new Map(ledger.entries.map((e) => [e.pr, e]));

  const { error, data: prs } = await fetchAllMergedPRs(repo, token, fetchImpl);
  if (error) return fatalResult(error);

  const silentPrs = [];
  const findings = [];
  const explained = [];
  const stale_ledger = [];
  const unclassified = [];

  for (const pr of prs) {
    const sha = pr.merge_commit_sha;
    if (!sha) {
      unclassified.push({ pr: pr.number, title: pr.title, reason: "no merge_commit_sha" });
      continue;
    }

    // Stage 1: is merge_commit_sha an ancestor of origin/master?
    // Exit 0 = ancestor. Exit 1 = not ancestor. Any other non-zero = error treated as not-ancestor.
    const ancestorResult = git(["merge-base", "--is-ancestor", sha, "origin/master"]);
    if (ancestorResult.status === 0) {
      if (ledgerByPr.has(pr.number)) {
        stale_ledger.push({ pr: pr.number, title: pr.title, merge_commit: sha, ledger_entry: ledgerByPr.get(pr.number) });
      } else {
        silentPrs.push(pr.number);
      }
      continue;
    }

    // Stage 2: fetch refs/pull/N/head and check patch equivalence via git cherry.
    // GitHub retains refs/pull/N/head after branch deletion.
    const localRef = `refs/merge_check/${pr.number}`;
    const fetchResult = git(["fetch", "origin", `refs/pull/${pr.number}/head:${localRef}`]);
    if (fetchResult.status !== 0) {
      // GC'd or deleted fork — fail toward saying something, never toward silence.
      unclassified.push({ pr: pr.number, title: pr.title, base: pr.base?.ref, merge_commit: sha, reason: "head ref unfetchable" });
      continue;
    }

    const cherryResult = git(["cherry", "origin/master", localRef]);
    const cherryLines = cherryResult.stdout.split("\n").filter(Boolean);
    const plusLines = cherryLines.filter((l) => l.startsWith("+"));

    if (plusLines.length === 0) {
      // All patches present upstream — landed via squash or rebase through the base branch.
      if (ledgerByPr.has(pr.number)) {
        stale_ledger.push({ pr: pr.number, title: pr.title, merge_commit: sha, ledger_entry: ledgerByPr.get(pr.number) });
      } else {
        silentPrs.push(pr.number);
      }
      continue;
    }

    // One or more patches absent from master. Check ledger before reporting.
    const absent_commits = plusLines.map((l) => l.slice(2).trim());
    if (ledgerByPr.has(pr.number)) {
      explained.push({ pr: pr.number, title: pr.title, base: pr.base?.ref, merge_commit: sha, reason: ledgerByPr.get(pr.number).reason });
    } else {
      findings.push({ pr: pr.number, title: pr.title, base: pr.base?.ref, merge_commit: sha, absent_commits });
    }
  }

  return {
    ok: true, fatalCode: null, fatal: null,
    checked: prs.length,
    silent: silentPrs.length,
    findings,
    explained,
    stale_ledger,
    unclassified,
  };
}

async function main() {
  const token = await resolveToken();
  const r = await checkMergeIntegrity({ token });

  if (r.fatal) {
    console.error(`check:merge-integrity: ${r.fatal}`);
    return r.fatalCode;
  }

  console.log(`check:merge-integrity — ${r.checked} merged PRs checked.`);
  console.log(`  ${r.silent} silent · ${r.findings.length} finding(s) · ${r.explained.length} explained · ${r.unclassified.length} unclassified`);

  if (r.stale_ledger.length) {
    console.log(`\nStale ledger entries (PR now reaches master — consider removing from ${LEDGER_PATH}):`);
    for (const e of r.stale_ledger) console.log(`  PR #${e.pr}: ${e.title}`);
  }

  if (r.unclassified.length) {
    console.log(`\nUnclassified (head ref unfetchable — fork deleted?):`);
    for (const u of r.unclassified) console.log(`  PR #${u.pr}: ${u.title ?? "(no title)"}`);
  }

  if (r.findings.length) {
    console.error(`\nFindings — content absent from master:`);
    for (const f of r.findings) {
      console.error(`  PR #${f.pr}: ${f.title}`);
      console.error(`    base: ${f.base}  merge_commit: ${f.merge_commit}`);
      for (const c of f.absent_commits) console.error(`    + ${c}`);
    }
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
