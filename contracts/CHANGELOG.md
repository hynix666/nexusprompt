# Contract changelog

[ADR-0002](../Documentation/0002-contract-first-design.md) requires a version bump **and a
changelog entry** for every schema change. Versions have always lived in each schema's `$id`;
the changelog half had no artifact behind it until 2026-08-18. This file is that artifact.

Entries are newest first. A schema's version lives in its `$id` and is the authority — this
file records *why* a version moved, which the `$id` cannot.

Versioning, as applied here:

- **major** — a consumer reading the old shape breaks. Removing a field, tightening a type,
  making an optional field required.
- **minor** — additive. A new optional field; a widened enum.
- **patch** — wording only. Descriptions, examples, `$comment`. No shape change.

---

## 2026-08-22 (Phase δ)

### `eval-suite` 1.0.0 → **2.0.0** (major)

**Added** `significance_protocol`, **required**.

Major because a suite without it no longer validates, and that is deliberate. ADR-0008 left
"record the significance protocol per suite type before running comparisons that anyone will
cite" open; an optional field would have left it open. Every existing suite declares
`exact-mcnemar`, which is correct for all three of them today and stops being correct the
moment a perturbation expansion is applied to any of them.

### `eval-case` 1.0.0 → **1.2.0** (minor, twice)

**Added** `cluster_id`. **Enumerated** `failure_mode`.

`cluster_id` is written by the perturbation expander and never by a suite author: clustering
assigned by hand would make every downstream confidence figure depend on how someone chose to
group cases, so two suites with identical cases could report different certainty. Absent means
the case is its own cluster, which is what an unperturbed case is — so nothing existing changes.

`failure_mode` was an unconstrained string in the schema while the TypeScript binding
enumerated fifteen modes. Two invented modes validated cleanly against the contract that is
supposed to be authoritative over the type. Now they do not.

### `comparison` 2.0.0 → **2.1.0** (minor)

**Added** `clustered-paired` to the test enum, and `effective_n`.

`effective_n` is the number of INDEPENDENT units behind a p-value, which stops equalling the
case count the moment perturbations group cases. Seventy rows over fourteen briefs is fourteen
questions asked five ways; reporting the seventy is what makes a p-value smaller than the
evidence supports, in the direction that manufactures a promotion.

### `judge-verdict` 1.0.0 → **1.1.0** (minor)

**Added** `judge_family` (required) and `bias_panel`. **Made** `agreement.measured_at` required.

`judge_id` was a free-form string, so "the judge is never the model under test" — listed under
ADR-0008's Enforcement — could not be checked by anything. Current practice names five judge
biases; this schema mandated position randomization and chance-corrected agreement, covering
two, and had no field for verbosity, format or self-preference. A verdict could satisfy every
requirement and come from a judge that rewards length.

`measured_at` was optional, which made the staleness rule unenforceable: an agreement figure
with no date cannot be checked against the judge contract's last change.

**Removed** the `judge-verdict` entry from `pending-implementation.json`. The adapter exists and
the schema now has a conformance case. Landing the schema first worked as intended — `runs`,
`disagreement_rate`, `position_randomized` and a declared threshold were mandatory before
anyone wrote a judge that would otherwise have omitted them.

---

## 2026-08-22

### `configuration` 1.0.0 → **1.1.0** (minor)

**Enforced** `max_iterations` for reflexive topologies, via `if`/`then`.

The field's description already said "Required for reflexive topologies. The recorded hazard
for verification loops is unbounded retry with no termination rule." Nothing enforced it, so a
reflexive configuration with no termination rule validated cleanly — a rule stated more broadly
than implemented, which is one of the three defect classes this repository keeps finding. The
description is now a constraint.

Minor rather than major: no configuration that validated before and was *not* reflexive breaks,
and a reflexive one without a cap was never valid in intent.

### `configuration` 1.1.0 → **1.2.0** (minor)

**Added** `budget`.

`eval-run.cost.budget_exceeded` has been a required field since the schema landed and has
always held the literal `false`, because no configuration could declare a budget and nothing
could enforce one. ADR-0008 says budget "belongs in the request contract and is enforced, not
observed afterwards"; this is the half of that sentence that was missing.

`on_exceed` is required and has no default. Refusing before dispatch and truncating the suite
are both defensible, and a silent choice between them is the failure mode — a partially
executed suite is not an `EvalRun`, because its aggregate is a score over whichever cases
happened to fit, published under the name of a suite that means something else.

### `GenerationResult.usage` — **additive**, no schema (TypeScript port only)

**Added** `cache_read_tokens` and `cache_write_tokens`.

The only way to tell a working prompt cache from a silently invalidated one. Current provider
guidance is explicit that a zero cache-read across repeated identical prefixes means something
in the prefix is varying — a timestamp, a request id, an unsorted key. Estimating the figure
would hide exactly the failure it exists to expose, so it is reported or absent, never guessed.

### `revision-entry` 1.2.0 → **1.3.0** (minor)

**Added** `feedback_round`. **Clarified** `stage_attempt`.

Gate feedback re-executes `refine` and `lint`, so a bundle now holds each of them more than
once. Without a marker the second pair is distinguishable only by position — the same gap
`SKIPPED` closed one entry below, in mirror image: a bundle that is *longer* than the plan with
no record of why.

`stage_attempt` was left alone deliberately. It counts provider attempts within one execution,
which was a deliberate earlier fix ("hardcoding 1 made a revision claim one attempt and mean
three"), and re-pointing it at executions would have silently undone that. Two meanings for one
field is how the ambiguity started; the description now says which one this is.

### `observability-event` 1.1.0 → **1.2.0** (minor)

**Added** `GATE_FEEDBACK` to the `event_type` enum.

Routing a gate FAIL back to `refine` is neither a skip nor a degradation — nothing failed and
nothing was omitted. Reusing `DEGRADE` would have made every reflexive run look like a
degraded one, and `STAGE_DECISION` would have lost the reason.

---

## 2026-08-18

### `revision-entry` 1.1.0 → **1.2.0** (minor)

**Added** `SKIPPED` to the `status` enum.

A skipped stage was reported as an event and persisted as nothing — and events are not
persisted, revisions are. So a reloaded bundle could not distinguish "deliberately skipped"
from "never reached", which is the exact distinction `STAGE_SKIPPED` was added to the event
enum for one entry above. Any short run — a clean critique, LOW stakes, a degradation —
produced a short bundle with no record of why it was short.

`SKIPPED` is distinct from `CANCELLED`: cancelled means stopped, skipped means a decision
was taken not to run. The pipeline now appends a revision for every stage in the plan, so
the bundle is complete by construction rather than complete only on the happy path.

*Migration:* none. Additive to an enum; a consumer switching on `status` sees a new value,
which is why it was an enum rather than a free string.

### `observability-event` 1.0.0 → **1.1.0** (minor)

**Added** `STAGE_SKIPPED` to the `event_type` enum.

A skipped stage is a real thing the pipeline does and none of the eight existing types said
it. `DEGRADE` is wrong — a skip is a decision, not a failure — and leaving it unreported
would make "did not run" indistinguishable from "was never reached".

Found the worst way. The pipeline runner emitted events through
`sink.emit({ ... } as never)`, and that uncommented cast was hiding three violations at
once: the field is `event_type`, not `type`; five required fields were missing (`layer`,
`parent_event_id`, `schema_version` and the nullables); and `STAGE_SKIPPED` was not in the
enum. The conformance suite *does* validate events — but only ones the Orchestrator
produced, so nothing ever looked at the pipeline's. An escape hatch with no comment
justifying it turned out to be silencing exactly what it looked like it might be.

The cast is gone, the events are built from the contract shape, and a test now validates
every event a pipeline run emits against the required-field list and the enum.

*Migration:* none. Additive to an enum; existing consumers see a type they may not know,
which is why the field was an enum rather than a free string.

### `comparison` 1.0.0 → **2.0.0** (major)

**Removed** `detectors_equalized` (boolean). **Added** `equalization` (object), now required.

The boolean was never computed. Every occurrence carrying a value was a test, hardcoded
`true`; the runner never set it at all. So the comparator's strongest guard — the one that
makes it refuse rather than report a number — was a field the caller filled in.

`equalization` is derived from both runs' measured recall blocks and carries the evidence:
`max_gap`, the derived `gap_bound`, `effective_recall`, `adjusted_resolution`, and the
per-detector figures.

The boolean was deleted rather than kept alongside. Retaining it would have made this an
additive minor bump and left **two sources of truth for one fact**, one of them a summary
readable without consulting the evidence. That property — readable without being checked —
is what let the guard go unverified. Preserving it for compatibility would have preserved
the defect. Nothing outside this repository consumes these schemas.

*Migration:* replace `detectors_equalized: true` with the `equalization` object emitted by
`compare()`. Callers no longer pass equalization in; they pass both runs' `detector_recall`
blocks and the comparator derives it.

### `eval-run` 1.0.0 → **1.1.0** (minor)

**Added** optional, nullable `detector_recall`: per-detector `substrates`, `probes_run`,
`probes_detected`, `recall`, plus `probe_corpus_version`.

Recall is a property of **(detector, configuration)**, not of a detector alone — the finding
this whole change exists to encode. `eval-run` is where it belongs because a run already pins
the configuration, which makes a stale pairing structurally impossible.

Optional and nullable rather than required, so the bump stays additive. A run may legitimately
exist without recall; it simply cannot be *compared*, and the comparator enforces that. The
wording follows `grader_health`: absence is a known-unknown, never a pass.

`recall` is nullable because `probes_run` can be 0 when a run offers no substrate. Null means
*not measurable*; 0 means *measured and dead*. They take different paths — one refuses the
comparison, the other fails the build — and collapsing them would fail the build for the
wrong reason.

---

## Before 2026-08-18

No entries. Thirteen schemas landed across the contract-first work with version bumps recorded
only in their `$id`s. Reconstructing those entries after the fact would produce a changelog
asserting things nobody verified at the time, which is the failure mode this repository keeps
finding in its own documentation. The gap is left visible instead.
