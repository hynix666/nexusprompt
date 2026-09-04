# Merge integrity check — design

**Status:** Design approved 4 September 2026. Not yet built.
**Depends on:** nothing in the tree. The check reads the GitHub API and the git object store; it adds no dependency to `core/`, `application/`, or any adapter.
**Precedent:** `scripts/check-citations-online.mjs` — the repository's existing network-requiring checker, deliberately outside `npm run verify`.

## Goal

A merged pull request whose content never reached `master` is currently invisible. Nothing in the repository detects it, and the PR list reports it as merged.

This is not hypothetical. On 2 September 2026:

```
PR #92  base: master                      merged 15:46:05Z   -> 89452f0a
PR #93  base: fix-doc-counts-after-91      merged 15:46:44Z   -> 36190d2
```

`#93` was stacked on `fix-doc-counts-after-91`. That branch's own PR (`#92`) merged into `master` **39 seconds earlier**, so when `#93` landed, its base was already spent. The merge succeeded, GitHub reports `#93` as MERGED, and its single file —
`docs/superpowers/plans/2026-09-02-brief-generator-pilot.md`, 1,548 lines, reviewed — is absent from `master` and has never been on it.

It was found by a manual branch-level audit on 4 September 2026, two days later, and only because someone went looking at branch level for an unrelated reason.

The goal is a check that would have surfaced this the next day.

## Scope

**In:**

- `scripts/check-merge-integrity.mjs` — the checker.
- `scripts/merge-integrity-ledger.json` — triaged cases, with reasons.
- `npm run check:merge-integrity` — the local caller.
- `.github/workflows/merge-integrity.yml` — the nightly caller, which opens or updates a single tracking issue.
- Tests in `test/`, offline, with injected dependencies.

**Out:**

- Any change to `npm run verify`. That command is offline by design; a build that needs the network is a build that fails for reasons unrelated to the code. This check can never join it.
- Branches with no pull request. `feature/phase1-hardening-2026` (6 commits, no PR) is real unlanded work, but "a branch nobody proposed" is a decision to make, not a defect to monitor. The one-off findings from the 4 September branch sweep are recorded in this document's appendix rather than becoming a permanent detector.
- Failing the build on a finding. See Verdict model.
- Preventing the failure. This detects a stranded merge after the fact; it does not stop a PR being retargeted onto a spent base. Branch protection does not offer that control, and a pre-merge check would need to run on the base branch's state at merge time.

## The invariant

**Every merged pull request's content is present in `master`.**

### Why reachability alone cannot decide it

This repository squash-merges. A squash produces a new commit, so a merged PR's `merge_commit_sha` is routinely *not* an ancestor of `master` even when its content landed perfectly.

Measured across all 112 merged PRs on 4 September 2026, three had unreachable merge commits:

| PR | base | merge commit | content in master? |
|---|---|---|---|
| #73 | `restore-master-green` | `9c325096` | **yes** — landed via the base's own PR #72 |
| #93 | `fix-doc-counts-after-91` | `36190d2` | **no** — stranded |
| #48 | `master` | `c5ad91d2` | no — deliberately reverted |

A checker that reported all three would be wrong about two of them, and a checker that is wrong two times in three gets switched off.

### The two-stage test

1. **Reachability.** Is `merge_commit_sha` an ancestor of `origin/master`? Almost every PR passes here and stops. Cheap, no fetching.
2. **Patch equivalence.** For survivors, fetch `refs/pull/<n>/head` — GitHub retains it after branch deletion — and run `git cherry origin/master <head>`. Every commit marked `-` has an equivalent patch upstream: landed by squash or rebase. Any commit marked `+` is genuinely absent.

Stage 2 is what separates #73 from #93. Both fail stage 1; only #93 produces `+`.

### What the test cannot decide

Stage 2 cannot distinguish #93 from #48. A deliberate revert and an accidental strand are identical at both stages — content merged, content now absent. That distinction is human judgement, which is why the ledger records a **reason** and not merely a PR number.

One further limit, stated rather than solved: a PR whose content landed and was *later legitimately deleted* also reads as `+`. Expected to be rare; triaged into the ledger when it occurs.

## Verdict model

**Exit 0 whenever the check ran, whatever it found. Exit 2 when it could not run. Never exit 1.**

A finding never fails the build. A check that *could not look* — no token, rate limited, API unreachable, git objects missing — is not a clean repository, and reporting one would be the failure this codebase names repeatedly: a guard that passes when it learns nothing is not a guard.

The consequence is deliberate: the nightly job can go red, but only for "I could not look," never for "I looked and found a loss."

## Architecture

### `scripts/check-merge-integrity.mjs`

Exports a testable function with injected dependencies, with a thin CLI wrapper at the bottom — the structure `check-citations-online.mjs` uses so a network checker can be tested without a network.

```js
export async function checkMergeIntegrity({
  root = process.cwd(),
  fetchImpl = fetch,
  git = defaultGitRunner,   // (args: string[]) => { status, stdout }
  token,                     // resolved by the caller, never read from disk here
}) { /* returns a Report */ }
```

The report shape:

```js
{
  checked: 112,            // merged PRs examined
  silent: 110,             // 109 passed stage 1; #73 cleared stage 2
  findings: [              // stage 2 produced '+', and no ledger entry covers it
    { pr: 93, title, base, merge_commit, absent_commits: [...], files: [...] }
  ],
  explained: [             // stage 2 produced '+', ledger covers it
    { pr: 48, reason: "..." }
  ],
  stale_ledger: [],        // ledger entries whose PR now reaches master
  unclassified: [],        // head ref unfetchable; never reported as landed
}
```

### `scripts/merge-integrity-ledger.json`

Mirrors `divergence-allowlist.json`: a declared exception carries its reason inline, so the file explains itself to the next reader.

```json
{
  "_comment": [
    "Merged PRs whose content is deliberately absent from master.",
    "An entry is a claim that a human looked and decided. It carries the reason,",
    "not just the number, because a revert and a stranded merge look identical to",
    "the checker. Advisory: nothing here fails a build."
  ],
  "entries": [
    {
      "pr": 48,
      "title": "Update from task 37766777-0ccd-4b42-b4c6-03f48fd31185",
      "verdict": "deliberate",
      "reason": "Tracked node_modules/ and emptied .gitignore — the sixth gitignore incident. Reverted on purpose; check:hygiene now pins the repository's shape so it cannot recur silently.",
      "evidence": "merge_commit c5ad91d2; .gitignore and every node_modules/ path absent from master by design"
    }
  ]
}
```

`#73` needs no entry: stage 2 resolves it automatically.

### `package.json`

```json
"check:merge-integrity": "node scripts/check-merge-integrity.mjs"
```

Placed beside `check:citations:online` and `check:corpus`, outside `verify`.

### `.github/workflows/merge-integrity.yml`

```yaml
on:
  schedule: [{ cron: "17 6 * * *" }]
  workflow_dispatch:
permissions:
  contents: read
  issues: write
```

The checkout **must** set `fetch-depth: 0`. `actions/checkout` defaults to depth 1; with a shallow clone every ancestor test fails and the report would claim 112 losses. Third-party actions are pinned to a commit SHA, as the existing `verify.yml` does and explains.

The job runs the script, writes the report into `$GITHUB_STEP_SUMMARY`, and manages the issue.

## Data flow

```
merged PRs (REST) ─┐
origin/master ─────┼─> stage 1: ancestor? ──(yes)──> silent
refs/pull/N/head ──┘        │(no)
                            v
                     stage 2: git cherry ──(all -)──> silent
                            │(any +)
                            v
                     subtract ledger ──> findings
                            │
              ┌─────────────┼─────────────┐
           stdout     job summary    issue (CI only)
```

## Authentication — one code path

The script always uses the REST API and resolves its token as: `GITHUB_TOKEN` if set, otherwise the output of `gh auth token`. CI supplies the former, a developer's machine the latter, and the code path is identical in both. Shelling to `gh` for the whole query locally while using REST in CI would be two implementations of one rule, which this repository has already paid for once when the retry policy existed twice.

## Issue behaviour

A **single** tracking issue, identified by an HTML-comment marker in its body:

```
<!-- merge-integrity -->
```

Identified by marker rather than by title, so a human renaming the issue does not cause the next run to open a duplicate.

- New findings, no open marked issue → create one.
- New findings, open marked issue → rewrite its body.
- No findings, open marked issue → close it.
- No findings, no issue → do nothing, and print nothing beyond a one-line summary.

The issue is a live mirror of current state, not an append-only pile. Silence is the normal state, which is what makes output signal.

## Error handling

| Condition | Behaviour |
|---|---|
| Shallow clone | Cannot occur in CI (`fetch-depth: 0` is pinned). Detected locally with `git rev-parse --is-shallow-repository`; exit 2 with the reason. Testing for a parent commit would not do: a shallow clone's tip has no parent, but neither does a legitimate root commit. |
| No token | Exit 2. Never a clean report. |
| Rate limited / 403 / network error | Exit 2. |
| `refs/pull/N/head` unfetchable (GC'd, deleted fork) | PR recorded in `unclassified`, never in `silent`. Fail toward saying something. |
| More than 100 merged PRs | Paginated; the API caps a page at 100 and there are already 112. |
| Ledger entry whose PR now reaches master | Listed in `stale_ledger`, reported, exit 0. |

## Testing

Lives in `test/`, beside the existing `checkers.test.ts`, and runs offline via the injected `fetchImpl` and git runner.

**The fixture must contain all three real shapes** — reachable, landed-via-squash, and genuinely lost. A fixture whose PRs all look alike cannot discriminate between them, and this session produced a live example of that failure: a redaction probe that gave every stage the same filler sentence reported 2 leaking bodies where there were 7.

Cases:

1. An ordinary squash-merged PR produces **no output** — the must-not-fire half, and the one that decides whether anyone keeps the check.
2. A #73-shaped PR (unreachable, all patches upstream) is silent.
3. A #93-shaped PR is reported as a finding.
4. A ledgered PR appears in `explained`, not `findings`.
5. A ledger entry whose PR is reachable appears in `stale_ledger`, and the run still exits 0.
6. Missing token exits 2, and the report is not "clean".
7. An unfetchable head lands in `unclassified`, not `silent`.

Mutation-proofs, each of which must fail a specific test:

- Delete stage 2 → case 2 reports a false loss.
- Delete ledger subtraction → case 4 reappears as a finding.
- Return exit 0 on a missing token → case 6 fails.
- Treat an unfetchable head as landed → case 7 fails.

## Appendix — one-off findings, branch sweep of 4 September 2026

Recorded here rather than monitored. 85 remote branches were classified; 72 were provably merged and deleted. Of the remainder:

- **`feature/phase1-hardening-2026`** — 6 commits, no pull request ever opened, authored 2 September 2026. Turns on `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, updating `tsconfig.json`'s recorded error counts from 25/208 to 29/283 ("combined: 312"), and touches 17 source files plus two new tracking documents. Merges cleanly against `master` as of 4 September 2026. **A decision, not a defect.**
- **`upgrade/dev-deps-vitest-3.2.7`** — commit `a499e829` adds `audit.json` (774 B) and `outdated.json` (1,550 B) at the repository root. Throwaway dependency dumps; `check:hygiene` parses every tracked `.json`, so their exclusion was probably deliberate. **Not work to recover.**
- **`fix-doc-counts-after-91`** — carries PR #93's stranded merge. Must not be deleted until `2026-09-02-brief-generator-pilot.md` is restored to `master`.

Nine further branches carried commits that had all landed by squash or rebase and are safe to delete.
