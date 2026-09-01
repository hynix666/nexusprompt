# Noise floor and cost model — design

**Status:** approved for planning, 1 September 2026
**Sub-project:** 1 of 3 (noise floor → provider-facing anchor → judge and judge validation)

## Goal

Measure what a model comparison on this repository's suites can and cannot resolve, record it
as a committed artifact, and make a claim that exceeds it fail the build.

## Why this is first

The decomposition puts this ahead of the larger derived anchor for a reason that is not
sequencing convenience: **the noise floor is the denominator for everything the anchor would
claim.** A between-model difference means nothing until within-model spread is known, and
sizing the anchor needs a discordance rate that, guessed wrong, permanently mis-sizes it.

Both were measured on 1 September 2026 and both changed the plan:

| quantity | assumed before | measured |
|---|---|---|
| within-model spread, 3 trials | unknown | **0.071–0.143** (1–2 cases of 14) |
| discordance rate between model pairs | 0.50 (the repo's `STATED_ASSUMPTIONS`) | **0.238** |
| cases needed to resolve 7 pp | 801 | **382** |

The spread finding is the sharper one. Across four local models — `phi4-mini:latest`,
`lfm2.5-thinking:latest`, `gemma4:e4b`, `gpt-oss:20b` — three trials each on `compile-smoke`,
every model's own trial-to-trial spread was at least as large as the largest gap between
models. `phi4-mini` and `lfm2.5-thinking` produced identical score sequences. All six pairwise
comparisons came back **refused**, not inconclusive: the largest discordance was 5 clusters
against a Bonferroni-corrected floor of 8, so no arrangement of the signs could have reached
significance.

A second finding shapes sub-project 2 directly: **8 of the 12 runnable cases were constant**
across every model and every trial. Only 4 discriminate at all. A suite scaled from this one
would be roughly two-thirds dead weight, so the anchor must keep a case only when models
actually disagree on it — the same discipline `gate-recall-anchor` already applies when it
keeps a case only if exactly one previously-silent gate fires.

## Scope

**In:** a sweep runner, a measurement artifact, a claim-checking gate, and a runtime refusal in
the existing comparison tool.

**Out:** new eval cases (sub-project 2), any judge (sub-project 3), and any change to how
models are run — `pipeline --model` and `eval --local` are unchanged.

## Architecture

Five units, each independently testable.

```
sweep:models ──> runs.txt / cases.txt ──> compare:models ──> eval/noise-floor.json
                                               │                      │
                                               │ runtime refusal      │ read by
                                               v                      v
                                        printed verdict         check:noise <── scripts/noise-claims.json
```

### 1. `eval/noise-floor.json` — the measurement artifact

Written by `compare:models --write`. Shaped like `scripts/model-fingerprints.json`: dated,
measured, and **not re-derivable**, because models are stochastic, temperature is unpinned, and
run bundles are gitignored.

```json
{
  "measured_on": "2026-09-01",
  "suite": { "id": "compile-smoke", "version": "2.0.0", "cases_scored": 12 },
  "transport": "local",
  "trials_per_model": 3,
  "models": {
    "phi4-mini:latest": {
      "scores": [0.714, 0.643, 0.714],
      "mean": 0.690,
      "spread": 0.071,
      "seconds": [73, 63, 64],
      "tokens_out": [8808, 7848, 8004],
      "degraded_runs": 0
    }
  },
  "pairs": {
    "phi4-mini:latest|lfm2.5-thinking:latest": { "discordant_clusters": 2, "clusters": 14 }
  },
  "cases": {
    "degraded-run-is-labelled": { "rates": { "phi4-mini:latest": [3, 3] }, "constant": true }
  },
  "discordance_rate": 0.238
}
```

`cases_scored` is load-bearing and is **12, not 14**. The transport-validity fix excludes two
cases on any real transport, and a floor measured against a different denominator is not
comparable to one measured against this denominator.

Two definitions, fixed here so the writer and the gate cannot disagree:

- **`spread`** is `max(scores) − min(scores)` for that model — the observed range across
  trials, not a standard deviation. Three trials is too few for a variance estimate anyone
  should quote, and a range states plainly what was seen.
- **`discordance_rate`** at top level is the **mean** of the per-pair
  `discordant_clusters / clusters`, across every unordered pair. Per-pair counts are kept
  beside it so the mean can be re-derived and a lopsided pair is visible rather than averaged
  away.

**Measurements only, never verdicts.** The artifact must not record "model A beats model B".
Storing a verdict makes it something people cite instead of re-deriving, and sub-project 2
would inherit a frozen conclusion where it needs a discordance rate.

### 2. `scripts/noise-claims.json` — claims pinned to documents

The same `{document, pattern, reason}` shape as `scripts/counted-claims.json`, and the same
staleness rule: a pattern matching nothing fails, so a pin cannot outlive the prose it guards.

One difference, and it is the whole point. `counted-claims` checks **equality** against a
resolver. This checks a **bound**: the number a pattern captures is a claimed difference in
percentage points, and it must be **greater than or equal to** what the suite can resolve.

```json
{
  "document": "Documentation/PROVIDERS.md",
  "pattern": "([\\d.]+) ?pp better",
  "reason": "A stated model difference. 12 cases at the measured discordance rate resolve 39.5 pp; anything smaller is inside the instrument's noise and must not be written as a finding."
}
```

**Magnitude-free ordering claims are refused, not validated.** A sentence asserting one model
is better without saying by how much has nothing to bound, and validating it would require the
stored verdicts the artifact forbids. The rule is: *state the size or do not state the claim*,
because whether the instrument could have seen a difference depends entirely on its size.

These need a second entry kind, because they invert the staleness rule. A `bound` entry fails
when its pattern matches **nothing** — the pin has outlived its prose. A `forbidden` entry
fails when its pattern matches **anything** — the phrasing it names is present.

```json
{
  "kind": "forbidden",
  "document": "Documentation/PROVIDERS.md",
  "pattern": "(outperforms|is better than|beats) `?[a-z0-9.:-]+`?",
  "reason": "An ordering with no magnitude. Nothing to bound, and the artifact stores no verdict to validate it against. Give the size or drop the claim."
}
```

Two kinds is the minimum: one rule cannot mean both "must match" and "must not match", and
collapsing them would make a stale bound entry indistinguishable from a satisfied forbidden
one. `kind` is required on every entry rather than defaulted, so an author has to say which
direction they mean.

### 3. `scripts/check-noise.mjs` — the gate

Pure file reading. No GPU, no daemon, no network; it runs in CI.

| state | behaviour | exit |
|---|---|---|
| no `eval/noise-floor.json` | prints **"not armed"** with the reason | 0 |
| armed, every claim clears the floor | prints OK with the counts | 0 |
| a `bound` claim's delta is below the resolvable delta | names document, claimed delta, resolvable delta | 1 |
| a `bound` pattern matches nothing | **stale** — delete the pin or restore the claim | 1 |
| a `forbidden` pattern matches anything | names the document and the matched text | 1 |
| artifact unreadable or malformed | fatal | 2 |

A `forbidden` entry that matches nothing is the **satisfied** state and passes silently. It is
deliberately not treated as stale: unlike a bound entry, it guards against prose that should
never appear, so its absence is success rather than a pin that has lost its subject.

"Not armed" is the permanent CI state and is deliberate. `check:fingerprint` established the
shape: a guard with zero coverage that prints OK is worse than no guard, so it reports coverage
honestly instead. Exit codes match `check:counts` — 1 for a failed claim, 2 for a broken input.

The resolvable delta is computed by `resolvableDelta` from `core/src/eval/sizing.ts`, using
`cases_scored` and `discordance_rate` from the artifact. Nothing is reimplemented: the same
function `check:sizing` prints answers here.

### 4. Runtime refusal in `compare:models`

`compare:models` already refuses a pair when `attainable` says no arrangement of the signs
could reach the corrected alpha. This adds one thing: when `eval/noise-floor.json` exists and a
pair's observed mean difference sits inside the recorded spread, the verdict prints
`inconclusive (inside the recorded noise floor of X)` rather than any stronger word.

It catches the error earlier than the gate, at the moment someone reads a number and is about
to write it down. It does not replace the gate, because the damage happens when the number
reaches a document.

### 5. `npm run sweep:models` — the runner

Replaces the ad-hoc shell script that produced the September measurement. Runs N trials per
named model, appending to `runs.txt` and `cases.txt` **as it goes**, so a crash or a kill
leaves every completed run readable — the ad-hoc version was killed twice mid-sweep and its
partial data was still usable, which is the property worth keeping.

Captures per run: wall seconds, exit code, score line, token counts, and per-case verdicts.
Line-oriented and append-only; the format is documented in `compare-models.mjs`.

## Data flow

1. `sweep:models --models a,b,c --trials 3` writes `runs.txt` / `cases.txt`.
2. `compare:models <dir>` reports variance, the constant-case matrix, and pairwise verdicts.
3. `compare:models <dir> --write` produces `eval/noise-floor.json`.
4. `check:noise` validates every pinned claim against it, in CI, forever.

## Error handling

- **Partial sweeps parse.** A truncated line yields a record with null score rather than an
  exception; a sweep killed halfway is still analysable.
- **Unknown models are the operator's problem, not the tool's.** `sweep:models` reports a
  model that produced no successful run and continues to the next, rather than aborting the
  batch — a 20-minute model failing must not discard the three that already succeeded.
- **A degraded run is recorded, not dropped.** `degraded_runs` is a per-model count. Dropping
  them would flatter a model that times out, which is precisely the operational signal wanted.
- **Malformed artifact is fatal (exit 2)**, never treated as "not armed". Absent and broken are
  different states and must not collapse.

## Testing

Every test runs offline against fixtures. The measurement it validates took ninety minutes of
GPU time; an analysis checkable only by repeating it is not checkable.

- **Parsing:** run and case lines, including a truncated line and an empty file.
- **Clustering:** trials of one case are one unit, not N. Already covered for
  `compare-models`; extended to the artifact writer.
- **Bound checking, both directions:** a claim above the resolvable delta passes; one below
  fails and names both numbers. The must-not-fire half matters more — a checker that failed
  every claim would satisfy the first half alone.
- **Staleness:** a pattern matching nothing fails, mirroring `check-counts`.
- **Not-armed:** with no artifact, exit 0 and the words "not armed"; with a malformed
  artifact, exit 2. A test asserts these are distinguishable.
- **Mutation proof** for the gate: forcing the bound comparison to always pass must fail the
  must-fire tests and no others.

## What this does NOT establish

Stated here so it can be copied into `spec/truth-boundary.json` when the work lands.

- **It does not make model comparisons possible.** It measures why they currently are not.
  With 12 cases and the measured discordance rate the suite resolves **39.5 pp**; the four
  models measured sit within roughly 5 pp of each other.
- **It is not reproducible.** Models are stochastic, temperature is unpinned, bundles are
  gitignored, and CI has no GPU. The artifact records what one machine observed on one day,
  exactly as the fingerprint watch does.
- **A floor measured on one suite, transport and trial count says nothing about another.**
  All three are recorded in the artifact for that reason.
- **It does not rank models.** It forbids ranking them on evidence too small to support one.

## Consequences

**Easier:** sizing sub-project 2 with a measured discordance rate instead of an assumption —
382 cases for 7 pp rather than 801. Knowing which cases discriminate before generating more.

**Harder:** writing a model comparison into a document. That is the intent.

**To revisit:** the floor is per-suite and per-transport. When sub-project 2's anchor exists it
needs its own measurement, and the artifact's shape already carries the suite id to make the
two non-interchangeable.
