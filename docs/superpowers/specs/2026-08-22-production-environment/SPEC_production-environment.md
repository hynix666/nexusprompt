# Specification — Production-grade Prompt Engineering Environment

**Status:** proposed, 22 August 2026. Extends ADR-0008; constrains Phases 5–7 of `IMPLEMENTATION_PLAN.md`. Supersedes nothing.
**Method:** [GROUND_TRUTH](./GROUND_TRUTH.md) → [SKELETON](./SKELETON_production-environment.md) → [MAP](./MAP_corpus_to_promptnexus.md) → [AUDIT](./AUDIT_production-environment.md). Audit findings are cited inline as `[AUDIT X-n]`.

---

## 1. Scope, invariants, and inherited defects

### What this specifies

The architecture and pipelines that take this repository from *a system that authors prompts and can measure a stub* to *a system that measures a model, certifies a change, and notices when the ground moves under it.* Twelve parts, four of which have no inbound dependencies and are buildable today.

### What it does not specify

The two Shells (`pipeline-ui`, `toolkit-ui`), the hosted provider adapter, and CI. These are Phases 5–7 work whose shape is already settled by ADR-0003, ADR-0006 and R8; nothing in the corpus changes them.

### Invariants (from GROUND_TRUTH, restated because they narrow what follows)

I1 Core performs no effect · I2 Core never *receives* one — `decide → invoke → reduce` · I3 output is never fabricated when no model answered · I4 schema before code · I5 ported gates match the frozen oracle or declare a divergence · I6 frozen inputs are corrected at the boundary, never edited · I7 observability carries keyed hashes only.

**I2 and I3 visibly narrow this specification.** They exclude the dominant shape in the external tooling surveyed — a harness whose scorer calls a model — and that exclusion is what makes an `EvalRun` recomputable from stored artifacts without re-invoking anything. Part 5's "the judge is never the model under test" is structural here rather than a policy someone must remember.

### Measured baseline

437 tests · 2,720 differential verdicts · 16/16 gates · 11/11 stages · 13 schemas (2 without producers) · **0 provider calls ever made by an eval run** · **0 promotions** · **0 baselines** · 599 independent research sources · 19 commits, no remote.

*As of Phase ε:* 623 tests · **14 schemas, none without producers** · 0 provider calls · 0 promotions · 0 baselines · 26 commits, still no remote. The three zeros are unchanged and are the point: the release gate is built, armed, and has never fired.

### Source discipline

Internal corpus: 599 documents under `PDF/`, unpinned and unmanifested — the *less* verified of the two inputs, against `sources/`'s 420 hash-pinned files. **599 is an upper bound** on independent sources: content hashing catches byte-identical duplicates, not the same paper under two filenames or a v1/v2 pair `[AUDIT D]`. External sources are cited with identifiers verified at retrieval, not from memory.

### Inherited defects this specification must not reproduce

| Defect | Where | Carried into |
|---|---|---|
| Corpus size stated as 673/~700; measured 599 | ADR-0008 ×3, PEE ×1 | Part 0, Part 1 `[AUDIT B-1]` |
| Catalog stated as 180; measured 195 | 4 documents | Part 1 `[AUDIT B-2]` |
| Judge routing partition `137/8/35`; measured **151/10/34** | ADR-0008 | Part 1, Part 5 `[AUDIT B-3]` |
| `input_ref`/`output_ref` documented, absent from the contract | `REVISIONS_AND_EXPORTS.md` | Part 2 `[AUDIT B-4]` |
| "Judge is never the model under test" — enforced by nothing | ADR-0008 Enforcement | Part 5 `[AUDIT C-2]` |
| `budget_exceeded` required, enforced nowhere | `eval-run` + `application/src/eval.ts:195` | Part 3 `[AUDIT C-3]` |
| Keyed fingerprints documented, bare `sha256` in code | `PRIVACY_AND_SECURITY.md` r4 | §7 `[AUDIT C-4]` |

---

## 2. Re-description: what this system actually is

In the literature's terms, this is **not a prompt authoring tool with tests attached.** It is an *evidence system* whose output is a defensible claim about a configuration, and whose prompt compiler is one instrumented subject among several. ADR-0008 said this; the architecture below is what it looks like once the evidence has a home.

The organising principle is I-1's: **LLM system failures are silent by default, so the architecture's job is manufacturing an error signal where the model emits none.** Every part below is admitted on that test, and two candidates were rejected by it `[AUDIT C-5]`.

### Four planes

```
┌── SHELLS ──────────────────────────────────────────────────────────────┐
│  cli (built) · pipeline-ui · toolkit-ui        Application protocol only│
└────────────────────────────────┬───────────────────────────────────────┘
┌────────────────────────────────┴───────────────────────────────────────┐
│  EFFECT PLANE — Application. Owns every effect, and nothing else does. │
│  provider · judge · store · sink · cache · budget · retry · fan-out    │
└──┬──────────────────┬──────────────────┬──────────────────┬────────────┘
   │                  │                  │                  │
┌──┴──────────┐ ┌─────┴────────┐ ┌───────┴───────┐ ┌────────┴──────────┐
│ CONTRACT    │ │ DECISION     │ │ EVIDENCE      │ │ ADAPTERS          │
│ PLANE       │ │ PLANE (pure) │ │ PLANE (new)   │ │ provider ×2       │
│ 13 schemas  │ │ gates 16     │ │ EvalRun       │ │ storage ×2        │
│ versioned,  │ │ stages 11    │ │ Baseline      │ │ judge ×1          │
│ the sole    │ │ detectors    │ │ Promotion     │ │ evidence ×1       │
│ cross-      │ │ perturbations│ │ Comparison    │ │ cache ×1          │
│ boundary    │ │ statistics   │ │ immutable,    │ │ swappable per     │
│ interface   │ │ routing pol. │ │ append-only   │ │ deployment        │
│             │ │ catalog 195  │ │               │ │                   │
└─────────────┘ └──────────────┘ └───────────────┘ └───────────────────┘
```

The **evidence plane is the new one.** Today `EvalRun`, `Baseline` and `Comparison` have schemas and no home; runs are computed and discarded. A plane that computes evidence and does not retain it cannot answer "is this better than last month," which is the only question the system exists to answer.

### Five pipelines

| | Pipeline | State | What it produces |
|---|---|---|---|
| **A** | Authoring | built, 11 stages, CLI-reachable | a candidate `Configuration` |
| **B** | Evaluation | partial — detectors, comparator, recall equalization | an immutable `EvalRun` |
| **C** | Release | absent | a `Promotion` and a `Baseline` |
| **D** | Monitoring | absent | new `EvalCase`s, and a build failure on provider drift |
| **E** | Optimization | specified, **unscheduled** | candidate `Configuration`s, each an `EvalRun` |

```
        ┌──────────────────────── E · optimization (unscheduled) ───────────┐
        │  propose Configuration ──► B ──► objective = B's verdict ─────────┘
        ▼
brief ─► A ─► Configuration ─► B ─► EvalRun ─► C ─► Baseline ─► production
                  ▲                                                │
                  └──────────── D · fingerprint watch, prod→case ──┘
```

**A** is a loop, not a line, once Part 4 lands: a gate FAIL routes back to `refine` carrying its message, bounded by a cap in the contract. **B** is the only pipeline that may call a model under test. **C** is the only writer of baselines. **E** may write none of the above — its write surface excludes the gate registry, the oracle, and the anchor, which is I-4's anchored-authority invariant made structural.

### Exposure register

What this system is exposed to, given the re-description:

| Exposure | Status |
|---|---|
| Scorer that calls a model, making history unrecomputable | **not exposed** — I1 forbids it statically `[MAP non-exposure 1]` |
| Exact-match agreement overstating judge quality | **not exposed** — schema admits only chance-corrected metrics |
| Confident wrong promotion | **exposed**, and the worst case in the set. Contained by Part 7's refusal and Part 8's conjunction |
| Silent provider drift | **exposed** — Part 9, currently zero coverage |
| Judge self-preference | **exposed** — `judge_id` carries no family `[AUDIT C-2]` |
| Cost-driven degradation with no alert | **exposed** — budget enforced nowhere `[AUDIT C-3]` |
| Anticonservative p-values under clustering | **exposed the moment Part 6 ships** — Part 7 must land with it, not after `[MAP E-4]` |

---

## 3. The parts

Each: the defect → the definitions → the schema → the gate → the threat model → the tests.

### Part 0 — Corpus integrity

**Defect.** 62 duplicate files; no manifest; four documents cite a size no command reproduces `[AUDIT B-1]`.
**Definitions.** *Independent source* — a distinct content hash under `PDF/`. *Corpus size* — the count of those, an upper bound on independent sources.
**Schema.** `PDF/MANIFEST.json`: `{ generated_at, count, unique_count, duplicates: [{hash, paths[]}], files: [{path, sha256, bytes}] }`. Modelled on `sources/MANIFEST.json`, which already works.
**Gate.** `npm run check:corpus` — re-hashes, fails on drift, prints `unique_count`. Duplicates are **recorded, not deleted**: I6 says frozen inputs are not edited, and a duplicate is evidence of how the corpus was assembled.
**Threat model.** A manifest that is regenerated on every run guards nothing. `--check` mode is the default in `verify`; regeneration is explicit.
**Tests.** Planted extra file → must fail. Planted hash change → must fail. Unchanged tree → must pass.

### Part 1 — `check:counts`

**Defect.** `check:plan` reads one document; four wrong counts live in others, one of them a routing rule `[AUDIT B-2, B-3]`. R9 instance #7: a guard whose scope is narrower than its name.
**Definitions.** A *checkable count* is a number in prose that resolves to a command over the tree. **The name is `check:counts`, not `check:claims`** — it verifies numeric claims, not prose claims, and naming it broader would reproduce the very class it fixes `[AUDIT, defect classes]`.
**Schema.** `scripts/counted-claims.json`: `[{ document, pattern, command, reason }]`, each entry pinning one number to one reproduction command.
**Gate.** `npm run check:counts` over every `Documentation/*.md` and `CLAUDE.md`. An entry whose pattern no longer matches its document **fails as stale**, so the file cannot outlive what it checks.
**Threat model.** The obvious failure is an allowlist that grows to excuse drift. Prevented by the stale rule, which is the same discipline `catalog-known-defects.json` and `divergence-allowlist.json` already carry.
**Tests.** Mutate `195 → 180` in `techniques.json` → must fail. Mutate the prose instead → must fail. No-op control → must pass. Each proven by exit code, never by output text.

### Part 2 — The evidence plane

**Defect.** Three schemas with no home; runs computed and discarded; `input_ref`/`output_ref` documented and absent `[AUDIT B-4]`.
**Definitions.** *Evidence* — an `EvalRun`, `Comparison`, `Baseline` or `Promotion`. All immutable: a re-run is a new run.
**Schema.** New port, deliberately narrow:

```ts
export interface EvidenceStore {
  readonly retention_scope: RetentionScope;
  put(record: Evidence): Promise<void>;          // refuses a second write under the same id
  get(kind: EvidenceKind, id: string): Promise<Evidence | null>;
  list(kind: EvidenceKind, filter: EvidenceFilter): Promise<EvidenceSummary[]>;
}
```

No `update`, no `delete`. Immutability is expressed by the absence of a mutator, not by a convention someone must honour.
**Gate.** Conformance suite parameterized over implementations, run against `evidence-local` always. `npm run verify` **reports which implementations it covered** — a suite that skips silently when a backend is absent is the R9 pattern again.
**Threat model.** Concurrency `[AUDIT omission 5]`. `storage-local` does read-modify-write per append, 11× per run; two concurrent runs already race. `evidence-local` writes one file per record, named by id, created with `wx` — an existing id fails at the filesystem rather than in a check. I-4: file-level locking serializes the write but not the read–compute–write cycle, so the design avoids needing a lock.
**Tests.** Second `put` under one id → rejected. Concurrent `put` of 32 records → all present, none truncated. Round-trip through the JSON Schema validator.

### Part 3 — The execution plane

**Defect.** No eval run has ever called a model. `budget_exceeded` is a literal `false` and nothing could enforce it `[AUDIT C-3]`.
**Definitions.** *Cache key* — `(config_hash, case_hash)`, deterministic because Core is pure and provenance is complete. *Budget* — a ceiling enforced **before** dispatch, not observed after.
**Schema.** `CacheStore { get(key): Promise<GenerationResult|null>; put(key, value): Promise<void> }`. `Configuration.budget: { max_usd, max_provider_calls, on_exceed: "refuse" | "truncate_suite" }` — `on_exceed` is explicit because both behaviours are defensible and a silent choice between them is the failure mode.
**Gate.** A suite whose declared budget would be exceeded **refuses to start** rather than stopping midway; a partially-executed suite is not an `EvalRun`.
**Threat model.** Three, all from I-1's cost-degradation entry. (a) Cache poisoning by an incomplete key — mitigated by hashing the full `Configuration` including decoding params and seed. (b) A silent prefix invalidator making caching a no-op — mitigated by asserting `cache_read_input_tokens > 0` on the second identical request; `COMPILER_SYSTEM` is already frozen and verified verbatim, so the system segment is stable by construction `[MAP E-1]`. (c) Fallback to a weaker model degrading correctness with no alert — the model is part of the `Configuration`, so a fallback is a *different configuration* and the comparator refuses.
**Scalability.** Execution is embarrassingly parallel over `cases × perturbations`; the only sequential point is the comparator, which is pure and cheap. Fan-out bounded by the Application, which already owns retry. Suites above a declared case count submit through the **Batch API at 50% of standard rates**; the stable prefix is cached at ~0.1× input cost. These are the three mechanisms that make a 100-trial protocol affordable, and none is a framework choice.
**Tests.** 100-trial suite → `provider_calls < cases × trials` and `cache_hits > 0`. Budget of $0 → refuses before any dispatch. Planted prefix invalidator → the cache-hit assertion fails.

### Part 4 — Gate verdicts as a bounded control signal

**Defect.** ADR-0008 action item 4, open. Sixteen gates produce structured failure text that currently terminates a stage.
**Definitions.** *Control signal* — a `GateFeedback` the reducer consumes to route back to `refine`, carrying the gate id and its message. *Cap* — the maximum number of feedback rounds, **in the contract**, because I-3's recorded hazard for verification loops is "unbounded retry without a termination rule."
**Schema.** `Configuration.gate_feedback: { enabled: boolean, max_rounds: integer (1..3) }`. Upper bound 3 follows the agentic-RAG hop cap in the same evidence table.
**Gate.** `check:depth` extended: declared depth × max_rounds must remain inside the declared per-stage floor, so the two cannot both be raised silently.
**Threat model.** A feedback loop that reprocesses a demo placeholder spends requests on a non-artifact — the failure already found by running the CLI, which is why six stages guard on `isDemoArtifact`. The reducer must inherit that guard, not re-derive it.
**Why this is the cheap end of the optimizer.** GEPA reflects in natural language on execution traces rather than collapsing feedback into a scalar, and beats MIPROv2 by >10% with 35× fewer rollouts `[MAP E-2]`. Gate messages are already that signal — verified: every `GateResult` carries a `message`, asserted for all 16 gates. **Labelled a hypothesis**: the mechanism transfers, the effect size here is unmeasured `[AUDIT D]`.
**Tests.** A brief failing `PLACEHOLDER_AUDIT` on first compile passes after bounded refinement. `max_rounds: 0` → behaviour identical to today, byte for byte. A degraded run → zero feedback rounds. The smoke suite reports the change's **sign**, since I-2 says improvements are not monotonic.

### Part 5 — The judge adapter and its bias panel

**Defect.** Three of five named biases uncaptured; `measured_at` optional so a stale calibration validates; "never the model under test" enforced by nothing `[AUDIT C-2]`.
**Definitions.** *Judge contract* — (pinned model id, versioned rubric, hashed template). *Stale calibration* — one measured before the most recent change to any of the three.
**Schema.** `judge-verdict` **v1.1.0**: add `judge_family` (required); add `bias_panel: { verbosity_delta, format_delta, self_preference_delta, measured_at }`; make `agreement.measured_at` required when `agreement` is present. Agreement floor stays per-rubric — practice puts it near **κ ≥ 0.60**, raised to **≥ 0.80** where a wrong verdict carries real cost `[MAP E-3]`.
**Gate.** Three refusals, all in the adapter. (a) `judge_family === configuration.model_family` → refuse. (b) calibration older than the newest of (judge model, rubric, template) → refuse. (c) a case whose technique is `verifier-checkable` reaching a judge → refuse. **(c) uses the measured partition — 151 verifier-checkable, 10 judge-checkable, 34 unverifiable — not the documented 137/8/35** `[AUDIT B-3]`.
**Threat model.** *New, and absent from both prior phases* `[AUDIT omission 1]`: the judge's input contains the model's own output, so output crafted to look like rubric text can steer its own grade. This is prompt injection with the attacker inside the loop. Mitigation: the judge prompt applies the same delimiter discipline the compiled prompt does, and `DELIMITER_ENTROPY` runs on the judge prompt — a gate already built, pointed at a new surface.
**Scalability.** The routing rule is what bounds judge cost: 151 of 195 techniques never reach one.
**Tests.** Same-family judge → refused. Stale calibration → refused. Verifier-checkable case routed to a judge → refused. Injection corpus: outputs containing rubric-shaped text → grade unchanged. Position-swapped pairs → verdict stable within the declared disagreement rate.

### Part 6 — Perturbations

**Defect.** A suite of clean inputs overstates every result it reports.
**Definitions.** *Perturbation* — `perturb(case, seed) → case`, pure and reproducible. *Cluster* — a base case and all its variants. **`cluster_id` is written by the expander, never by suite authors** `[AUDIT omission 4]`; author-assigned clustering makes the statistics author-dependent.
**Schema.** `EvalCase.cluster_id: string` (required, expander-populated); `eval-suite` version bump.
**Gate.** Every case in an anchor suite has ≥1 perturbed variant, checked, not advised.
**Threat model.** A perturbation that changes the ground truth is not a perturbation — it is a different case with a stale expectation. Each perturbation declares whether it is expectation-preserving; only preserving ones may share a cluster.
**Tests.** Same seed → identical expansion. Registry addition costs one line plus one function. A non-preserving perturbation sharing a cluster → rejected.

### Part 7 — Statistics

**Defect, and the sharpest finding in the register.** The comparator is exact-binomial McNemar over discordant pairs — correct for *independent* paired binary outcomes. Part 6's expansion is `cases × perturbations`, a within-case product, which is the definition of clustered data. Cluster-adjusted standard errors run **up to 3× larger than naive ones** `[MAP E-4]`. The moment perturbations ship, every p-value the comparator reports is anticonservative.
**Definitions.** *Significance protocol* — declared per suite, one of `exact-mcnemar` (independent paired binary), `clustered-paired` (clustered paired binary), `bootstrap-ci` (graded/free-form). *Resolvable delta* — the smallest true difference the suite can distinguish, `n₀ ≳ z²/(2Δ²)`.
**Schema.** `eval-suite.significance_protocol` (**required** — this discharges ADR-0008's open item "record the significance protocol per suite type before running comparisons that anyone will cite"); `comparison` **v2.1.0** adding `cluster_adjusted: boolean` and extending `refusal_reason`.
**Gate.** The comparator returns `refused` when the suite is clustered and the declared protocol assumes independence. **This extends an existing mechanism rather than inventing one** `[AUDIT C-1]`: `compare()` already refuses when two runs' `probe_corpus_version` differ, at `core/src/eval/compare.ts:85`. A reviewer can check the new refusal against a working precedent.
**Threat model.** The tempting bug is to keep reporting a number with a caveat. A caveat is not a refusal — I-2's JSON-enforcement case is precisely a confident wrong finding produced by an unequalized instrument, and it came with caveats.
**Honest limit, stated rather than worked around.** `requiredAnchorSize(0.02)` ≈ **3,400 items**; the largest suite here has **14**. **This repository cannot currently certify a 2-percentage-point improvement, and must say so instead of reporting one** `[AUDIT C-7]`. Paired differences are a free variance reduction and are used wherever practicable, which lowers the required n but does not close a 240× gap.

> **Corrected in Phase ε, and the gap is wider than this paragraph says.** ≈3,400 is the rule's output with a one-sided z, 50% power and a 50% discordance rate — three assumptions it never stated. Honestly powered the figure is **≈9,800**, so the gap is nearer 700×. The sharper limit needs no assumptions at all: fewer than **six** discordant units cannot reach α = 0.05 under any arrangement, which is a property of the design rather than of the data. `requiredAnchorSize` is retained and deprecated because three documents cite its output; `requiredPairedSize` takes power and discordance as arguments so no caller can inherit an assumption without writing it down.
**Tests.** Planted 2-point difference at declared anchor size → detected; below it → **not** detected (the must-not-fire half). Clustered suite + independence protocol → `refused`. Known-clustered fixture → cluster-adjusted interval strictly wider than naive.

### Part 8 — Pipeline C, release

**Defect.** Zero promotions, because there is no promotion path. `CAPABILITY_MATRIX.md` asserts nothing and is written by hand.
**Definitions.** *Promotion* — a label repoint, not a rebuild; therefore *rollback* is a repoint too `[AUDIT omission 2]`.
**Schema.** `Promotion { promotion_id, configuration_id, eval_run_id, baseline_id, comparison_id, promoted_at, promoted_by }`. Every field a pointer: a promotion that cannot name the run justifying it is not a promotion.
**Gate.** `promote` refuses unless **all five** hold: significance ∧ no-regression ∧ within-budget ∧ non-stale judge calibration ∧ equalized detectors. A conjunction, so no single check carries a promotion alone.
**Threat model.** The generator becomes a rubber stamp if `CAPABILITY_MATRIX.md` can be edited by hand. It ships with `--check`, like `import:catalog`: the committed file must be what the promotions currently produce.
**Tests.** Each of the five conditions violated in turn → five distinct refusals, five distinct reasons. Hand-edited matrix → `check` fails. Rollback restores the prior baseline pointer without touching any run.

### Part 9 — Loop D, monitoring

**Defect.** `provider_model_fingerprint` is on every provenance record and read by nothing. Offline evaluation structurally cannot catch a provider changing under you — and I-2 says prompt effectiveness inverts across model generations, so this is not a tail risk.
**Definitions.** *Drift* — a fingerprint differing from the pinned one for a configuration's model.
**Schema.** `fingerprints.json`: `{ model_id: { fingerprint, first_seen, baseline_suite } }`.
**Gate.** `npm run check:fingerprint` fails the build on drift and names the suite to re-run. A silent model swap is a build failure, not a production surprise.
**Threat model.** A fingerprint that changes on every call is noise and will be disabled within a week; it must derive from a stable provider-reported identity, and where the provider reports none, the check records "unavailable" rather than fabricating one — I3 applied to monitoring.
**Tests.** Changed fingerprint → build fails, naming the suite. Unchanged → passes. Unavailable → records unavailable, does not fail, does not claim coverage.
**This is the cheapest part with the widest coverage**, and it is ADR-0008 action item 5.

### Part 10 — Routing · Part 11 — Optimization

Both **specified, not scheduled**. Routing: policy pure in Core, selection in Application — `decide → invoke → reduce` again, needing no new layer, and answering the question ADR-0008 left under *to revisit*. A router is added by implementing a routing method and a loss function plus one registry line, and is evaluated on quality **and** cost under the same `EvalRun` protocol as any configuration.

Part 11 is excluded by an invariant this specification states itself `[AUDIT C-7]`: anchored evaluative authority requires a *sized* anchor, and 14 cases against a required ≈3,400 means the optimizer could certify nothing. Its entry criterion is in §6.

---

## 4. Change surface

### New checks — verified collision-free against `package.json`

`check:corpus` · `check:counts` · `check:fingerprint` — none collides with the 21 existing scripts (verified by reading the `scripts` block). Existing names are reused where the capability already exists rather than shadowed.

### Interaction matrix

| | `check:corpus` | `check:counts` | `check:fingerprint` | `differential` |
|---|---|---|---|---|
| **`check:corpus`** | — | **must run first** — `check:counts` verifies corpus size against the manifest `[AUDIT omission 3]` | independent | independent |
| **`check:counts`** | consumes its manifest | — | independent | independent |
| **`check:fingerprint`** | independent | independent | — | independent — the oracle is a frozen Python file, unaffected by provider drift |

Order in `verify`: `check:corpus` → `check:counts` → everything existing → `differential` last. The intended ordering is meaningful and unchanged: boundaries and schemas first, Core tests, Application, adapters, cross-shell parity, adversarial corpus, reproducibility last.

### Parity obligations

- Every new Core function is covered by the differential oracle **or** carries a divergence-allowlist entry with a reason and an ADR. Detectors, perturbations and statistics have no Python counterpart, so they take the second path: a recorded, reasoned absence rather than a silent one.
- Both storage implementations satisfy one conformance suite, and `verify` reports which were covered.

### Versioning (I4 — schema before code)

| Contract | Change | Version |
|---|---|---|
| `judge-verdict` | `judge_family`, `bias_panel`, `measured_at` required with `agreement` | 1.0.0 → **1.1.0** |
| `eval-case` | `cluster_id` required | → **minor** |
| `eval-suite` | `significance_protocol` required | → **major** (required field) |
| `comparison` | `cluster_adjusted`, extended `refusal_reason` | 2.0.0 → **2.1.0** |
| `configuration` | `budget`, `gate_feedback`, `routing_policy` | → **minor** |
| `EvidenceStore`, `CacheStore`, `Promotion` | new | CHANGELOG entries |

Each lands as its own reviewed change with a `contracts/CHANGELOG.md` entry, before implementation. `pending-implementation.json` entries are removed as producers appear — the stale rule already enforces this.

---

## 5. Roadmap

Each phase carries entry criteria and **one falsifiable prediction**. Every part ships its check *with* the capability, never after — the encoded fix for the "guarantee written but not wired" class.

### Phase α — the free wins (Parts 0, 1, 9) · **LANDED 22 August 2026**

**Entry:** none. All three have no inbound dependencies.
**Prediction:** `check:counts` fails on its first run against the current tree, at ≥3 sites. *If it passes, I have mis-measured and the audit is wrong.*

**Result: prediction held, and understated the defect.** The first run reported **15 false counts across 6 documents** plus one stale pin — not 3. Beyond the three the audit named, it found `records_added` stated as 8 where 23 were added (in two documents), `Documentation/` described as 26 Markdown files where there are 31, and the corpus described as 906 MB in `.gitignore` where it measures 2,079. `IMPLEMENTATION_PLAN.md`'s **prose contradicted its own machine-checked JSON block** — the document `check:plan` reads, in a claim `check:plan` does not check.

Two design corrections were forced during the build, both recorded in the code:

- **`check:corpus` shipped with one mode, not two.** It was designed with a fast inventory default and a `--deep` re-hash, on a measurement saying hashing 2 GB cost 11 seconds. That number was an artifact of 661 `sha256sum` process spawns; through one Node process it is **1.4 s**. The whole fast/deep split existed to excuse a weakness that was not there, so it was deleted rather than shipped — declining to add a seventh guard narrower than its name.
- **The first mutation probe was broken, and the control caught it.** All ten probes returned exit −1, including the no-op control, because `npm.cmd` does not resolve through `execFileSync` here. Running the checker files under the probe's own node fixed it. This is the second time in this repository a probe instrument, not the code, was the thing that was wrong.

**Verified:** 460 tests (+23), `verify` exit 0, **10 of 10 mutation probes** caught with clean controls at both ends.

### Phase β — the inner loop (Part 4) · **LANDED 22 August 2026**

**Entry:** Phase α green.
**Prediction:** gate feedback changes the smoke suite score by a *measurable* amount whose **sign I do not predict**. I-2 says improvements are not monotonic; predicting the sign would be the mistake this repository documents three times.

**Result: the prediction could not be evaluated, and the reason is a finding.** `eval/compile-smoke.json` does not run the pipeline. Every case calls `orchestrator.run({ stage_id: "compile" })` — the **single-stage** path — against a pinned provider stub. It measures the compile stage's honesty properties, which is what it was built for and what its name says; it cannot observe a `refine → lint` loop because it never reaches either stage. So Pipeline B, as built, measures **detectors and stage-level guarantees, not pipeline behaviour**, and no suite here can currently price a change to the pipeline's shape. Recorded in §6 with a closing condition.

What *was* measured: the mechanism end to end, through `runPipeline` with a scripted provider (7 Application cases, 12 Core cases), and its cost — exactly two stage executions per round, pinned by a test so an inserted stage cannot silently invalidate the depth arithmetic.

Three things landed differently from the spec, all recorded in the code:

- **No new `Configuration.gate_feedback` field.** The contract already carried the mechanism: `topology.kind: "reflexive"` with `max_iterations`, described as *"Required for reflexive topologies. The recorded hazard for verification loops is unbounded retry with no termination rule."* Adding a second cap for one loop is how contradictory configuration happens. What the schema lacked was **enforcement** — the requirement was prose, not a rule — so `configuration` 1.1.0 adds the `if`/`then` that makes the description true.
- **The cap is derived, not chosen.** Each round re-runs `refine` then `lint`, so `check:depth` now prices a round at two executions: 11 stages → 17 worst case at 3 rounds (91.84%, above the 90% target), and 6 rounds fails the build at 89.11%. "Why 3?" is answered by arithmetic.
- **`stage_attempt` was left alone.** It counts provider attempts within one execution — a deliberate earlier fix — so re-pointing it at executions would have silently undone that. `revision-entry` 1.3.0 adds `feedback_round` instead, because a bundle that is *longer* than its plan with no record of why is the mirror image of the gap `SKIPPED` closed.

**Verified:** 483 tests (+23), `verify` exit 0, **11 of 11 mutation probes** caught after two of my own tests were found unable to fail — a fixture whose WARN was a PASS, and a mutation that changed a critique's heading where only the whole string mattered.

### Phase γ — evidence and execution (Parts 2, 3) · **LANDED 22 August 2026, offline half only**

**Entry:** β complete; a provider key available; budget enforcement written before the first real call `[AUDIT C-3]`.
**Prediction:** first real 100-trial run completes with `provider_calls` under 40% of `cases × trials`, and `cache_read_input_tokens > 0` on the second identical request. *If cache reads are zero, a silent prefix invalidator exists and Part 3's caching claim is void.*

**Status: no provider key is available, so the live half did not run.** `ANTHROPIC_API_KEY` is unset and no `ant` profile exists. The first half of the prediction was verified against pinned stubs — a 100-trial run makes `CACHEABLE + FAILING × 100` calls instead of `14 × 100`, well under 40%. **The second half is untested and stays untested**: nothing here has ever spoken to a real provider, so whether the compiled prefix actually caches is unknown. `cache_read_tokens` exists on the contract and is never populated by anything.

**Built and verified offline:**

- **Part 2, the evidence plane.** `EvidenceStore` with no `update` and no `delete` — immutability expressed by the absence of a mutator rather than by convention — plus `adapters/evidence-local`, which writes with the `wx` flag so a duplicate fails in the syscall rather than in a check. No read-modify-write, so there is no cycle to interleave; `storage-local` does one per append, eleven times a run, and two concurrent runs there already race. A parameterized conformance suite scans `adapters/` and **fails if an implementation exists that it does not exercise**, so coverage is asserted rather than printed.
- **Part 3, the execution plane.** Budget admitted before dispatch (`refuse` or `truncate_suite`, no default), cost measured rather than declared, and caching at the provider boundary so the authoring pipeline gets it too.
- **The pipeline suite β proved was missing.** `eval/pipeline-smoke.json` drives `runPipeline`, so the depth plan, skips, partial degradation and the gate-feedback loop are measurable for the first time. Phase β's mechanism now has a suite that can see it.

**Two corrections to this specification, both found by building:**

- **ADR-0008's cache key is wrong, and so was §3 of this document.** The key `(config_hash, case_hash)` cannot both be correct and "what makes 100-trial protocols affordable". A repeated-trial protocol exists *because* decoding is stochastic; keyed on config and case alone, trials 2–100 are cache hits of trial 1 — one sample reported as a hundred, with a measured variance of exactly zero and a confident interval around it. The key now includes the trial index exactly when the configuration is stochastic, and caching pays across *runs* instead. Same shape as the detector-recall finding: an instrument whose sensitivity depends on the configuration will invert the conclusion. Here the instrument is the cache.
- **Failures are never cached, so caching cannot make a failing case cheaper.** A `ProviderFailure` is a statement about the provider at a moment; caching one turns a transient outage into a permanent answer, and — because demo mode maps a classified failure to a placeholder — would pin a run to `⟦WORKFLOW DEMO — no model⟧` for as long as the cache lived. The consequence is worth stating: a suite full of failing cases stays expensive to repeat.

**Verified:** 543 tests (+60), `verify` exit 0, **13 of 13 mutation probes** caught — after one survivor exposed a vacuous pass: a projection reporting `demo_mode: false` on a degraded run made every degradation detector pass, because those detectors are *conditional on that flag*. An instrument cannot also be what verifies itself.

### Phase δ — measurement you can defend (Parts 5, 6, 7) · **LANDED 22 August 2026**

**Entry:** γ complete. **Parts 6 and 7 land together** — perturbations without clustered statistics produce anticonservative p-values from day one.
**Prediction:** cluster-adjusted intervals are strictly wider than naive on the same data. *If they are equal, the expansion is not producing the clusters it is designed to produce and Part 6 is broken.*

**Result: held, and the gap is not marginal.** Twenty rows over four briefs, three of which improved. Declared unclustered, the comparator sees fifteen one-directional discordant pairs and reports **p ≈ 6 × 10⁻⁵** — a decisive improvement. Declared honestly, it sees **three improved questions out of four** and reports **p = 0.25**. Same code, same outcomes, opposite verdicts, and the naive one would have promoted.

The prediction spoke of intervals; this comparator reports p-values, so it was tested in that form. Recorded rather than quietly restated.

**Landed:**

- **Part 6.** Five seeded perturbations, four expectation-preserving and one deliberately not. `cluster_id` is written by the expander and never by a suite author — hand-assigned clustering would make every downstream confidence figure depend on how someone chose to group cases. A non-preserving variant gets its *own* cluster, because it asks a different question and pooling it would commit the exact error clustering exists to prevent.
- **Part 7.** `eval-suite` **2.0.0** makes `significance_protocol` required, discharging ADR-0008's open item — an optional field would have left it open. The comparator **refuses** `exact-mcnemar` on clustered data rather than reporting a caveated number, mirroring the recall-mismatch refusal that already existed. `comparison` 2.1.0 adds `effective_n`, the count of independent units behind a p-value.
- **Part 5, offline.** `judge-verdict` **1.1.0** adds `judge_family` — without it, ADR-0008's "the judge is never the model under test" could not be checked by anything — plus a `bias_panel` for the three of five named biases that had no field, and `measured_at` required with `agreement`, which is what makes the staleness rule enforceable. All three Enforcement rules ship **with** the adapter. `judge-verdict` left `pending-implementation.json`: the adapter exists and a conformance case validates a verdict it produced.

**Threat model neither prior phase named, now handled** `[AUDIT omission 1]`: a judge's input *contains the model's own output*, so grading is prompt injection with the attacker already inside the loop. The candidate is fenced with a content-derived nonce it cannot predict, and the judge prompt runs through `DELIMITER_ENTROPY` — a gate built for compiled prompts, pointed at a new surface — before it is sent.

**Also fixed in passing:** `eval-case`'s `failure_mode` was an unconstrained string in the schema while the TypeScript binding enumerated fifteen modes, so two invented modes validated cleanly against the contract that is supposed to be authoritative over the type.

**Verified:** 582 tests (+39), `verify` exit 0, **14 of 14 mutation probes** — after one survivor exposed a fixture too uniform to discriminate: every row in a cluster shared a pass value, so a broken accumulator produced the right answer by accident. Third time a probe has found one of my own tests unable to fail, and the third time for the same reason.

### Phase ε — promotion (Part 8) · **LANDED 22 August 2026**

**Entry:** δ complete **and** an anchor suite meeting its own declared resolvable delta. Below that the promotion gate can be satisfied but certifies nothing `[AUDIT C-7]`.
**Prediction:** the first promotion attempt is refused, by one of the five conditions. *A first attempt that passes all five suggests the gate is not armed.*

**Result: the entry criterion could not be met, because it named a quantity that did not exist.** "A suite meeting its own declared resolvable delta" assumes `resolution.detectable_delta` is a resolvable delta. It is not, and never was in any instance. Every suite here sets it to exactly `1/n` — its *score granularity* — and `compile-smoke.json` says so outright in its own comment block: *"It is not the same thing as the suite's statistical power."* The schema said the opposite, quoting the `z²/(2Δ²)` sizing rule inside the description of that very field. The comparator then used the declared figure as the floor below which a delta is inconclusive.

So the field meant three different things in three places, and the two that agreed were the instances and the consumer. **The schema was the one that was wrong**, and it is what changed (`eval-suite` **2.0.1**, description only). Granularity stays declared on the suite; statistical resolution is now *derived*, on the same principle that made `equalization` derived in `comparison` 2.0.0 — a guard the caller fills in is a guard the caller can satisfy.

**The sizing rule itself is optimistic by 2.9×, in three compounding steps.** `n ≳ z²/(2Δ²)` is the conditional McNemar rule with three parameters pinned and none of them written down: a **one-sided** z used to size a test the comparator runs two-sided; **power at 50%**, because the general form's `(z_α + z_β)²` carries no `z_β` here; and **discordance at 50%**, the most favourable value available. `check:sizing` prints the decomposition on every run:

```
as quoted: one-sided z, 50% power, p_d=0.5     3382 items
two-sided z, as the test is actually run       4802 items
...and at 80% power                            9812 items
```

The corrected form `n ≳ (z_α + z_β)²·p_d / Δ²` was checked against something outside this repository: τ²-bench reports 114 paired tasks as resolving roughly 15 percentage points, which the new rule reproduces at a discordance rate near a third. The old rule returns 61 for the same target. That cross-check is a test, not a remark — a formula that only agrees with itself is not evidence.

**The sharper instrument is exact and assumes nothing at all.** Under McNemar the statistic is binomial(d, 0.5), so the smallest two-sided p-value *any* arrangement of d discordant units can produce is `2·0.5^d`. At α = 0.05 that clears only from **six** upward. `eval/compile-smoke.json` has carried the sentence *"resolving a difference takes six flips, not one"* since it was written; the number lived in a JSON comment and no code knew it.

This is not the discredited post-hoc power calculation — nothing here is computed from the p-value. It is the support of the test statistic, which is a property of the design.

**Three consequences, each a live finding:**

- **`eval/pipeline-smoke.json` has five cases, so no comparison run on it can ever be significant.** Until now that reported as `p=0.0625 does not clear alpha=0.05` — indistinguishable from a suite that looked carefully and found nothing. `check:sizing` failed on its first run naming exactly this, and the fact is now recorded in `scripts/suite-sizing-acknowledgments.json` under the same stale rule as the divergence allowlist: the entry pins the case count and **fails as stale the moment the suite reaches six**.
- **Multiplicity correction can move the bar out of a suite's reach entirely.** At a family of 100, α = 0.0005 needs twelve discordant units; an eleven-case suite has eleven. A hundred comparisons against it is not a stricter search, it is a search that cannot return anything — and it would have reported a hundred honest-looking "inconclusive" verdicts while doing so.
- **Phase δ's headline number was the floor of its own range.** That phase reported the clustered analysis of its fixture as `p = 0.25` and called it inconclusive. `minAttainableP(3)` is exactly 0.25: with three discordant clusters, 0.25 was the smallest value that design could produce, whatever the data said. The comparator was reporting its own lower bound as a measurement. **Phase δ's finding was correct and understated** — the honest contrast is not "improved versus inconclusive" but *improved versus a design that could not have answered.*

**Part 8 landed as specified, with the five conditions intact:**

- **`promotion` 1.0.0**, every field but the timestamps a pointer, and `conditions` recording all five verdicts *with their reasons, in both directions*. A conjunction whose satisfied terms are not written down degrades into a rubber stamp the first time one of them silently stops being checked.
- **Two preconditions ahead of the five**, mirroring the comparator's "instrument before measurement": `Baseline.lineage` must be `benchmark`, and the evidence pointers must refer to one another consistently. `lineage` has existed since 1.0.0 and **nothing had ever read it**.
- **Rollback is the same record travelling the other way**, carrying the pointers of the promotion it reverses rather than fresh ones, so the record says what was believed at the time instead of erasing it. No conditions are re-evaluated: requiring evidence to go back would mean a bad promotion could not be undone without first producing the evidence that would have prevented it.
- **`CAPABILITY_MATRIX.md` is generated**, and `check:matrix` fails the build when the committed file is not what the repository produces — Part 8's named threat model. Its `Producers` and `Consumers` columns were *dropped*: deriving them needs a registration record nothing writes, and the hand-written draft got exactly that wrong by listing pure Core modules under "Implementing Adapters". A generated table with two honest columns beats five where three are guesses.

**`baseline` 1.0.0 → 2.0.0: `superseded_by` could never be written.** It is a backward pointer, set on an *existing* record when a later one replaces it — and `EvidenceStore` has no `update`, by a decision recorded in its own doc comment. Its description promised baselines are "append-only; superseding is recorded, never overwritten" while being the one field whose use required overwriting. The description was right; the field is reversed to `supersedes`. Free to take today and a migration tomorrow, which is precisely what landing a schema before its producer is *for*.

**`contracts/pending-implementation.json` is now empty**, and that is the terminal state rather than a milestone: all fourteen schemas are validated against values the running system produced.

**Also closed:** judge calibration now expires on a **declared cadence**, not only on a contract change. The old rule caught a judge whose model, rubric or template changed and missed the commoner case entirely — nothing changed, and the calibration is eight months old. Reported practice puts judge drift at 60–90 days with monthly re-calibration, so `Calibration.max_age_days` is required and deliberately undefaulted, like `Budget.on_exceed`.

**The prediction is not yet evaluable, for the same reason Phase γ's second half was not.** No run has ever been persisted from a real evaluation, so no *real* promotion attempt has been made — `promptnexus evidence` reports an empty plane and says so in those words. What did happen is one level down and in the predicted direction: **the first thing the new sizing guard did on its first run was refuse**, naming `pipeline-smoke`. The gate is armed and every one of its refusals is exercised; it has never fired in anger.

**Verified:** 623 tests (+41), **31 of 31 mutation probes** caught — after four survivors exposed real gaps in my own tests: a fixture where clusters *and* rows were both above the floor, so counting the wrong one was invisible; no assertion on the underpowered message; no test at all for the new cadence rule; and a matrix fixture where *every* schema was covered, which made a hard-coded `validated: true` indistinguishable from a derived one. **That last is the fourth time a fixture here has been too uniform to discriminate.** Two further survivors were errors in the probe itself, the sharper one being a mutation that disabled a rule *and* planted the data that rule catches — which asserts only that removing a guard removes its verdict.

**`npm run verify` is red on `check:corpus`, and not because of this work.** The 661-file `PDF/` corpus moved to `Documents/PDF/` — outside the repository — between sessions. Every file is intact and the manifest is untouched; the manifest pins a relative root of `PDF`, which no longer resolves. Left failing by decision rather than repaired by loosening the check, which is the option that would have cost the guard its meaning.

### Phase ζ — routing, then optimization (Parts 10, 11)

**Part 10 — LANDED 22 August 2026.** Entry (ε complete) was met, and routing is built: `core/src/routing/policy.ts`, pure, with `routing-policy` **1.0.0**.

**ADR-0008's open item is answered: routing needs no layer.** `decideRoute` returns a decision, the Application calls, `reduceRouteOutcome` reduces the classified outcome into the next decision. That is `decide → invoke → reduce` for the third time here — after the provider loop and the gate-feedback loop — and the fact that a router fits it without strain is the answer, not an argument for one.

**`configuration.router_policy_ref` had existed since 1.0.0 as a nullable string with no description, `null` in every instance.** Declared, and meaning nothing. 1.3.0 gives it one.

**The refusal is worth more than the policy.** A router is adopted on a cost number, and the quality argument beside it is nearly always *"the comparison was inconclusive, so quality held."* That reads a superiority test backwards. `inconclusive` says the suite could not separate the two configurations — and with these suites, none of which resolves below ~53 pp, it says very little. Equivalence is a different procedure with a different null hypothesis: non-inferiority against a declared margin. None is implemented, so `admitCostJustification` **refuses and names it**, exactly as the comparator refuses `bootstrap-ci` rather than substituting a test of a different question. A cost-justified promotion is refused even when quality *also* improved — promote that on the quality result, because accepting it here would open a path the next candidate would use without one.

Three shapes the validator refuses because they are indistinguishable from working ones: a **one-tier cascade** (validates, runs, never escalates, and reports itself as a cascade — indistinguishable from one whose cheap tier always sufficed); a cascade with **no `max_escalations`** (the hazard `topology.max_iterations` guards for the reflexive pipeline, by another name); and a **fixed policy carrying escalation settings** (a configuration describing behaviour it does not have).

That last one came from a probe and changed the code rather than the test. A mutation deleted the `method === "fixed"` early return in `reduceRouteOutcome` and nothing failed: the line was **unreachable**, since a fixed policy has no `escalate_on` for the next line to match. Dead code shaped like a guard is worse than no code — it invites the belief that something is protected and cannot fail visibly. The line is gone and the configuration it would have caught is refused at validation instead.

**Verified:** 337 core tests, **17 of 17 mutation probes** caught after two survivors — the second being that dead guard, and the first a test whose regex was loose enough to match a *different* rule's message, so it passed against a policy that had lost its termination rule entirely.

**Entry for 11:** an anchor meeting `requiredPairedSize(Δ, {alpha, power, discordanceRate})` for the declared target — **not** the `n₀ ≳ z²/(2Δ²)` this line used to name, which Phase ε showed understates by ≈2.9× and hides its assumptions — held outside the optimizer's write surface and proven so by probe; plus a Goodhart alarm on the generalization ratio. **Not scheduled.**

Phase ε strengthens the argument for leaving 11 unscheduled rather than weakening it. The optimizer's whole premise is that a search can distinguish candidates, and the exact floor says a suite of five cannot distinguish anything at all while the largest here resolves ~53 percentage points. An optimizer pointed at these suites would be selecting on noise it is structurally unable to detect as noise — and Bonferroni over a hundred candidates raises the required discordant count to twelve, above what any suite here can supply. The bar is now a number the build prints rather than a judgement call.

**Prediction:** none offered. Predicting an optimizer's effect before the evaluator that would measure it exists is the error the whole ordering is designed to prevent.

---

## 6. What this does not settle

A register with closing conditions, not a disclaimer.

| Open | Closing condition |
|---|---|
| ~~**No git remote.** 19 commits on one disk.~~ **Closed 23 August 2026.** `origin` is `github.com:hynix666/nexusprompt` (private); `master` is pushed and tracking, and `.github/workflows/verify.yml` ran `npm run verify` green on a clean Ubuntu checkout on its first execution. The guards now run somewhere other than the machine that wrote them, which is what the condition was actually about. | — |
| **Keyed fingerprints documented, bare `sha256` in code** `[AUDIT C-4]`. | The event port holds a deployment-scoped key and `orchestrator.ts` uses it. Out of scope here, in scope for the observability change that follows. |
| **`markStale` has zero callers and zero tests**; cascades by array position where the design says lineage. | `parent_revision_ids` is populated and the cascade follows it. Designed 21 Aug; unbuilt. |
| **Does per-stage validation actually mitigate the depth cliff?** The strongest untested hypothesis here. I-3 measured *unvalidated* chains. | Phase γ makes it measurable. If false, eleven stages is the wrong shape and this is the finding that would say so. |
| **Is gate-message text sufficient reflective feedback?** | Not settled by Phase β. The mechanism works and is capped; whether it *improves* anything is unmeasured. |
| **No judge has ever graded anything.** Part 5's policy, refusals, fencing and contract are built and tested against a scripted judge; a live one needs the same provider key Phase γ lacks. No `bias_panel` field has ever been populated by measurement. | A key, then a calibration run against 100–300 human-labelled traces with inter-annotator agreement reported alongside judge-to-human agreement. |
| **`bootstrap-ci` is declared and refused.** Graded and free-form metrics need it; the comparator returns `refused` rather than substituting a binary test. | The first suite that produces a non-binary metric. |
| ~~**No suite measures pipeline behaviour.**~~ **Closed 22 August 2026** by `eval/pipeline-smoke.json`, which drives `runPipeline`. Depth plans, skips, partial degradation and the gate-feedback loop are now measurable. | — |
| **Nothing has ever called a real provider — but the path now exists.** `runSuite` takes an optional `provider` (default: the stub, which is what keeps an `EvalRun` recomputable), and `npm run eval -- --live` composes the real adapter with caching on so the cache-read half of the prediction is testable at all. `ANTHROPIC_API_KEY` is still unset here, so it has never run; `--live` refuses up front rather than degrading every case. `cache_read_tokens` is populated by nothing and `usd` is arithmetic over *estimated* tokens. | A key, then one 100-trial run whose second identical request reports a non-zero cache read. Until then, no number this system produces is evidence about spend or about a model. |
| **599 is an upper bound**, not the independent-source count. | Title/DOI-level dedup over extracted first pages. |
| **A local model is on disk and cannot be driven.** `LLM/` holds an 811 MB int4 ONNX export — 16 blocks, 10 short-conv and 6 attention, `GroupQueryAttention` + `MatMulNBits` + `GatherBlockQuantized`, all `com.microsoft` ops with CPU kernels. It is an ONNX Runtime GenAI export and **`genai_config.json` is missing**, as is any `config.json`: head counts, head size, hidden size, context length and rope theta appear nowhere in the drop. Reconstructing them means guessing, and a wrong parameter yields fluent garbage rather than an error — which would defeat the demo-mode guarantee outright, since no gate can distinguish plausible text from a real answer. | The config lands with the model, or the parameters are recovered from the graph tensor shapes and a known-answer test pins one deterministic completion before the adapter is trusted. |
| **Significance protocol for graded and free-form metrics.** `bootstrap-ci` is named, not specified. | First suite that needs it, recorded per ADR-0008's *to revisit*. |
| ~~**Judge calibration cadence.** Practice says monthly; nothing here re-calibrates.~~ **Enforcement closed 22 August 2026**: `Calibration.max_age_days` is required and undefaulted, and `admitJudge` refuses with `expired-calibration` when nothing changed but the measurement is old. Re-calibrating still requires a judge and a gold set. | A calibration job runs against a gold set with an alert on κ drop. |
| ~~**The `PDF/` corpus has moved outside the repository.**~~ **Closed 23 August 2026** — moved back to `PDF/`; all 661 files re-hash clean against the manifest, which was never edited. The alternatives considered and rejected were an absolute root (machine-specific pin) and an env-var override (a guard looser than its name); the corpus moving back cost nothing and weakened neither. | — |
| **`detectable_delta` is granularity, and three documents still read it as resolution.** The schema is corrected (`eval-suite` 2.0.1) and the comparator now derives the statistical floor, but prose elsewhere in `Documentation/` may still conflate the two. | A pass over `Documentation/` for the conflation, or a `check:counts` pin that catches it. |
| ~~**No suite here can resolve anything below ~53 percentage points.**~~ **Closed 23 August 2026** — `eval/gate-recall-anchor.json`, 4,906 generated cases, resolves **2 pp** at 80% power with alpha, power and a *measured* discordance rate (0.2477 on a pilot, rounded up to 0.25) all written into the suite. Its ground truth is derived rather than authored: a fragment is injected and the case is kept only when exactly one previously-silent gate starts firing. It compares two sets that partition the registry, because a set against a subset of itself tests a null known false before any case is scored. **It certifies a `gate_set_ref` change, not model quality** — the population sampled is text the generator can produce. | — |
| **The anchor certifies detection, not quality.** No suite here measures a model, because none can without a provider. | A key, then an anchor built over model outputs rather than over gate verdicts. |

---

## 7. Success criterion

**This specification succeeds if, twelve months from now, someone can ask "is this configuration better than the one we shipped in August?" and get an answer that names an `EvalRun`, a significance result, a detector-recall block, and a judge calibration — or a refusal that names which of those is missing.**

It fails if the system can produce a number that looks like an answer but resolves to none of them. That failure is silent by construction, which is why every part above was admitted on one test: *what silence does it break?*

| Part | Silence it breaks |
|---|---|
| 0 · corpus | "the evidence base changed" |
| 1 · counts | "a document's number no longer matches the tree" |
| 2 · evidence | "this run was overwritten" |
| 3 · execution | "cost degraded correctness" · "the cache silently stopped working" |
| 4 · gate feedback | "this output failed a gate and nothing acted on it" |
| 5 · judge | "the grader is biased, stale, or grading itself" |
| 6 · perturbation | "this result holds only on clean input" |
| 7 · statistics | "this difference is noise" |
| 8 · release | "this claim has no run behind it" |
| 9 · monitoring | "the model changed underneath you" |
