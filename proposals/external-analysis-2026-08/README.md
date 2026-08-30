# External analysis, August 2026 — merged unreviewed, NOT adopted

**Nothing in this directory is authoritative.** It is not referenced by any document in
`Documentation/`, none of its numbers are re-derived by `check:counts` or `check:truth`, and no
recommendation in it has been accepted. It is kept because parts of the analysis are worth
reading — not because any of it has been checked.

## How it got here

Three documents arrived at the repository root in pull requests
[#69](https://github.com/hynix666/nexusprompt/pull/69),
[#70](https://github.com/hynix666/nexusprompt/pull/70) and
[#71](https://github.com/hynix666/nexusprompt/pull/71) on 30 August 2026, produced by an
automated task and merged without review. The same three merges also emptied `.gitignore` to a
single line of prose and tracked 3,424 files under `node_modules/` plus seven runtime files
under `.nexusprompt/`. `npm run verify` failed on every one of those six CI runs — three pull
request runs and three pushes to master — naming fifteen problems including the exact shape of
the incident:

> `.gitignore` holds 1 rule(s), below the floor of 20. That is the shape of all three previous
> incidents: the file was truncated, not edited. Restore it from the last good revision.

The merges went through anyway, and master stayed red for three hours. The check was not
missing and did not fail to fire; nothing was configured to stop a merge when it does. That is
recorded here rather than in `Documentation/` because it is a fact about this directory's
provenance: these files are the payload of the fourth `.gitignore` emptying, not a reviewed
contribution.

## What was checked, and what was found wrong

Only the mechanically checkable claims were verified. This is not a review — the argumentation
is unassessed.

### `LOCAL_LLM_INTEGRATION_STUDY.md` — its commands do not do what it says

Every one of its ten `npm run eval` invocations passes `--provider ollama-local`.
`scripts/run-eval.ts` accepts `--live`, `--local`, `--dry-run`, `--compare`, `--json`,
`--suite`, `--model`, `--max-calls` and `--trials`. There is no `--provider`.

The consequence is worse than a command that errors. Transport is selected by `--live` or
`--local`, and neither is present in any command the study gives, so every one of them runs
against **pinned stubs** while the reader believes a local model answered. Its headline
example —

```
npm run eval -- --provider ollama-local --model llama3.2:3b --max-calls 5
```

— names a model, spends nothing, reaches nothing, and reports a pass. `provenance.provider`
in the resulting `EvalRun` would read `pinned-stub`, which is the field that exists to keep a
run that is evidence about a model separate from one that is evidence about the accounting.

Its executive summary also states the system has *"zero provider calls ever made (verified in
TRUTH_BOUNDARY.md)"* and is dated **December 2025**. The `provider-ollama` adapter it describes
as "already implemented" landed on 30 August 2026 (`af96853`), eight months after the document's
own date.

### `COMPREHENSIVE_IMPROVEMENT_ANALYSIS.md` — contradicts itself on the test count

It gives the suite as **1,547 tests** twice and **1,546** twice, in the same document, once in
the same paragraph. `npm run verify` reports 1,547. Also dated December 2025.

### `ADDITIONAL_IMPROVEMENTS_AND_LOCAL_LLM_GUIDE.md` — the soundest of the three

Correctly dated, and its eval commands use `--local`, which is the real flag. Several scripts
it recommends running (`benchmark:model`, `benchmark:compare`, `docs:graph`,
`check:cross-references`, `cli health`, `cli grade`, `cli chaos-test`) do not exist; read those
as proposals rather than instructions, which is how the surrounding text presents them.

## The one finding worth acting on

Not a documentation defect. `scripts/run-eval.ts` **ignores unrecognised flags silently**,
which is what lets `--provider ollama-local` produce a confident stub run rather than a
refusal. A runner that cannot tell an operator they asked for a transport it does not have is
the same failure mode as a suite accepted by the wrong runner — the case
`isPipelineCase` exists to prevent.

## Recovering the originals

The files are unmodified from the merge commits; only their location changed. The root-level
originals are at `bc76a27` in history:

```bash
git show bc76a27:LOCAL_LLM_INTEGRATION_STUDY.md
```
