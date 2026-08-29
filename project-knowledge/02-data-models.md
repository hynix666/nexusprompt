# Data models and schemas

16 JSON Schemas in `contracts/`, each with a versioned `$id`
(`https://promptnexus.dev/contracts/<name>/<version>`), plus TypeScript bindings in
`contracts/index.ts`. **The schema is authoritative over the type**, and
`test/contract-conformance.test.ts` validates every schema against a value the running system
actually produced.

`contracts/pending-implementation.json` held **one** entry as of 29 August: `audit-report`,
whose producer is a language model following `prompts/nexus-audit-prompt.md` — not code in this
repository. It reached the empty terminal state earlier and left it, which is what the seam is
for (ADR-0013). The limit is stated in the entry: **a schema no code reads is a schema nothing
keeps honest**, so its `additionalProperties: false` and eight required fields constrain a
document only once something checks a document against them.

## Version inventory

| Contract | Version | Notes |
|---|---|---|
| `gate-result` | 1.3.0 | One gate's verdict |
| `pipeline-outcome` | 1.0.0 | What a Shell receives |
| `provider-failure` | 1.0.0 | Typed, classified failure |
| `revision-entry` | **2.0.0** | One stage execution, persisted. `parent_revision_ids` populated since 1.3.1; `input_ref`/`output_ref` added 1.4.0 and **required** at 2.0.0 |
| `observability-event` | 1.3.0 | Keyed hashes only. Adds `REVISION_SUPERSEDED` |
| `technique-record` | 1.3.0 | Catalog entry (195 records) |
| `configuration` | 1.3.0 | The versioned artifact — **not** the prompt |
| `eval-suite` | 2.0.1 | |
| `eval-case` | 1.2.0 | |
| `eval-run` | **2.0.0** | `provenance` shaped at 2.0.0 — was an unconstrained `object` |
| `comparison` | 2.2.0 | |
| `judge-verdict` | 1.1.0 | |
| `baseline` | 2.0.0 | |
| `promotion` | 1.0.0 | |
| `routing-policy` | 1.0.0 | |
| `audit-report` | 1.0.0 | **No producer here** — written by a model following `prompts/nexus-audit-prompt.md` (ADR-0013) |

Versioning rule (ADR-0002): **major** = a consumer reading the old shape breaks · **minor** =
additive · **patch** = wording only. Every bump needs a `contracts/CHANGELOG.md` entry.

---

## Configuration — the versioned artifact

The unit of promotion is a **Configuration**, not a prompt. `configurationId()` is a SHA-256
over the whole object, so *anything* that can move a result moves the id.

```jsonc
{
  "configuration_id": "<64 hex>",          // sha256 of everything below
  "prompt_template_ref": "core/src/stages/compile.ts",
  "model_id": "claude-opus-5",
  "decoding": { "temperature": 0.7, "seed": null },
  "topology": { "kind": "reflexive", "stages": [...], "max_iterations": 3 },
  "retrieval_config": null,
  "tool_config": null,
  "gate_set_ref": "scripts/ported-gates.json",   // gates constrain a search, never score it
  "router_policy_ref": null,                      // a RoutingPolicy, or null for one model
  "budget": { "max_provider_calls": 1400, "max_usd": null, "on_exceed": "refuse" }
}
```

- `topology.kind: "reflexive"` **requires** `max_iterations` — enforced by an `if`/`then` in
  the schema since 1.1.0. The description had said so since 1.0.0 and nothing checked it.
- `gate_set_ref`: *"Gates constrain a search; they are never a term in its objective. An
  optimizer that can move this is optimizing its own examiner."*
- `budget.on_exceed` has **no default**. Both `refuse` and `truncate_suite` are defensible,
  so choosing for the caller is the bug.

## EvalSuite — and the field that meant three things

```jsonc
{
  "suite_id": "gate-recall-anchor",
  "version": "1.0.0",
  "kind": "smoke" | "anchor" | "adversarial",
  "case_ids": ["..."],
  "resolution": {
    "detectable_delta": 0.000204,   // SCORE GRANULARITY = 1/n. Not statistical resolution.
    "confidence": 0.95,
    "sized_for": 4906
  },
  "significance_protocol": "exact-mcnemar" | "clustered-paired" | "bootstrap-ci"
}
```

> **The sharpest schema defect found in this project.** `detectable_delta` meant three
> different things in three places: the schema described it *statistically* and quoted the
> `z²/(2Δ²)` sizing rule; every suite instance set it to `1/n` (score granularity); the
> comparator used it as a reporting floor. The instances and the consumer agreed with each
> other, so **the schema was the one that changed** (2.0.1, description only).
>
> Both floors are real and both are enforced, in the place each belongs: granularity stays
> *declared*; statistical resolution is *derived* by the comparator, because a declared one is
> precisely the number that drifted.

`significance_protocol` is **required** (the 2.0.0 major bump). An optional field would have
left ADR-0008's open item open.

## Comparison — every guard here is derived, never supplied

```jsonc
{
  "comparison_id": "anchor-1",
  "candidate_run_id": "...", "baseline_id": "...",
  "verdict": "improved" | "regressed" | "inconclusive" | "refused",
  "refusal_reason": "…required when refused…",
  "delta": 0.2434,
  "protocol": {
    "test": "mcnemar" | "clustered-paired" | "paired-bootstrap" | "5x2cv-paired-t" | "none",
    "effective_n": 4906,          // INDEPENDENT units, not the case count
    "discordant": 1236,           // the exact sample size of a paired test
    "min_attainable_p": 4.94e-324,// 2 * 0.5^d — a design property, NOT observed power
    "attainable": true,
    "alpha": 0.05,                // AFTER multiplicity correction
    "comparisons_in_family": 1,
    "correction": "none" | "bonferroni" | "holm" | "benjamini-hochberg",
    "p_value": 4.94e-324
  },
  "equalization": {
    "equalized": true, "max_gap": 0, "gap_bound": 0.000204,
    "effective_recall": 1, "adjusted_resolution": 0.000204, "per_detector": [...]
  }
}
```

- `equalization` replaced a **boolean the caller asserted and nothing computed** — the
  comparator's strongest guard was a field callers filled in.
- `min_attainable_p` is *not* observed power (which is a monotone function of the p-value and
  adds nothing). It is the **support of the test statistic**, a property of the design.
- `p_value` is clamped to `Number.MIN_VALUE` past 1,075 discordant units. `2·0.5^d`
  underflows a double to exactly 0 there, and 0 claims impossibility under the null when the
  true value is ~1e-372.

## Baseline — a field that could never be written

```jsonc
{
  "baseline_id": "base-1",
  "configuration_id": "<64 hex>",
  "run_id": "run-b",
  "frozen_at": "2026-08-22T12:00:00.000Z",
  "lineage": "benchmark" | "development",
  "supersedes": "base-0"       // FORWARD pointer on the NEW record
}
```

1.0.0 had `superseded_by` — a *backward* pointer set on an existing record. `EvidenceStore`
has no `update` (by design; `put` uses the `wx` flag), so it could never be set. Its own
description promised baselines are *"append-only; superseding is recorded, never
overwritten"* while being the one field whose use required overwriting. **Reversing the
direction made the description true.** Free to fix the day before a producer existed; a
migration the day after.

`lineage` existed since 1.0.0 and **nothing read it** until the release gate landed. A
`development` baseline may not certify a promotion — an optimizer that can write the baseline
would otherwise promote its own candidate.

## Promotion

```jsonc
{
  "promotion_id": "promo-1",
  "kind": "promote" | "rollback",
  "configuration_id": "<64 hex>",
  "eval_run_id": "...", "baseline_id": "...", "comparison_id": "...",
  "supersedes": null,
  "promoted_at": "...", "promoted_by": "...",
  "conditions": {
    "significance":          { "held": true, "detail": "improved, p=0.00090 …" },
    "no_regression":         { "held": true, "detail": "2 failure mode(s) checked …" },
    "within_budget":         { "held": true, "detail": "14 provider call(s), $0.01 …" },
    "judge_calibration":     { "held": true, "detail": "no judge graded this run …" },
    "detector_equalization": { "held": true, "detail": "max recall gap 0.0000 …" }
  }
}
```

Every field but the timestamps is a **pointer**: a promotion that cannot name the run
justifying it is not a promotion, it is an assertion. `conditions` records all five verdicts
*with reasons, in both directions* — a conjunction whose satisfied terms are not written down
degrades into a rubber stamp the first time one silently stops being checked.

`kind: "rollback"` rather than a separate contract: promotion is a label repoint, so rollback
is the same record travelling the other way, carrying the pointers of the promotion it
reverses.

## RoutingPolicy

```jsonc
{
  "policy_id": "cascade-v1",
  "method": "fixed" | "cascade",
  "tiers": [
    { "model_id": "small-1", "family": "vendor-a", "usd_per_mtok_in": 0.25, "usd_per_mtok_out": 1.25 },
    { "model_id": "large-1", "family": "vendor-b", "usd_per_mtok_in": 15,   "usd_per_mtok_out": 75 }
  ],
  "escalate_on": ["gate-fail" | "provider-failure"],
  "max_escalations": 1
}
```

Three shapes are **refused** because they are indistinguishable from working ones:

| Refused | Why |
|---|---|
| a `cascade` with one tier | validates, runs, never escalates, reports itself as a cascade — indistinguishable from one whose cheap tier always sufficed |
| a `cascade` with no `max_escalations` | the hazard `topology.max_iterations` guards, by another name; an undeclared cap is unbounded |
| a `fixed` policy carrying escalation settings | describes behaviour it does not have |

`family` is per tier so a routed run can still be checked against *"the judge is never the
model under test"* — escalating into the judge's family would otherwise silently build the
self-preference cycle `admitJudge` refuses.

## EvalRun

```jsonc
{
  "run_id": "...", "configuration_id": "...", "suite_id": "...", "suite_version": "...",
  "aggregate": { "cases": 14, "passed": 13, "score": 0.928,
                 "by_failure_mode": { "hallucination": { "cases": 7, "passed": 6 } } },
  "cost": { "tokens_in": 0, "tokens_out": 0, "provider_calls": 14,
            "cache_hits": 0, "usd": null, "budget_exceeded": false },
  "detector_recall": { "probe_corpus_version": "1.0.0", "detectors": [...] },
  "grader_health": null,          // absent = no judge ran, NEVER "a judge was fine"
  "scorer_provenance": { "scorer_ids": [...], "selected_using": null },
  "provenance": { "provider": "pinned-stub" | "local-proxy", ... }
}
```

- `cost.usd` is `null` when no rate was supplied — **not zero**. Zero reads as free; null
  reads as unmeasured, and those take different paths downstream.
- `detector_recall: null` means *not measured* — never that it was adequate.
- `provenance.provider` is the only thing distinguishing a run that is evidence about a model
  from one that is evidence about the accounting.

## EvalCase — two shapes, and they must not be confused

| Field | Single-stage case | Pipeline case |
|---|---|---|
| input | `input` | `brief` + `context` |
| stubs | `stub` (one) | `stubs` (per stage) |
| runner | `runSuite` | `runPipelineSuite` |

`isPipelineCase(c)` (in `application/src/pipeline-eval.ts`) is the **one** predicate both
runners use. Two predicates would be two answers, and the gap between them is where a suite
gets silently accepted by the wrong runner — which happened: `eval --suite
eval/pipeline-smoke.json` reported **5/5 and 5 provider calls** for five cases that each
describe an eleven-stage run.

`failure_mode` is an enum of 15 values in the schema. It was an unconstrained string while
the TypeScript binding enumerated 15, so two invented modes validated cleanly against the
contract that is supposed to be authoritative.

## Ports (TypeScript interfaces, not schemas)

```ts
interface ProviderTransport { provider_id: string;
  generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure>;
  healthCheck(): Promise<ProviderHealth>; }

interface EvidenceStore {          // deliberately NO update, NO delete
  readonly retention_scope: RetentionScope;
  put(record: EvidenceRecord): Promise<void>;   // rejects duplicate (kind, id)
  get(kind, id): Promise<EvidenceRecord | null>;
  list(kind, filter?): Promise<EvidenceSummary[]>; }

interface CacheStore  { get(key): Promise<GenerationResult | null>; set(key, v): Promise<void>; }
interface RevisionStore {
  append(entry): Promise<void>;
  getRun(run_id): Promise<RevisionEntry[]>;
  listRecent(limit): Promise<RunBundleSummary[]>;
  markStale(run_id, from_revision_id): Promise<void>;   // a REVISION, not a stage
}
interface EventSink   { emit(e: ObservabilityEvent): void; }
interface JudgeTransport { judge_id: string; judge_family: string;
                           grade(req: JudgeRequest): Promise<JudgeVerdict>; }
```

**Immutability is expressed by the absence of a mutator**, not by a convention someone has to
honour. An adapter that wanted to violate it would have to add a method.
