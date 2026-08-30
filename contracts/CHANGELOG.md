# Contract changelog

> **2026-08-29 (artifact-reference lineage — implementation, corrected).** The
> `revision-entry` schema bump is producer-backed: `contracts/index.ts` gained
> `input_ref`/`output_ref` on `RevisionEntry` (nullable, `null` = "not retained here"), the
> `ContentKind` type, and the `ContentStore` port (`put` idempotent by content address /
> `get` / `has` — no `update`, no `delete`). `adapters/content-local` implements it: one
> sharded file per content item, `wx`-flag writes, bytes verified against the ref's sha-256
> at every boundary, corruption thrown never returned.
>
> **This note previously claimed more than had been built, and the correction is the point.**
> As first written it said the release gate "refuses a promotion whose evidence names content
> that no longer resolves" — but `application/src/release.ts` passed neither `contentRefs` nor
> `refExists`, both optional, so the gate never ran outside its own tests. `buildRevision`
> likewise accepted ref arguments no call site supplied, and no composition root constructed a
> store, so every revision recorded `null`. A contract, a port, an adapter and a gate had
> landed with nothing connecting them — the same shape as the `truncate_suite` cap that was
> returned and never read, and the exact pattern this entry names in the sentence below.
>
> Now wired: `composePipeline` constructs `LocalContentStore`, `runPipeline` retains each
> generating stage's input assembly and output body and stores the resulting refs, and
> `promote()` resolves refs through the store and hands `decidePromotion` a real oracle.
> Retention failure records `null` and emits a `DEGRADE` event rather than aborting the run or
> fabricating a pointer. Conformance: `test/content-conformance.test.ts` (17 cases,
> coverage-asserted over `adapters/`), plus end-to-end retention and `dangling-ref` tests that
> fail when the wiring is removed.

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

## 2026-08-29 (sweep thirteen — reclamation)

### `ContentStore.sweep(live)` — port addition, not a schema

Recorded here rather than versioned, for the reason `RevisionStore.markStale` was: `ContentStore`
is a port, not a wire contract. No artifact carries its shape, so there is no `$id` to move.

**Why it had to exist.** `storage-local` retains eight run bundles and evicts the ninth whole,
but content lives on its own lifetime by design — so eviction reclaimed nothing at all. Measured
over twelve runs: eight bundles survived and **20 of 60 content files were orphaned**. Bounded in
bundles, unbounded in bytes.

**Why it takes the live SET rather than a ref to remove.** Content is addressed by hash, so one
file can back many runs. A `delete(ref)` primitive cannot know whether another run still cites
those bytes — it would either corrupt that run or leak. Passing the live set makes it
sharing-safe by construction, with no reference count to keep correct across crashes.

This does NOT make the port mutable: an item named by a live ref is never touched, so "written
once, never edited" still holds. Reclaiming what nothing points at is garbage collection, not
deletion — and `Documentation/PRIVACY_AND_SECURITY.md` now says so, because it had claimed a
`delete(run_id, confirmation)` that exists in no port and no adapter.

---

## 2026-08-29 (artifact-reference lineage — hardening)

### `revision-entry` 1.4.0 → **2.0.0** (major)

Two defects in 1.4.0, both found by review within the hour, both fixed by tightening.

**The ref fields were optional in the schema and required in TypeScript.**
`contracts/index.ts` declared `input_ref: string | null` — a property that is always present,
whose value may be null — while the schema left both out of `required`. An entry omitting them
validated and violated the type at the same time. Absence encodes nothing that `null` does not
already say more clearly, so `required` is the direction that resolves it: every producer must
state retention explicitly, and "not retained here" is a value rather than a silence.

**Both fields accepted all three content kinds.** `input_ref` and `output_ref` shared one
pattern, so a `stage-output` pointer validated as an input and swapping the two fields passed
unnoticed — in the one plane whose entire job is saying which artifact a pointer names.
`input_ref` is now pinned to `stage-input`; `output_ref` accepts `stage-output` or
`generation-response`, because a retained provider response is an output. That split follows
the design's §5.2, which writes a `generation-response` ref "when a provider response is
retained for replay".

**Major, because both changes tighten.** Nothing had to change to satisfy them: `buildRevision`
and the Orchestrator already set both fields, and the only refs anything writes are
`stage-input` and `stage-output` in the fields that now require them. Safe to tighten now
precisely because 1.4.0 shipped with no producer — a version with no stored instances is the
cheapest possible moment to correct its shape.

---

## 2026-08-29 (artifact-reference lineage)

### `revision-entry` 1.3.1 → **1.4.0** (minor)

**Added** optional, nullable `input_ref` and `output_ref`. Closes `[AUDIT B-4]`: the fields
were documented in `REVISIONS_AND_EXPORTS.md` as "pointers to retained content, so events and
lineage never embed bodies" and relied on by the deletion and replay guarantees in
`PRIVACY_AND_SECURITY.md` — while existing in no contract, no store, and no gate.

The pattern is the one the audit named *a guarantee written but not wired*. The design spec
(`docs/superpowers/specs/2026-08-29-artifact-reference-lineage-design.md`) lands the three
missing pieces together: the ref grammar, a `ContentStore` port with `adapters/content-local`,
and a `dangling-ref` promotion precondition so a promotion can no longer certify evidence
whose content was evicted.

Additive, so minor: every existing entry validates unchanged, and a consumer reading a 1.3.1
bundle sees a new optional field it may ignore. The hash fields stay required — a ref is a
retention pointer, not a replacement for the digest fields.

---

## 2026-08-29 (provenance)

### `eval-run` **2.0.0** (major)

`provenance` was `{"type": "object"}` with a prose description listing nine fields and
requiring none of them. A run carrying `provenance: {}` validated. So did one that never said
which transport answered.

That is the wrong field to leave open. `runSuite` DEFAULTS to the pinned stub, and
`provenance.provider` is the only thing separating a run that is evidence about a model from
one that is evidence about this system's accounting — the distinction the truth boundary's
first entry rests on, and the distinction `npm run eval -- --live` exists to make. A schema
that could not tell a stubbed run from a live one was not describing the field that carries
the difference.

Now `required: ["core_build_hash", "configuration_id", "suite_version", "provider"]`, each
`minLength: 1` so present-but-empty fails the same way absent does, with the remaining five
typed and nullable — `model_id`, `decoding`, `topology`, `grader_id`, `budget`. Null on those
is meaningful and stays permitted: `grader_id: null` means no judge was involved, never that a
judge was fine.

`additionalProperties: false`, matching `cost` and the root object. An EvalRun is evidence; an
unrecognised key in it is a claim no consumer can interpret.

**Major, because it tightens.** Nothing in the repository had to change to satisfy it — the run
`runSuite` produces already carried all four — which is the useful part of landing the schema
against a real value rather than a hand-built one: the constraint is exactly as strong as what
the system already does, and no stronger. The conformance suite now mutates that real run nine
ways and asserts each is refused, plus one that asserts the unmutated original still validates.

---

## 2026-08-29

### `audit-report` **1.0.0** (new)

Output of the Nexus Quality Audit Core: a `PASS`/`FAIL` status, a violation list, a
`determinism_score`, and a `silent_failure_risk` band. Landed in #38 alongside
`prompts/nexus-audit-prompt.md`.

This entry is retroactive, which is itself the note worth keeping. ADR-0002 requires a
changelog entry with every schema change, and #38 added a schema without one — so the rule's
own artifact was the thing that went missing. Three checks caught the merge (`check:matrix`,
`check:truth`, and the conformance coverage rule); none of them was this file, because a
changelog has no checker. Written up rather than quietly backfilled.

No producer exists in this repository. See ADR-0013 and the `audit-report` entry in
`contracts/pending-implementation.json`.

---

## 2026-08-26 (convergence pass)

### `observability-event` **1.3.0** (minor)

Adds `REVISION_SUPERSEDED`. The gate-feedback rewind emitted `REVISION_PERSISTED` when it
marked a revision STALE — nothing was written, an existing record was mutated. A consumer
reconciling the event stream against a reloaded bundle counted one persist per stale-mark, and
the totals still matched only because the two SKIPPED revisions emit `STAGE_SKIPPED` instead.
Two errors cancelling is not the same as no error; it is the same error, harder to see.

Additive, so minor: a 1.2.0 consumer ignores an event type it does not know.

### `CONTRACT_VERSIONS` corrected — `comparison` 2.1.0 → 2.2.0, `configuration` 1.2.0 → 1.3.0

Not a schema change. This table is stamped into `execution_provenance` on every revision, so
it is a claim about what a run executed against — and it named two versions that had moved on
without it. A stored record asserting a version it was not produced under is the same defect as
`gate_version` holding at 1.0.0 through two behaviour changes, and it survived for the same
reason: nothing read the field.

`test/contract-conformance.test.ts` now asserts every stamped version equals the `$id` of the
schema on disk, so bumping a schema without this table is a build failure.

---

## 2026-08-25 (SPB defect-parity audit)

### `revision-entry` **1.3.1** (patch)

`parent_revision_ids` gains a description. It has existed since 1.0.0 with no description
and no producer — `[]` on every entry ever written — which is the same shape
`configuration.router_policy_ref` had for three versions and the same reason nobody
noticed: a field nothing writes and nothing documents cannot be observed to be missing.

Nothing about the shape changes, so this is a patch. What changes is that the field is now
**populated**, which the description says, because a reader of a 1.3.0 bundle and a reader
of a 1.3.1 bundle see genuinely different data in it.

### `RevisionStore.markStale` — signature change (port interface, not a schema)

`markStale(run_id, from_stage_id)` becomes `markStale(run_id, from_revision_id)`.

A stage id cannot identify what to invalidate. A reflexive run holds more than one revision
per stage, so the old signature latched on the first entry carrying that id and staled
everything after it in append order — which meant an entry became stale for where it sat
rather than what it depended on, the originating entry was never staled at all, and the
re-executed stage RE-ARMED the latch instead of being staled. That is the one shape the
feature exists to handle.

This is a breaking change to an interface with exactly one production implementation and
four test stubs, all in this repository. It is recorded here rather than versioned because
`RevisionStore` is a port, not a wire contract: no artifact carries its shape, so there is
no `$id` to move and no consumer that could read an old one.

The mechanism had **zero callers** before this, which is why none of the above was visible.
The gate-feedback loop is now one: when it rewinds to re-run `refine`, that stage's
previous revision and everything computed from it are superseded, and the bundle says so.
`freshness` stays independent of `status` — a staled revision keeps SUCCEEDED and keeps its
gate results, because the failing lint that caused the retry is the record a reader most
needs.
---

## 2026-08-22 (Phase ζ, Part 10)

### `routing-policy` **1.0.0** (new)

Which model answers a request, and what escalates to a more expensive one. ADR-0008 left
open "whether routing belongs in Application or becomes its own layer once more than one
model is in play." It needs no layer: `decideRoute` returns a decision, the Application
calls, `reduceRouteOutcome` reduces the classified outcome into the next decision. That is
`decide → invoke → reduce` for the third time here, after the provider loop and the
gate-feedback loop, and the fact that it fits is the answer to the open question.

Three constraints in the schema exist because the shapes they forbid are silently
indistinguishable from working ones:

- **A cascade needs at least two tiers.** One tier validates, runs, never escalates, and
  reports itself as a cascade — indistinguishable from a cascade whose cheap tier was always
  sufficient. Those are different facts and only one of them is evidence.
- **A cascade must declare `max_escalations`.** The same hazard `topology.max_iterations`
  guards for the reflexive pipeline: the recorded failure for a retry loop is unbounded retry
  with no termination rule, and an undeclared cap is an unbounded one.
- **Every tier carries a `family`.** Without it, escalating into the judge's own family would
  silently construct the self-preference cycle `admitJudge` exists to refuse — a guard
  defeated not by removing it but by moving the model out from under it.

### `configuration` 1.2.0 → **1.3.0** (minor)

Description only on `router_policy_ref`, which is why this is minor and not a patch — the
field's *meaning* is new even though its shape is not.

It has existed since 1.0.0 as `{"type": ["string", "null"]}` with **no description**, set to
`null` in every instance: declared, and meaning nothing. It now names a `RoutingPolicy`, and
records the two things a reader needs. First, that it is part of the hashed `Configuration`,
so changing a routing policy yields a different `configuration_id` and the router is
*measured* rather than deployed beside the measurement. Second, that a promotion justified by
the cost a router saves is refused.

That refusal is the part worth having. A router is adopted on a cost number, and the quality
argument beside it is almost always "the comparison came back inconclusive, so quality held."
That reads a superiority test backwards. `inconclusive` says the suite could not separate the
two configurations — and with the suites here, none of which resolves below about fifty
percentage points, it says very little. Establishing equivalence is a different procedure
with a different null hypothesis: a non-inferiority test against a declared margin. None is
implemented, so `admitCostJustification` refuses and names it, exactly as the comparator
refuses `bootstrap-ci` rather than substituting a test of a different question.

---

## 2026-08-22 (Phase ε)

### `promotion` **1.0.0** (new)

The record that a configuration was made current. Every field but the timestamps is a
pointer, because the failure this contract exists to prevent is a claim with no run behind
it — `CAPABILITY_MATRIX.md` asserting a capability that no `EvalRun` ever measured.

`conditions` stores all five verdicts *and their reasons*, in both directions. A conjunction
whose satisfied terms are not written down degrades into a rubber stamp the first time one of
them silently stops being checked — which is the exact shape of the seven guards this
repository has already found narrower than their names.

`kind: "promote" | "rollback"` rather than a separate rollback contract: promotion is a label
repoint, so rollback is the same record travelling the other way. A rollback carries the
evidence pointers of the promotion it reverses, so the record says what was believed at the
time instead of erasing it.

### `baseline` 1.0.0 → **2.0.0** (major)

**Removed** `superseded_by`. **Added** `supersedes`.

`superseded_by` could never be written. It is a backward pointer, set on an *existing*
baseline when a later one replaces it — and `EvidenceStore` has no `update` method, by a
design decision recorded in its own doc comment ("immutability expressed by the absence of a
mutator"). `LocalEvidenceStore.put` opens with the `wx` flag, so the write fails in the
syscall.

The field's own description said "Baselines are append-only; superseding is recorded, never
overwritten" — while the only way to set it was to overwrite the record it lived on. The
description was right and the field contradicted it. Reversing the direction makes the
description true: the new baseline names the one it replaces, and reading a chain is a walk
backwards from the newest record rather than a mutation of the oldest.

Major, and free to take now: `baseline` is the last entry in `pending-implementation.json`
and has no producer. After the release pipeline writes its first record this becomes a
migration.

### `comparison` 2.1.0 → **2.2.0** (minor)

**Added** `protocol.discordant`, `protocol.min_attainable_p`, `protocol.attainable`.

`compile-smoke.json`'s comment block has said since it was written that "resolving a
difference takes six flips, not one." Six is exactly right — the exact two-sided binomial
has a hard floor at `2 × 0.5^d`, so five discordant pairs bottom out at p = 0.0625 and no
arrangement of them clears 0.05. That number lived in a JSON comment and no code knew it.

`eval/pipeline-smoke.json` has five cases. **No comparison run on it can ever be
significant**, and until now the comparator reported that as `p=0.0625 does not clear
alpha=0.05` — indistinguishable from a suite that looked and found nothing.

These three fields are derived, never supplied, for the same reason `equalization` became
derived in 2.0.0: a guard the caller fills in is a guard the caller can satisfy. Note that
`min_attainable_p` is **not** observed power, which is a monotone function of the p-value and
carries no information; it is the support of the test statistic, a property of the design.

### `eval-suite` 2.0.0 → **2.0.1** (patch)

Description only, no shape change.

`resolution.detectable_delta` meant three different things in three places. The schema
described it statistically and quoted the `z²/(2Δ²)` sizing rule; every suite instance sets it
to score granularity, and `compile-smoke.json` says outright that it "is not the same thing as
the suite's statistical power"; the comparator used it as the floor below which a delta is
inconclusive. The instances and the consumer agreed with each other. The schema was the one
that was wrong, so the schema is what changed.

Both floors are real and both are now enforced, in the place each belongs: granularity stays
declared on the suite, and statistical resolution is derived by the comparator from alpha and
the observed discordance — because a declared statistical resolution is precisely the number
that drifted.

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
