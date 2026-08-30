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

Transport is selected by `--live` or `--local`, and neither appears in any command the study
gives, so every one of them runs against **pinned stubs**. Run as written:

```
npm run eval -- --provider ollama-local --model llama3.1:8b --max-calls 100
  configuration f938ffde188f · 14 pinned provider call(s), no network
  14/14 cases · score 1.000
```

Exit 0. `--provider` was ignored — the runner does not reject unrecognised flags. `--model` is
a real flag, was accepted, and was inert: it is read into `localModel` and only consulted when
the transport is `local`, so naming a model under the stub transport does nothing and says
nothing.

**The report itself is honest** — *"14 pinned provider call(s), no network"* is exactly what
happened, and `provenance.provider` on the resulting `EvalRun` reads `pinned-stub`. What is
missing is a refusal at the point where the operator's request and the runner's transport
disagree. The study's own headline command (`--max-calls 5`) does refuse, but for an unrelated
reason: 14 planned calls exceed the budget.

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

Not a documentation defect, and not an honesty defect in the output. `scripts/run-eval.ts`
**ignores unrecognised flags silently**, and accepts `--model` under a transport that cannot
use one. Both are the same shape: the runner cannot tell an operator that what they asked for
is not what it is about to do. It reports the run it actually performed, correctly — but a
misspelled transport flag should refuse before dispatch, the way an undeclared budget does.

## Recovering the originals

The files are unmodified from the merge commits; only their location changed. The root-level
originals are at `bc76a27` in history:

```bash
git show bc76a27:LOCAL_LLM_INTEGRATION_STUDY.md
```
