# ADR-0008: The Environment Is an Evaluation System That Happens to Author Prompts

## Status
Accepted — 17 August 2026. Constrains the pipeline, the catalog, and the contract set. Extends ADR-0005 (effect ownership) and ADR-0007 (external oracles); supersedes nothing.

**Deciders:** whoever owns Core, the pipeline, and release.

*(Follows the section convention of ADR-0001 through ADR-0007. The evidence table and pipeline specifications are additions.)*

## Context

The documented design treats prompt authoring as the product: eleven stages produce a compiled prompt, sixteen gates lint it, a catalog of 195 techniques advises on construction. Evaluation appears as a testing concern.

Four measured results, from the 599-document corpus read against this project, say that ordering is backwards.

| Finding | Measurement | Source |
|---|---|---|
| A constrained prompt beat CoT on gpt-4o (97% vs 93%) and **lost** on gpt-5 (94.00% vs 96.36%) — a "guardrail-to-handcuff" transition where constraints that fix mid-tier errors induce hyper-literalism in stronger models | GSM8K, 1,317 problems, three model generations | *The Prompting Inversion* |
| Appending generic improvement rules to a prompt cut a RAG compliance suite from **26/30 to 9/30** | 30 cases per suite, five prompt conditions, two local models | *When Generic Prompt Improvements Hurt* |
| Decomposed prompting was **net negative (34%)** against single-shot on a modern model, while a grounded data registry won **100/100** | 100 trials per strategy at temperature 0.7, LLM-as-judge | *Toward Epistemic Stability* (2603.10047) |
| Enforcing JSON output appeared to **increase** hallucination by 10–15 pp under a naive detector; the effect was a **detection-format artifact**, and reversed under a recall-equalized detector | 6,912 API calls, 3 providers, 2 generations, 12 configurations | *Cross-Provider Architectural Ablation* |

Read together these say three things. Prompt improvements are **not monotonic**. Their sign **depends on the model**. And a measurement instrument whose sensitivity varies with the configuration will **invert the conclusion**.

A system that authors prompts without measuring them is therefore not a neutral starting point — it is a system that will confidently ship regressions, and whose catalog will recommend techniques that have inverted since they were written.

This repository already learned the same lesson one level down. Its internal consistency checker passed all 172 catalog citations; an external oracle found eight wrong. Its test suite passed while the differential oracle caught a reintroduced defect. Its JSON Schema accepted two invented vocabularies that the XSD rejected. **Every defect of consequence was found by a second, independently-authored checker — never by making the first one stricter.**

## Decision

**Make measurement the primary subsystem, and the authored prompt a candidate that must earn promotion.**

Three consequences follow, and each is a structural commitment rather than a preference:

### 1. The versioned artifact is a Configuration, not a prompt

```
Configuration = (prompt_template, model_id, decoding_params, retrieval_config, tool_config)
```

A prompt alone is not a meaningful unit of version, comparison, or recommendation, because its effectiveness inverts across model generations. `promote(prompt)` is not a well-formed operation; `promote(configuration)` is.

This also settles what the catalog is for. A technique record without a model axis is a **bibliography entry**, not advice. Recommendations must carry the configuration under which they were measured, or say plainly that they carry none.

### 2. Detector sensitivity is equalized before any comparison

No two configurations may be compared until their detectors are shown to have comparable recall on the same ground truth. The JSON-enforcement result is the proof case: the intervention looked harmful purely because structured output made failures easier to *find*.

This generalizes a mistake this repository made twice — a grep that never matched ANSI-coloured output reported five false survivors, and a PDF read as the authority for its own citation produced a false defect. **A measurement whose instrument has not itself been measured is not evidence.** Equalization is that instrument check, made mandatory.

### 3. A difference is not a result until it survives a significance test

Single-run comparison of two configurations is noise. The protocol is repeated trials with a stable estimator — the corpus offers both a practitioner form (100 trials per condition at fixed temperature) and a statistical one (5×2 block-regularized cross-validated McNemar's test, which exists precisely because a single hold-out split produces a highly varied error estimate and low power).

## Architecture

Four subsystems, on top of the five layers ADR-0001 and ADR-0005 already fix. Two exist; two do not.

```
                    ┌──────────────────────── Shells ────────────────────────┐
                    │  authoring UI · eval UI · CLI                          │
                    └───────────────────────────┬───────────────────────────┘
                                                │ Application protocol only
   ┌────────────────────────────────────────────┴────────────────────────────┐
   │                        Application / Orchestration                       │
   │            owns every effect: provider, store, judge, sink               │
   └───┬──────────────────┬──────────────────┬──────────────────┬─────────────┘
       │                  │                  │                  │
  ┌────┴─────┐      ┌─────┴──────┐    ┌──────┴──────┐    ┌──────┴───────┐
  │ AUTHORING│      │ EVALUATION │    │  REGISTRY   │    │  MONITORING  │
  │  built   │      │  to build  │    │  to build   │    │  to build    │
  ├──────────┤      ├────────────┤    ├─────────────┤    ├──────────────┤
  │ 11 stages│      │ suites     │    │ configs     │    │ fingerprint  │
  │ 16 gates │      │ detectors  │    │ baselines   │    │   watch      │
  │ catalog  │      │ judges     │    │ promotions  │    │ drift alarms │
  │          │      │ comparators│    │ provenance  │    │ prod→case    │
  └────┬─────┘      └─────┬──────┘    └──────┬──────┘    └──────┬───────┘
       └──────────────────┴──────── Core (pure) ───────┴───────┘
            gates · scoring · perturbation · statistics · catalog
```

**What belongs in Core, and why it matters that it is pure.** Scoring functions, perturbation generators, and the statistical comparator are all deterministic functions of their inputs. Keeping them in Core means an evaluation result can be recomputed from stored artifacts without re-invoking a model — which is what makes historical comparison possible at all. The judge is *not* in Core: it performs an effect, so it lives behind the Application layer like any provider.

## Pipelines

Three, deliberately distinct. Conflating them is how eval becomes a thing people skip.

### Pipeline A — Authoring (exists, 11 stages)

`brief → deconstruct → calibrate → compile → harden → critique → refine → lint → critic → preview → cost_estimate → tone_check → candidate Configuration`

**Change required:** gates stop being terminal. A gate verdict currently ends a stage; it must become a **control signal** the reducer consumes — a FAIL routes back to `refine` with the failure as feedback, bounded by a retry cap. This is the DSPy Assertions construct, which raised constraint satisfaction up to 164% by using the same assertions at inference time and at compile time. The gates are already pure, typed, and deterministic; only the reducer needs to act on them.

### Pipeline B — Evaluation (to build, and the one that unblocks everything)

```
Configuration + Suite
   → expand      cases × perturbations               (Core, pure, deterministic)
   → execute     bounded parallel provider calls     (Application, cached by (config_hash, case_hash))
   → detect      deterministic checks first          (Core, pure)
   → judge       only where deterministic cannot     (Application; never the model under test)
   → aggregate   per-suite scores + cost + latency   (Core, pure)
   → compare     against baseline, with significance (Core, pure)
   → EvalRun     immutable, fully provenanced
```

Suite structure follows the MVES shape the corpus supplies — *application category → failure mode → metric → required artifact → validation evidence* — because it forces every metric to name the failure it exists to catch.

Three ordering rules are load-bearing:

- **Deterministic detectors run before judges.** A judge call is expensive, biased, and itself needs evaluating; anything a verifier can settle must not reach one. The catalog's `verification_status` field already partitions techniques this way (`verifier-checkable` 151, `judge-checkable` 10, `unverifiable-by-text` 34) — that partition is the routing rule.
- **The judge is never the model under test.** Same-model judging is a known limitation, and the judge's own agreement, bias, and adversarial robustness are measurable properties that belong in the registry alongside it.
- **Perturbations are part of the suite, not a separate exercise.** Optimizers evaluated only on clean, well-formed inputs collapse under minor perturbation; a suite without perturbed variants overstates every result it reports.

### Pipeline C — Release (to build)

```
EvalRun → gate on (significance ∧ no-regression ∧ within-budget)
        → promote Configuration to baseline
        → stamp build hash + full provenance
        → publish, with the evidence attached
```

A promotion that cannot name the run that justified it is not a promotion. This is where `CAPABILITY_MATRIX.md` finally gets a generator: rows come from promotions, and a claim with no promotion behind it fails the build rather than being written by hand.

### Loop D — Monitoring (to build)

Offline evaluation catches regressions you introduce. **Online monitoring catches the ones that happen to you** — provider models now ship faster than internal release cycles and shift behaviour without a version bump.

The hook already exists and is unused: `ExecutionProvenance.provider_model_fingerprint`. When it changes, re-run the baseline suite and compare. Production failures become new cases, appended to the suite, so the corpus grows against reality rather than imagination.

## Contract changes this requires

Contract-first (ADR-0002) applies: these land as reviewed schema changes before any implementation.

| Contract | Change | Why |
|---|---|---|
| `ExecutionProvenance` | add `decoding_params` (temperature, top_p, seed), `judge_id`, `budget` | Two runs are not comparable without them. A result is a tuple of model, inputs, defenses, dataset **and judge**, with cost and access assumptions explicit |
| `Configuration` | **new** — the versioned artifact defined above, content-addressed | Prompt alone is not a versionable unit |
| `EvalCase` / `EvalSuite` | **new** — case, expectation, failure mode, detector binding | Forces every metric to name the failure it catches |
| `EvalRun` | **new** — immutable result: scores, cost, latency, provenance, detector recall | The unit the registry stores and the comparator reads |
| `JudgeVerdict` | **new** — verdict, rationale, judge identity, calibration reference | Makes judge quality a measured property, not an assumption |
| `TechniqueRecord` | add measured-evidence field | A recommendation without a configuration is a bibliography entry |

## Scalability logic

The design scales because of where the boundaries fall, not because of a framework choice.

- **Execution is embarrassingly parallel** over `cases × perturbations`; the only sequential point is the comparator, which is pure and cheap. Fan-out is bounded by the Application layer, which already owns retry and concurrency.
- **The cache key is deterministic**: `(config_hash, case_hash)`. Because Core is pure and provenance is complete, a repeat run is a lookup. This is what makes 100-trial protocols affordable.
- **Storage grows in immutable append-only runs**, retained whole — the same bundle discipline `storage-local` already uses, for the same reason: a partially-evicted run is worse than no run.
- **Cost is a first-class dimension, not a report.** Budget belongs in the request contract and is enforced, not observed afterwards. No single model is optimal across all queries and budget constraints, which is why routing is a component with an explicit decision rule rather than a configuration constant.
- **Suites are append-only**; baselines are immutable. Comparison across time requires that yesterday's number cannot be edited.

## Trade-off analysis

**This is slower to build than more authoring features, and that is the point.** The authoring pipeline can produce prompts today whose effect nobody can measure. Adding stages to it increases the rate of unverifiable change.

**Evaluation cost is real.** Repeated trials and perturbation suites multiply provider calls. The mitigations are structural: deterministic detectors before judges, content-addressed caching, and bounded parallelism. The 100-trial protocol is affordable precisely because most cases never reach a model twice.

**Judges introduce a dependency with its own error rate.** Accepted, and bounded by routing anything verifier-checkable away from them, and by measuring the judge rather than trusting it.

**Detector equalization is extra work per suite** and will feel like bureaucracy until the first time it saves a wrong conclusion. The corpus provides that instance already: a 10–15 pp apparent regression that was an artifact.

**Deliberately not adopted: `gen_ai.*` as the internal contract.** Every attribute in the OpenTelemetry GenAI registry is still *Development* status; names have already churned. The event spine stays the internal contract, with a mapping layer for export. The span-tree *structure* is worth mirroring; the names are not yet worth depending on.

## Consequences

**Easier**
- Answering "is this prompt better?" with evidence rather than intuition.
- Adopting a new model generation: re-run the suites and read the comparison, rather than re-deriving prompt advice by hand.
- Generating `CAPABILITY_MATRIX.md` from promotions instead of writing it.
- Justifying a catalog recommendation, because it will carry the configuration it was measured under.

**Harder**
- Shipping a prompt change. It now requires a suite and a comparison, which is the intended cost.
- Adding techniques to the catalog faster than they can be measured.
- Claiming an improvement, which now needs a significance test rather than a demo.

**To revisit**
- The significance protocol. 5×2 BCV McNemar is the defensible default for paired binary outcomes; graded and free-form metrics need a different test, and that choice should be recorded, not improvised per suite.
- Judge calibration cadence — judges drift with their own model updates, which is the same problem one level up.
- Whether routing belongs in Application or becomes its own layer once more than one model is in play.

## Enforcement

- No promotion without an `EvalRun` that names its baseline, its significance result, and its detector-recall evidence.
- No comparison across configurations whose detectors have not been equalized — the comparator refuses rather than reporting a number.
- No judge invocation for a case a deterministic detector can settle; the `verification_status` partition is checked, not advisory.
- `provider_model_fingerprint` change triggers a baseline re-run; a silent model swap is a build failure, not a surprise in production.
- Every number in a published claim resolves to an `EvalRun` id, on the same principle `check:plan` already applies to the implementation plan.

## Action items

1. [x] Land the contract changes above as one reviewed schema PR, ahead of implementation (ADR-0002).
2. [x] Build Pipeline B minimally: one suite, deterministic detectors only, no judge, no perturbation. It must be able to fail.
3. [x] Add detector-recall equalization to the comparator before the second suite exists, not after.
4. [ ] Wire gate verdicts into the `compile` reducer as a bounded control signal, and measure the effect against the suite from item 2.
5. [ ] Add the `provider_model_fingerprint` watch. It is the cheapest item here and covers the failure class offline evaluation structurally cannot.
6. [ ] Record the significance protocol per suite type before running comparisons that anyone will cite.
7. [ ] Only then extend the catalog with measured-evidence fields, and backfill the 195 records honestly — most will carry none, and should say so.
