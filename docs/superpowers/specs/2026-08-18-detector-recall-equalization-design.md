# Detector-recall equalization

**Status:** Implemented. See *As built* for the three places the build departed from this text.
**Date:** 2026-08-18
**Phase:** 2b — the evaluation subsystem
**Implements:** [ADR-0008](../../../Documentation/0008-evaluation-first-environment.md) §2 and action item 3

## The problem

`Comparison.detectors_equalized` is a boolean the caller supplies. Nothing computes it.
Every occurrence that carries a value is a test, hardcoded `true`; `application/src/eval.ts`
never sets it at all. The comparator's strongest guard — the one that makes it refuse rather
than report a number — is today a field somebody fills in.

This is the fourth instance of a pattern this repository has already paid for: a guard whose
name is broader than its mechanism. The purity harness never blocked the filesystem.
`typecheck` covered a third of the code. The cross-shell rule missed relative imports. In
each case the guard passed, and passed honestly, while checking less than its name claimed.

The failure it is supposed to prevent is documented and quantified. In the *Cross-Provider
Architectural Ablation* (6,912 API calls, three providers, two model generations, twelve
configurations), enforcing JSON output appeared to raise hallucination by 10.1 and 15.1
percentage points. The gap was largely a **detection-format artifact**: structured fields
made out-of-inventory mentions easier to find. Under a recall-equalized detector the
conclusion reversed.

The sharp reading of that result is the one this design turns on. Recall is not a property of
a detector. It is a property of **(detector, configuration)**. The same detector had
different recall against different output formats, and that difference alone produced a
confident, wrong, two-figure finding.

## Scope

Two things, because the first without the second is unfalsifiable:

1. **Equalization** — recall measured per (detector, configuration) from mutation probes,
   carried on the run that produced it, and consumed by a comparator that derives its own
   verdict instead of being told one.
2. **The first real comparison** — a second configuration with a deliberately worse prompt,
   compared end to end, so the harness is *shown* to report a regression.

Shipping (1) alone would deliver a guard that no comparison has ever exercised. Phase 2b's
exit gate says the quiet part directly: *a harness that has never reported a regression has
not been shown to detect one.*

## Design

### 1. Ground truth is constructed, not labeled

A probe is a pure mutation plus the detector it targets.

```ts
export interface MutationProbe {
  readonly id: string;
  readonly detector_id: string;
  /** Pure. Injects the property this detector exists to catch. */
  mutate(outcome: PipelineOutcome): PipelineOutcome;
  readonly expectation: EvalCase["expectation"];
}
```

The label is known because we made it. This is the method the repository already trusts —
26 planted defects in Phase 1, eight mutations against the evaluation path — applied to the
instrument instead of to the code.

The alternative, a hand-labeled corpus of real outputs, is not available: there is no
live-provider path, so every outcome in the repository is a pinned stub, and labeling our own
stubs measures nothing. It is the right independent second checker, and it is deferred rather
than dismissed. See *Known bounds*.

### 2. Substrates, and the two ways a detector is broken rather than weak

A probe only counts on a substrate where **the detector is silent before mutation**. An
outcome that already carries the property proves nothing when detection succeeds — you cannot
measure an instrument by handing it something it has already found.

Substrates are therefore drawn from the run's own outcomes, which is what makes recall
specific to that configuration's output format rather than generic.

Two conditions mean the instrument is broken, and they are handled differently:

| Condition | Meaning | Consequence |
|---|---|---|
| `recall: 0` | Probes ran; the detector caught none | **Fails the build.** Dead code behind a passing suite. No legitimate cause. |
| `substrates: 0` | The detector fired on every outcome | **Refuses the comparison; warns.** Recall was never measurable. An eight-case suite can trip this benignly, and a build failure with a legitimate cause is one people learn to route around. |

`substrates: 0` is also the false-positive guard, at no extra cost: a detector that is never
silent is one that always fires, which is the recall-1.0-and-worthless case. It needs no
separate mechanism.

Stated precisely, since the two zeros are easy to conflate:

```
probes_run      = substrates × (probes targeting this detector)
recall          = probes_detected / probes_run,  or null when probes_run = 0
```

`recall` is **null, never 0**, when there was nothing to run — otherwise `substrates: 0`
would divide by zero and, worse, arrive as a `recall: 0` that fails the build for the wrong
reason. Zero recall means *measured and dead*; null means *not measurable*. They take
different paths through the table above and must not be allowed to collapse into each other.

Every detector requires at least one probe **in the corpus** — a separate requirement from
`probes_run`, which can legitimately be 0 when a run offers no substrate. A detector with no
probe in the corpus fails the build. Structural
detectors — `output-nonempty`, `gates-ran` — will score 1.0 from a single trivial probe, and
that probe is not ceremony: it is a mutation test proving the detector fires at all. One
mechanism, two guarantees.

### 3. The equalization rule

Two aggregations, deliberately different:

- **The gap bound is per detector.** Every detector the suite uses must satisfy
  `|r_candidate − r_baseline| ≤ gap_bound`. No averaging: one asymmetric detector suffices to
  manufacture the artifact, and averaging is what lets a bad instrument hide behind good ones.
- **The attenuation factor is the minimum** across every detector the suite uses, taken over
  **both runs** — `effective_recall = min(r)` over the union, not per run and not averaged.
  Taking it over both matters: the comparison is only as sharp as the blunter of the two
  instruments producing it, so the weaker run sets the resolution for the pair. A case fails
  if *any* of its detectors fires, so attributing a case to one governing detector is not
  well-defined when it has several; the minimum is the conservative bound that avoids needing
  that attribution. It is sometimes pessimistic — one blunt detector drags the suite's stated
  resolution down — and that pressure to fix or drop the blunt detector is the correct
  incentive.

**The gap bound is derived, not chosen:** `gap_bound = suite.resolution.detectable_delta`.

#### Why that is the right number, and what it guarantees

Model a detector with recall `r` and precision 1 on constructed properties. With true failure
rate `f`, the observed failure rate is `r·f` and the score is `1 − r·f`. So

```
delta_measured = (1 − r_c·f_c) − (1 − r_b·f_b) = r_b·f_b − r_c·f_c
```

Equal recall collapses this to `r · delta_true` — sign preserved, magnitude attenuated.
Setting the *true* rates equal instead isolates the artifact: `f·(r_b − r_c)`, whose magnitude
is at most `|Δr|` because `f ≤ 1`.

Bounding `|Δr|` by `detectable_delta` therefore bounds the artifact by `detectable_delta`. And
since `adjusted_resolution = detectable_delta / min(r)`, any nonzero gap forces some `r < 1`,
hence `min(r) < 1`, hence `adjusted_resolution > detectable_delta ≥ artifact` — strictly.

**A pure recall artifact can never on its own clear the reporting threshold.** The edge case
where that inequality would go non-strict requires both recalls to equal 1, which makes the
gap zero and the artifact vanish. It is unreachable.

The bound also tightens automatically as a suite grows, rather than being a constant somebody
must remember to revisit.

#### Adjusted resolution, and the reading that was rejected

`adjusted_resolution = detectable_delta / effective_recall`.

The opposite reading is defensible on its face and is wrong here. Since a measured delta `m`
at recall `r` implies a true delta of `m/r`, one could check the *true* delta and let the
measured bar fall to `r · detectable_delta`. Two reasons not to:

- **It is vacuous at smoke-suite sizes.** At eight cases the smallest nonzero measured delta
  is 0.125, while the bar at `r = 0.8` falls to 0.10. The check could never once bite, and a
  check that cannot fail is not a check.
- **Attenuation destroys evidence, not just magnitude.** Lower recall means fewer observed
  failures, hence fewer discordant pairs — which is what McNemar actually consumes. Demanding
  more of a blunter instrument is correct, not merely cautious.

At `r = 1` the adjusted value is exactly today's behaviour, so nothing regresses.

### 4. Contracts

Contract-first per [ADR-0002](../../../Documentation/0002-contract-first-design.md): both
bumps land as their own reviewed change, before implementation.

**`eval-run` 1.0.0 → 1.1.0** (additive). New optional, nullable `detector_recall`:

```json
"detector_recall": {
  "type": ["object", "null"],
  "description": "Recall of each detector, measured against mutation probes applied to THIS run's own outcomes. Absent means recall was not measured — never that it was adequate.",
  "required": ["detectors", "probe_corpus_version"],
  "properties": {
    "probe_corpus_version": { "type": "string" },
    "detectors": {
      "type": "array", "minItems": 1,
      "items": {
        "required": ["detector_id", "substrates", "probes_run", "probes_detected", "recall"],
        "properties": {
          "detector_id":     { "type": "string" },
          "substrates":      { "type": "integer", "minimum": 0 },
          "probes_run":      { "type": "integer", "minimum": 0 },
          "probes_detected": { "type": "integer", "minimum": 0 },
          "recall":          { "type": ["number", "null"], "minimum": 0, "maximum": 1 }
        }
      }
    }
  }
}
```

Nullable rather than required, with wording taken deliberately from `grader_health`. Absence
is a known-unknown, never a pass. A run may legitimately exist without recall — you wanted the
score — it simply cannot be *compared*. Enforcement lives in the comparator, which keeps this
bump additive.

`probe_corpus_version` is what makes two runs' figures commensurable. Recall measured under
different probe corpora is not comparable, and without this field that is undetectable.

**`comparison` 1.0.0 → 2.0.0** (breaking). `detectors_equalized` is **deleted** and replaced:

```json
"equalization": {
  "required": ["equalized", "max_gap", "gap_bound", "effective_recall",
               "adjusted_resolution", "per_detector"],
  "properties": {
    "equalized":           { "type": "boolean" },
    "max_gap":             { "type": "number" },
    "gap_bound":           { "type": "number" },
    "effective_recall":    { "type": "number" },
    "adjusted_resolution": { "type": "number" },
    "per_detector":        { "type": "array" }
  }
}
```

The major bump is the point rather than an inconvenience to route around. Keeping the boolean
beside the evidence would be additive and cheap, and would leave **two sources of truth for
one fact** — one of them a summary readable without consulting the evidence. That the boolean
can be read without being checked *is* the defect. Deleting it is the fix; preserving it for
compatibility would preserve the bug. Nothing outside this repository consumes these schemas.

`gap_bound` is recorded, not merely applied, so an old comparison stays auditable against the
rule actually in force when it ran.

**A `CHANGELOG` does not exist.** ADR-0002 requires a version bump and a changelog entry per
schema change; versions live in each schema's `$id`, but the changelog half has never had an
artifact behind it — the same pattern as the guards above, in the documentation this time.
This change carries two bumps and creates `contracts/CHANGELOG.md`.

### 5. Layers

All of it is Core. `mutate` is a pure transform and `detector.run` is already pure, so recall
measurement is one pure function needing nothing from the Application layer:

```ts
// core/src/eval/probes.ts
export function measureRecall(
  outcomes: readonly PipelineOutcome[],
  probes: readonly MutationProbe[],
): DetectorRecallBlock
```

That placement is not tidiness. Recall inherits Core's guarantees — no clock, no randomness,
no network — so a recall figure is **recomputable from stored artifacts** rather than
requiring the run be repeated. The comparator is auditable for that reason; the instrument
check should be auditable for the same one. `scripts/check-boundaries.mjs` is satisfied by
construction: `probes.ts` imports `contracts` and `detectors`, nothing else.

Application produces outcomes per configuration, calls `measureRecall`, and attaches the block
to the `EvalRun`. `decide → invoke → reduce` is undisturbed, because probing invokes nothing.

Probes need **no new generations** — they mutate outcomes that already exist. Recall
measurement therefore stays near-free even once a live provider lands, which is what removed
the case for caching it as a separate calibration artifact.

```
Application: run suite under configuration C  ──▶  outcomes[]
                                                      │
Core (pure): measureRecall(outcomes, PROBE_CORPUS) ───┤
   for each detector d:                               │
     substrates ← outcomes where d is silent          │
     for each substrate × each probe targeting d:     │
       d fires on mutate(substrate)?  → detected++    │
                                                      ▼
                                          EvalRun.detector_recall
                                                      │
              ┌───────────────────────────────────────┘
              ▼
Core (pure): compare(candidateRun, baselineRun, suite)
   derives gap, effective_recall, adjusted_resolution → verdict
```

Every probe runs against every valid substrate. Eight cases by roughly fifteen probes is
microseconds of pure string work, and maximizing format coverage is the entire defence against
a format artifact.

### 6. Comparator decision order

| Condition | Verdict |
|---|---|
| Either run has no `detector_recall` | **refused** — recall was not measured |
| `probe_corpus_version` differs between runs | **refused** — figures are incommensurable |
| Any detector has `recall: null` | **refused** — unmeasurable instrument |
| Detector sets differ between runs | **refused** — nothing to equalize |
| `max_gap > gap_bound` | **refused** — the artifact guard |
| Case sets differ, or one side is empty | **refused** — existing behaviour |
| `abs(delta) < adjusted_resolution` | **inconclusive** — was `detectable_delta` |
| No discordant pairs, or `p >= corrected alpha` | **inconclusive** — existing behaviour |
| otherwise | improved / regressed |

`compare()` stops accepting a `detectors_equalized` argument and starts accepting both runs'
recall blocks. That is a breaking change to an internal signature and needs no contract bump.

## Verification

Measured by exit code, never by grepping output, always with a no-op control — and every
anchor asserted to have applied.

**Mutations against the equalization machinery:**

1. A probe's `mutate` becomes a no-op → recall 0 → build fails
2. A probe is deleted → its detector has no probes → coverage rule fails
3. `gap_bound` hardcoded to 1.0 → the artifact guard goes vacuous
4. `effective_recall` uses `max` instead of `min` → requires heterogeneous recalls to catch
5. `adjusted_resolution` flips to the de-attenuating direction
6. `probe_corpus_version` mismatch ignored
7. A detector rewritten to fire unconditionally → `substrates: 0` → refusal, not a silent 1.0

**The acceptance test.** Construct two configurations whose *true* failure rates are identical
but whose detector recall differs. Today's comparator reports a confident delta. The new one
must **refuse**. This is the JSON-enforcement artifact rebuilt in miniature — the finding that
motivated ADR-0008 — turned into a test that fails if this work is ever undone.

**The exit-gate test.** A second configuration carrying a deliberately worse prompt is
compared against the baseline over `compile-smoke`, and the comparison reports `regressed`
with a significance result and equalization evidence attached.

**The worse prompt must break at least six of the eight cases.** Exact-binomial McNemar over
one-directional discordant pairs at eight cases gives:

| flips | 4 | 5 | **6** | 7 | 8 |
|---|---|---|---|---|---|
| p | 0.125 | 0.0625 | **0.03125** | 0.0156 | 0.0078 |

Five flips yield p = 0.0625 and do not clear α = 0.05. A merely mediocre prompt therefore
returns `inconclusive`, which is the harness behaving correctly and will read as the harness
being broken to anyone who has not been told. This is not a detail of the test — it is what
an eight-case suite *is*: an instrument that detects catastrophic regressions and nothing
subtler. Anything finer needs the anchor suite and its roughly 3,400 items.

## Known bounds

**Recall is measured against what we thought to mutate.** The probe corpus is a registry and
carries the same "the list is the ceiling" risk as the detector registry — the risk that
registry exists to mitigate elsewhere. This design does not solve it. It makes the number
honest about its provenance through `probe_corpus_version`, and the independent second checker
— a labeled corpus of real outputs — remains deferred behind the live-provider path.

The repository's strongest observed pattern applies and is not yet satisfied here: every
defect of consequence was caught by an **independent second checker**, never by making the
first stricter. Mutation-derived recall is one checker. It should not be described as two.

**Precision is assumed, not measured.** The arithmetic assumes precision 1 on constructed
properties. `substrates: 0` catches the degenerate always-fires case, but a detector with a
moderate false-positive rate would pass everything here. Measuring precision needs negatives
that are *known* clean, which is the labeled-corpus problem again.

**This remains a pipeline suite, not a model evaluation.** Eight cases is three orders of
magnitude below the roughly 3,400 items the sizing rule requires to certify a promotion. A
green run here is never evidence about a model.

## As built

Three departures from the text above, recorded rather than silently absorbed.

**1. The suite grew from 8 cases to 14.** Not anticipated here, and forced by this document's
own arithmetic. Only *four* of the original eight cases could be flipped by a prompt change —
the two demo-mode cases, `provenance-is-complete` and `gates-actually-run` do not depend on
pinned content at all. Four flips is p = 0.125, so the exit gate was unreachable at eight
cases no matter how the worse prompt was written.

Disabling gates in the degraded configuration would have flipped five, still short at
p = 0.0625, and would additionally have made `gate-verdict` fire on every outcome —
`substrates: 0`, `recall: null`, and a correct refusal. The design defeats that shortcut,
which is a good sign for the design and a dead end for the test.

The six added cases are the edge-case categories the original eight skipped: placeholders,
leaked secrets, delimiter-lookalike text, empty input, Unicode with CRLF. They are worth
having on their own terms; reaching the exit gate is a consequence of coverage that should
have existed anyway, not the reason for it.

**2. `equalization`'s numeric fields are nullable.** The schema requires `equalization` on
every comparison, including refusals — but a refusal for *missing* recall cannot compute a
gap, an effective recall, or an adjusted resolution. The spec implied concrete numbers.
Forcing a value there would mean inventing one, which is the failure this subsystem exists to
prevent, so `max_gap`, `effective_recall` and `adjusted_resolution` are `number | null`.
`gap_bound` stays non-null because it comes from the suite and is always known.

**3. `control_fired` became `substrates`** — already argued in Section 3, restated here
because the field list in Section 4 was written before that argument.

### Measured recall, as it currently stands

All ten detectors measure **recall 1.0** against the corpus, on both configurations. That is
the honest number and it is worth being precise about what it means: these detectors catch
everything *we thought to plant*. It is not a claim they catch everything, and the figure will
drop the first time a probe is added for a case somebody missed. The `probe_corpus_version`
field exists so that drop is visible as a corpus change rather than a mystery.

Because recall is uniformly 1.0, `effective_recall` is 1 and `adjusted_resolution` equals the
declared `detectable_delta` — so the attenuation machinery is presently inert in production.
It is exercised in tests, including the acceptance test, which is the right place for a path
that only opens when an instrument degrades.

## Consequences

**Easier.** Comparisons become possible at all — the comparator currently refuses every one.
Phase 2b's exit gate becomes reachable. A dead detector, previously invisible behind a passing
suite, now fails the build.

**Harder.** Every new detector needs a probe before it can be used in a comparison. Adding a
blunt detector visibly degrades the suite's stated resolution, which is intended.

**To revisit.** Precision measurement, the labeled corpus, and per-case rather than minimum
attenuation — all of which need outputs the live-provider path has not yet produced.
