# Brief-fidelity judge — design

**Status:** proposed, 3 September 2026; amended 3 September 2026 — storage target corrected from
"the run bundle" to the evidence plane after reading the actual storage adapters (see the
Storage section).
**Sub-project:** 3 of 3 (noise floor → provider-facing anchor → **judge**)
**Depends on:** `contracts/judge-verdict.schema.json` (1.1.0), `core/src/eval/judge-policy.ts`,
`application/src/judge.ts`, `adapters/evidence-local` — all pre-existing and unchanged by this
design.

## Goal

Give each pipeline run a per-run quality signal — brief fidelity — recorded as evidence
referencing that run, using the judge guardrails that already exist in this repository but have
never been given a real transport, a rubric, or a calibration.

This is explicitly **not** a model-comparison instrument. Sub-project 2 (the provider-facing
anchor) established that model comparison on this pipeline does not pay at any suite size worth
building (`docs/superpowers/plans/2026-09-03-brief-pilot-findings.md`). This sub-project answers
a different question: for one specific run, does the compiled prompt faithfully represent the
brief it was compiled from? That question is useful even with a single model and no comparison.

## What already exists, and why this spec is smaller than it looks

Grepping for `judge` before drafting this found substantially more built than the "judge and
judge validation" line in the noise-floor spec suggested:

- **`contracts/judge-verdict.schema.json`** (1.1.0) — `JudgeRequest`/`JudgeVerdict`/
  `JudgeTransport`, encoding hard-won judge-reliability research: `judge_id` + `judge_family`
  (so self-grading is detectable), `rubric_id` + `rubric_hash` (pinned rubric identity),
  `runs` + `disagreement_rate` (single-run verdicts are refused as noise dressed as signal),
  `position_randomized`, and `agreement` (chance-corrected, named reference, per-rubric
  threshold).
- **`core/src/eval/judge-policy.ts`** — `admitJudge()`, pure, Core-side. Refuses self-preference
  (judge family equals candidate family — a cycle in the grading order), refuses
  verifier-checkable cases (151 of 195 catalog techniques never reach a judge at all), refuses
  missing, stale, expired, or below-threshold calibration.
- **`application/src/judge.ts`** — `GuardedJudge`. Fences the candidate in a content-derived
  delimiter nonce before it reaches a transport (the judge's input contains the model's own
  output, so it is a prompt-injection surface with the attacker already inside the loop), runs
  the `DELIMITER_ENTROPY` gate on the constructed judge prompt itself, calls `admitJudge` before
  ever invoking the transport.
- Full test coverage for all of the above, against `ScriptedJudge` — a test-only stub. The test
  file says plainly: "what is under test is the policy and the guarding, not any model's
  judgement."

**What is missing, confirmed by grep — nothing else references these:**

1. No real `JudgeTransport`. Only the test stub exists.
2. No rubric. `rubric_id`/`rubric_template` are caller-supplied strings with no authored content.
3. No real `Calibration`. `admitJudge` hard-refuses without one, and the architecture's own
   comments call for human-labeled calibration, re-measured on a cadence.
4. No wiring — no command, nothing connects a run bundle to `grade()`, nothing records a verdict
   anywhere.
5. A shape mismatch — `JudgeVerdict.verdict` is a single scalar; a multi-dimension rubric
   breakdown does not fit it without an additive schema change.

This spec builds exactly those five things, plus one more surfaced while checking how a verdict
could actually be stored (see Storage below): a new evidence kind. Core purity and the
Application guard are untouched.

## Storage: the evidence plane, not the run bundle

The original draft of this spec said the judge "writes into the existing bundle." Reading
`adapters/storage-local/src/index.ts` and `adapters/evidence-local/src/index.ts` before planning
showed that is not possible under either storage mode a run can be in:

- **Legacy bundles** (`<run_id>.json`) grow only through `append()`, which takes a
  `RevisionEntry` — a *stage execution*, with `stage_id`, `gate_results`, `execution_provenance`.
  A judgement is not a stage; forcing it into that shape would corrupt what a `RevisionEntry`
  means.
- **Semantic manifests** (`<run_id>.manifest.json`) are hard-immutable once published — committed
  via an exclusive `link()`, and `markStale` explicitly refuses to touch one ("immutable
  manifest ... would mutate committed history"). There is no write path into a published
  manifest at all.

The actual fit is `adapters/evidence-local` — the same evidence plane CLAUDE.md already
documents as having "no `update`, and that is load-bearing." It holds one immutable file per
record (`EvidenceStore.put`, exclusive `wx` write, refuses to overwrite), currently for
`EvidenceKind = "eval-run" | "comparison" | "baseline" | "promotion"`, each record referencing a
run rather than being embedded in it (`Baseline.run_id`, `Comparison.candidate_run_id`). A
judgement is exactly this shape: evidence *about* a run, not part of the run's own record.

This adds `"judgement"` as a fifth `EvidenceKind` and means **a run can carry zero, one, or many
judgement records** — judging the same bundle twice produces a second, independently-dated
record rather than requiring an overwrite. That fits the evidence plane's existing philosophy
("a re-run is a new run: give it a new id") and is arguably more honest given the judge itself is
stochastic: repeated judgements of one run are visible disagreement, not a state to prevent.

This drops the "already judged, use `--force`" refusal from the original draft entirely — there
is nothing to overwrite, so nothing to force.

## Scope

**In:** a brief-fidelity rubric (four dimensions), a candidate-construction helper, a hosted
`JudgeTransport` adapter, a mutation-derived calibration (with its own ADR for the divergence
from human-labeled calibration), an additive schema bump for the rubric breakdown, a new
`judgement` evidence kind and its wrapper schema, and a post-processing `npm run judge` command
that reads a bundle and records a judgement evidence record referencing it.

**Out:** any change to `core/src/eval/judge-policy.ts` or `application/src/judge.ts` — both are
correct and tested as they stand. Any use of the judge for model comparison (that is
sub-project 2's question and it is closed). Any rubric other than brief fidelity. Human-labeled
calibration (explicitly deferred — see the Calibration section).

## Architecture

```
npm run judge -- --bundle <path>
       │
       v
scripts/judge.ts                 reads bundle: brief, final compiled prompt, provenance
       │
       v
core/src/eval/brief-fidelity.ts  (new, pure) — the rubric_template text and
                                   buildFidelityCandidate(brief, compiledPrompt)
       │
       v
application/src/judge.ts         (existing, unchanged) — GuardedJudge.grade()
       │                          admitJudge() refuses first; see Error handling
       v
adapters/provider-hosted-judge/  (new) — implements JudgeTransport, wraps the
                                   existing hosted provider client (the one --live already uses)
       │
       v
adapters/evidence-local          (existing store, new EvidenceKind) — put() writes a
                                   judgement record: { judgement_id, run_id, created_at, verdict }
```

`candidate_family` for the admission check comes from the bundle's own provenance
(`provider_model_fingerprint`) — this is what makes self-preference detection meaningful: a
judge from the same model family that produced the compiled prompt is refused by code that
already exists and is already tested, not by anything new here.

`verification_status` is always `"judge-checkable"`. Brief fidelity is exactly the class
`admitJudge` was built to route to a judge — a deterministic detector cannot settle whether a
compiled prompt represents a brief's intent.

## The rubric: four dimensions, scored 0–3

| Score | domain_captured | constraints_honored | completeness | no_overreach |
|---|---|---|---|---|
| 0 | Wrong domain entirely | Constraints ignored or violated | Major requirements missing | Significant unrequested additions |
| 1 | Domain vaguely or partially captured | Most constraints missed | Some requirements covered | Some unrequested additions |
| 2 | Domain captured with minor gaps | Most constraints honored, minor gaps | Most requirements covered | Minor unrequested additions |
| 3 | Domain fully and precisely captured | All explicit constraints honored | All requirements covered | No unrequested additions |

`core/src/eval/brief-fidelity.ts` exports this table as `rubric_template` text (pure, no I/O)
requesting structured JSON output matching the schema's `rubric_breakdown` shape (below), via
the provider's structured-output mode rather than free-text parsing.

## Candidate construction

`buildFidelityCandidate(brief, compiledPrompt)` fences each piece separately with its own
content-derived nonce (reusing `fenceCandidate`'s scheme, called twice), labels them, and
concatenates:

```
ORIGINAL BRIEF:
<<CANDIDATE a1b2...>>
...brief text...
<<END CANDIDATE a1b2...>>

COMPILED PROMPT (grade this for fidelity to the brief above):
<<CANDIDATE c3d4...>>
...compiled prompt text...
<<END CANDIDATE c3d4...>>
```

That combined text becomes the single `candidate` passed into `GradeRequest`.
`GuardedJudge.grade()`'s existing fencing wraps it once more with an outer nonce, unchanged —
brief fidelity is simply a new caller of code that already defends against the candidate forging
its own delimiter.

## Calibration: mutation-derived, and the divergence this creates

`admitJudge` requires a `Calibration` — a chance-corrected agreement value against a named
reference, or it refuses with `no-calibration`. The architecture's own comments call for this to
be **human labels**, re-measured on a cadence. This spec does not build that. It computes Cohen's
kappa between the judge's classifications and a **mutation-derived** reference instead.

**Why:** human annotation infrastructure does not exist in this repository, and building it is a
substantially larger undertaking than the judge itself. Mutation-derived ground truth reuses the
discipline `core/src/eval/anchor.ts` already established for gate recall — a label is *derived*
from an injected, known change rather than authored by a person, and kept only when it isolates
cleanly.

**How it is measured:**

1. `eval/judge-validation-fixtures.json` — hand-authored (not generated; see below), **12** clean
   `(brief, compiled_prompt)` pairs, each with four single-dimension mutations (wrong domain,
   dropped constraint, added unrequested feature, missing requirement) — 48 mutated fixtures,
   60 judged calls total for the one-time measurement. Each fixture contributes a known expected
   label for all four dimensions: the targeted dimension expects "degraded," the other three
   (and all four on a clean pair) expect "clean," giving 240 labelled dimension-instances for
   the kappa computation.
2. A mutation is kept in the suite only if it **isolates**: the targeted dimension's score drops
   by ≥2 points from the clean baseline, and the other three stay within 1 point of it. A
   mutation that depresses more than one dimension is dropped, not force-fit — the same rule the
   anchor uses when an injected fragment fires more than one gate.
3. For each surviving fixture, each dimension's judge score is binarized (≤1 = degraded, else
   clean) and compared against the mutation's authored label (which dimension it targets).
4. Cohen's kappa between judge classification and mutation label becomes `Calibration.value`.
   `reference: "mutation-derived-v1"` — not a name implying human origin. `threshold: 0.60`,
   the lower end of reported practice — this signal is stored for debugging, not for gating a
   release, so the more conservative 0.85+ floor reserved for high-cost verdicts does not apply.
   `max_age_days: 30`: the reference set is static, but the hosted model behind it is not — a
   provider can change the model silently, so the cadence still guards against drift.

**Why hand-authored, not generated:** the anchor generates cases because a gate trigger is
structural (inject a fragment, check if a gate fires). A rubric mutation is semantic — "swap the
domain," "drop a named constraint" — and proceduralizing that would require a domain model of
brief content the pipeline does not have.

**ADR-0016** records this divergence explicitly: what the architecture's comments call for
(human labels), what was built instead (mutation-derived kappa), why (cost — no annotation
infrastructure exists; mutation-derived ground truth is cheap and reuses an existing pattern),
and what this does **not** establish. This is the same shape as the differential oracle's
divergence-allowlist entries (ADR-0010, ADR-0011): a declared difference with a reason, not a
silently accepted gap.

`eval/judge-calibration.json` holds the one-time measurement — dated, not re-derivable, same
shape as `eval/noise-floor.json` and `scripts/model-fingerprints.json`.

## Contract schema: judge-verdict 1.1.0 → 1.2.0

`verdict` (`string | number | boolean`) cannot hold four per-dimension scores, and packing them
into `rationale` as unstructured text would make the isolation check in `check:judge` parse a
string it should be reading as data. One additive, optional field:

```json
"rubric_breakdown": {
  "type": ["object", "null"],
  "description": "Optional per-dimension scores for a rubric that grades more than one axis. Null when verdict is a single scalar.",
  "additionalProperties": {
    "type": "object",
    "required": ["score", "reason"],
    "properties": { "score": { "type": "number" }, "reason": { "type": "string" } },
    "additionalProperties": false
  }
}
```

Generic — not hardcoded to the four brief-fidelity dimensions — so it stays reusable by any
future rubric. `verdict` carries the overall score (sum, 0–12) for anything reading `verdict`
alone. This lands as its own reviewed PR with the version bump, before any judge code, matching
the rule that shipped `judge-verdict` 1.0.0 before the adapter existed.

## Contract schema: a new `judgement` wrapper, 1.0.0

`judge-verdict` stays a general grading contract — it grades any candidate against any rubric,
independent of the pipeline concept of a "run," and that generality is deliberate (it also
covers catalog-technique grading, unrelated to this sub-project). Tying a `run_id` into it would
couple a general contract to one caller. Instead, `contracts/judgement.schema.json` (1.0.0) is a
thin wrapper, the evidence body for the new `"judgement"` kind:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://promptnexus.dev/contracts/judgement/1.0.0",
  "title": "Judgement",
  "description": "One judge grading of one run, recorded as evidence. A run may have zero, one, or many judgements.",
  "type": "object",
  "required": ["judgement_id", "run_id", "created_at", "verdict"],
  "additionalProperties": false,
  "properties": {
    "judgement_id": { "type": "string", "minLength": 1 },
    "run_id": { "type": "string", "minLength": 1 },
    "created_at": { "type": "string", "format": "date-time" },
    "verdict": { "$ref": "https://promptnexus.dev/contracts/judge-verdict/1.2.0" }
  }
}
```

`EvidenceKind` (`contracts/index.ts`) gains `"judgement"` as a fifth variant, and
`adapters/evidence-local/src/index.ts`'s `KINDS` array gains the matching entry. `judgement_id`
is freshly generated per judging call (not derived from `run_id`), which is what makes repeated
judgements of one run coexist as separate records rather than colliding on `EvidenceStore.put`'s
duplicate-id refusal.

## Data flow

1. `npm run judge -- --bundle <path>` reads the bundle: brief, final compiled prompt,
   `provider_model_fingerprint`, `run_id`.
2. Refuses (exit 2) if the final stage is degraded or demo-mode — judging placeholder text
   against a brief would produce a meaningless score dressed as a real one.
3. Builds the rubric template and the fenced candidate (`core/src/eval/brief-fidelity.ts`, pure).
4. Constructs a `GradeRequest`: `rubric_id: "brief-fidelity-v1"`, `candidate_family` from
   provenance, `verification_status: "judge-checkable"`, `calibration` read from
   `eval/judge-calibration.json`.
5. `GuardedJudge.grade()` — `admitJudge` runs first (existing refusals below), then the hosted
   transport is called once.
6. The resulting `JudgeVerdict` (with `rubric_breakdown`) is wrapped as a `Judgement`
   (`judgement_id` freshly generated, `run_id` from the bundle, `created_at` now) and written via
   `LocalEvidenceStore.put()` under `EvidenceKind: "judgement"`.

## Error handling

**Reused, unchanged, from `admitJudge`:** self-preference, verifier-checkable,
no-calibration, stale-calibration, expired-calibration, below-threshold. No new logic; these
fire exactly as already tested.

**New to this command:**
- Bundle's final stage is degraded/demo-mode → refuse, exit 2, names the stage.
- No API key / placeholder key / no declared budget / malformed budget flag → refuse, exit 2,
  reusing the same `admitRun`-style checks the `--live` pipeline path already has.

There is no "already judged" refusal — judging the same bundle again simply produces a second
`Judgement` record with a new `judgement_id`. See Storage above.

**Provider failure** (network error, response fails schema validation): classified as a
`ProviderFailure`; the command exits non-zero and **writes no evidence record**. A failed judge
call leaves no trace behind — never a partial or guessed verdict.

## Testing

- `core/src/eval/brief-fidelity.ts`: pure unit tests for the rubric template text and
  `buildFidelityCandidate` — two independently-fenced sections, correct labels, unforgeable by
  content in either the brief or the compiled prompt.
- `adapters/provider-hosted-judge/`: adapter tests against a mocked HTTP layer, mirroring the
  existing hosted-provider adapter tests — response parsing, schema validation, failure
  classification.
- `check:judge` (new, CI, no network): reads the committed `eval/judge-calibration.json` and
  `eval/judge-validation-fixtures.json`, re-verifies every surviving mutation still isolates by
  the recorded margin, and re-derives the Cohen's kappa from the recorded classifications. This
  catches the artifact being hand-edited into a nicer result, not the judge's live reliability —
  that would need a real re-run, which CI cannot do.
- Mutation proof for `check:judge`: forcing the isolation comparison to always pass must fail the
  must-fire tests and no others — same discipline as `check:noise`.
- Contract conformance: a real `JudgeVerdict` with `rubric_breakdown` populated validates against
  schema 1.2.0, and a real `Judgement` wrapping it validates against schema 1.0.0, both in
  `test/contract-conformance.test.ts`.
- `adapters/evidence-local`: a test confirming `EvidenceKind: "judgement"` round-trips through
  `put`/`get`/`list` like the four existing kinds, and that two judgements of the same `run_id`
  coexist as distinct records.
- `scripts/judge.ts`: refusal-path tests (degraded bundle, no key/budget) offline; the actual
  hosted call is exercised only in the one-time calibration measurement, not in CI.

## What this does NOT establish

- **Agreement with an actual human rater.** The calibration is internally consistent with the
  rubric's own stated failure modes; whether a person would agree with the judge on a specific
  compiled prompt is unmeasured. This is the load-bearing divergence and is why ADR-0016 exists.
- **Anything about model comparison.** This is a per-run signal, not an instrument for comparing
  models. Sub-project 2's "does not pay" finding is unaffected and unrelated.
- **Reliability on briefs unlike the fixture set.** The mutation suite covers four specific
  failure shapes; a fidelity failure not shaped like one of them may not be caught.
- **Score stability across reruns.** The hosted model is stochastic and temperature is unpinned;
  `runs` and `disagreement_rate` in the verdict report what was observed, not a guarantee of
  reproducibility.
- **That a high score means a *good* prompt.** Only that it is faithful to its brief. A bad brief
  compiled faithfully still scores well — fidelity and quality are different questions.

## Consequences

**Easier:** a per-run quality signal without needing a resolved model comparison or human
annotation infrastructure; debugging why a specific run's compiled prompt looks off.

**Harder:** cost. Every judged run spends real money against a hosted provider — this is
opt-in and post-processing specifically so it never gates a routine pipeline run.

**To revisit:** if human-labeled calibration data is ever built for another purpose, recalibrate
against it and compare the two kappa values — a large disagreement between mutation-derived and
human-derived calibration would be itself a finding about whether derived ground truth is a
reasonable substitute here, not just for this judge.
