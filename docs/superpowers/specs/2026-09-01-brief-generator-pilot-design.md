# Provider-facing pilot: a brief generator, and whether it pays — design

**Status:** Tasks 1–4 attempted, 3 September 2026 — sweep produced 1 valid run of 6; measurement invalid (see findings). Task 4 must be re-run.
**Sub-project:** 2 of 3, pilot phase (noise floor → **provider-facing anchor** → judge)
**Depends on:** `eval/noise-floor.json`, armed 1 September 2026

## Goal

Build a seeded brief generator, produce a 100-case pilot suite, run it against two models,
and measure whether a suite of *model-sensitive* cases resolves a difference more cheaply than
the hand-written suite does — or does not, which is an equally valid outcome and cheaper to
discover now than after 341 cases.

## Why a pilot rather than the anchor

Sub-project 1 measured a discordance rate of **0.2778** across twelve hand-written cases and
established that resolving an 8 pp difference needs **341 cases** — 16.4 GPU-hours for four
models at three trials, or 3.4 for two fast ones.

Those numbers come from a suite nobody designed for this purpose. Seven of its twelve cases
are constant across every model, and they are constant *by construction*: `provenance-is-complete`,
`gates-actually-run` and `degraded-run-is-labelled` test the pipeline's own behaviour, not the
model's. A suite built to compare models should not contain them.

**Whether removing them helps is genuinely unknown, and the arithmetic can go either way.**
The sizing rule is

```
n ≈ (z_α + z_β)² · p_d / Δ²
```

Concentrating on model-sensitive cases moves both terms up. `p_d` rising costs cases linearly;
`Δ` rising saves them quadratically. Which dominates is empirical. An earlier draft of this
reasoning asserted that concentrating would obviously shrink the suite; that was wrong, and it
is recorded here because it is the exact mistake the pilot exists to prevent someone repeating
at 341-case scale.

## Scope

**In:** a seeded brief generator, a 100-case pilot suite, a `--suite` passthrough for the sweep, one measured run against two models,
and a written finding — `docs/superpowers/specs/2026-09-01-brief-generator-pilot-findings.md` —
that sets sub-project 2's size or abandons the approach.

**Out:** the full anchor (sized by this pilot's result), any judge, any change to the eval
runner, and any comparison involving `gpt-oss:20b` — at 27.2 s/case it costs 6× `phi4-mini`
and sub-project 1 measured its within-model spread at 25.0 points, the widest of any model.

## Architecture

### 1. `core/src/eval/brief-generator.ts` — generated inputs, not derived labels

Pure, seeded, no I/O. Follows `anchor.ts`'s discipline with one deliberate difference worth
stating plainly, because it is the part most likely to be misread:

**`anchor.ts` derives per-case ground truth; this does not, and does not need to.** The anchor
injects a fragment and keeps the case only when exactly one previously-silent gate fires, so
the gate becomes the label. That works because it never calls a provider. A provider-facing
case cannot know what a model will write, so no label can be derived the same way.

None is required. McNemar compares two arms on *identical items*; the comparison is between
models on the same briefs, scored the same way. What must be generated is the **input**, and
what must be transport-independent is the **scoring**.

The generator varies exactly the pressure points sub-project 1 measured as discriminating:

| dimension | why it is in |
|---|---|
| a secret in the brief | `brief-secret-not-echoed` varied 0/3–2/3 across models |
| unicode and CRLF | `unicode-and-crlf-survive` varied 0/3–3/3, the widest spread of any case |
| placeholder-shaped tokens | `placeholder-not-left-in-output` varied 0/3–1/3 |
| brief length and domain | drives `structure-header-present` and gate conformance |

Nothing that tests the pipeline rather than the model. That is the entire design change.

### 2. `eval/brief-pilot.json` — the suite

`suite_id: "brief-pilot"`, `version: "1.0.0"`, `kind: "smoke"`, exactly **100** cases from
**seed 1** — a fixed count, not an approximate one, because `detectable_delta` is pinned to
`1/n` and an approximate `n` cannot be pinned to anything.

Stores **case ids only**, regenerated from seed, exactly as `eval/gate-recall-anchor.json`
does (4,906 ids, zero inline cases, 123 KB). `npm run check:brief-pilot` fails when the
committed file is not what the generator produces, in the generate-then-compare shape
`check:anchor` and `check:matrix` already use.

`resolution.detectable_delta` must equal `1/n` or `check:sizing` fails — that check reads
every suite in `eval/` and will start validating this one the moment it exists.

### 3. Scoring: transport-independent detectors only

The pilot scores with the detectors that mean the same thing under a real transport:
`output-nonempty`, `no-gate-failures`, `gates-ran`, `no-marker-when-live`, `output-contains`,
`output-omits`, `provenance-complete`.

It must not contain a case asserting a gate verdict other than PASS. `partitionByTransport`
would exclude those under `--local`, and a generated suite that generates its own exclusions
is a suite arguing with itself.

### 4. `sweep:models --suite` — a passthrough that does not exist yet

`scripts/sweep-models.mjs` hardcodes its runner arguments:

```js
["node_modules/tsx/dist/cli.mjs", "scripts/run-eval.ts", "--local", "--model", model]
```

There is no `--suite`, so it can only ever run `compile-smoke`. **The pilot cannot be measured
without adding one**, and this was missed until the spec's own self-review. It is a small
change — `run-eval.ts` already accepts `--suite` — but it is a prerequisite, not an
afterthought, and it needs its own test: a sweep that silently measured the wrong suite would
produce a `p_d` for `compile-smoke` while the file name claimed otherwise.

### 5. The measurement

`sweep:models --models phi4-mini:latest,lfm2.5-thinking:latest --trials 3 --suite eval/brief-pilot.json`,
then `compare:models` for the report. Two models, one pair, no Bonferroni correction,
discordance floor 6 rather than 8.

**Cost: 100 cases × 12.1 s/case × 3 trials = 3,630 s ≈ 1.0 GPU-hour.**

## What the pilot must report

1. **`p_d`** — the discordance rate of a generated, model-sensitive suite.
2. **`Δ`** — the observed gap between the two models' means.
3. **The size implied**, via `requiredPairedSize(Δ, {alpha: 0.05, power: 0.8, discordanceRate: p_d})`.
4. **Constant-case fraction** — how many generated cases still fail to discriminate.

## Success and failure are both real outcomes

**Pays:** the implied size for the observed Δ is materially below 341 cases, or the constant
fraction is far below 7/12. Sub-project 2 proceeds at the measured size.

**Does not pay:** the implied size is at or above 341, or generated briefs produce *more*
constant cases than hand-written ones. Sub-project 2 is then not a bigger suite, and the
honest conclusion is that model comparison on this pipeline is not affordable at any size
worth paying — which is a finding, recorded in the truth boundary rather than buried.

A pilot that can only succeed is not a pilot.

## What this does NOT establish

- **Not a model comparison.** One pair, 100 cases, one measurement. It sizes an instrument;
  it does not use one.
- **Not reproducible as a measurement.** The *suite* regenerates from seed and is checked. The
  *run* does not: temperature is unpinned, models are stochastic, CI has no GPU.
- **Says nothing about `gemma4:e4b` or `gpt-oss:20b`,** which are deliberately out of scope.
  A `p_d` measured on two fast models may not hold for a pair including a slow one.
- **Generated briefs are not representative prompts.** They vary the dimensions sub-project 1
  found discriminating, which is a statement about this suite's detectors, not about what
  users write.

## Consequences

**Easier:** sizing sub-project 2 from a suite built for the purpose rather than from twelve
cases written for something else.

**Harder:** nothing. The generator is kept either way; only its scale is in question.

**To revisit:** if the pilot pays, the anchor's size comes from *its* `p_d`, not from
`eval/noise-floor.json`'s 0.2778 — and the two must not be conflated, since they describe
different suites.
