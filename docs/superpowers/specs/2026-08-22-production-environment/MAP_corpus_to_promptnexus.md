# Phase 2 — Reasoning register

Each cluster maps to a named surface with a typed relation, the concrete change it licenses, and the observation that would show the relation is wrong. Falsifiers were checked; results are recorded inline.

**Relation-type counts: corroborating 4 · constraining 4 · extending 3 · contradicting 2 · excluded 2.** Two contradictions and four constraints is the shape of a corpus read against an artifact rather than for it.

---

## External sources

### E-1 — Anthropic API cost surface

**CLAIM** — Batch API processes asynchronously at **50%** of standard rates. Prompt caching serves a cached prefix at ~0.1× input cost (writes ~1.25×), verifiable through `usage.cache_read_input_tokens`; a zero read across repeated identical-prefix requests means a silent invalidator. Caching is a **prefix match**, render order `tools → system → messages`, minimum cacheable prefix ~1024 tokens.
**SURFACE** — Part 3, `application/src/execute.ts`, `eval-run.cost`.
**RELATION** — **extending**. ADR-0008 asserts repeated-trial protocols are affordable "because most cases never reach a model twice"; this supplies the second and third mechanisms and makes the claim measurable rather than asserted.
**LICENSES** — Cache key `(config_hash, case_hash)` as designed, *plus* a provider-level prefix discipline: the `COMPILER_SYSTEM` identity is byte-stable across every non-preview stage and belongs before the last cache breakpoint. Batch submission for any suite above a declared case count. `cost.cache_hits` populated from `cache_read_input_tokens`, not estimated.
**FALSIFIER** — If `COMPILER_SYSTEM` were rendered per-request with any varying content, prefix caching would never hit. **Checked**: `core/src/stages/stage-kit.ts` holds it as a frozen constant and `scripts/check-stages.mjs` verifies it verbatim. The prefix is stable by existing construction — this is a case where an invariant built for honesty turns out to pay for itself in cost.

### E-2 — GEPA: reflective prompt evolution

**CLAIM** — arXiv 2507.19457, ICLR 2026 oral. Evolves instructions by reflecting in natural language on execution traces rather than collapsing feedback into a scalar reward; outperforms MIPROv2 by >10–13% and GRPO by 20% with **35× fewer rollouts**, needing as few as 10 examples and 20–100 evaluations.
**SURFACE** — Part 4 (gate feedback), Part 11 (optimizer).
**RELATION** — **extending**, and *converging* with the internal corpus: `PROMPT_ENGINEERING_ENVIRONMENT.md` §3 derives a meta-harness objective from AutoDesign independently, and both land on "optimize the scaffold, not the model." Two unrelated derivations of the same primitive is the strongest warrant available here.
**LICENSES** — Two things, at different scales. Inner loop (Part 4): gate verdicts carry structured *text* explaining the failure, which is exactly the reflective signal GEPA consumes — so ADR-0008 action item 4 is not merely a control-flow change, it is the cheap end of the same mechanism. Outer loop (Part 11): the rollout economics undercut the "random search with a large bill" objection, but **not** the ordering argument.
**FALSIFIER** — If gate messages were verdict-only (`FAIL`, no text), the reflective claim would not transfer. **Checked**: every `GateResult` carries a `message`, and `core/test/*.test.ts` assert message content for all 16 gates. It transfers.
**HYPOTHESIS, labeled as such** — that gate-message quality is sufficient reflective signal *for this task*. GEPA's results are on QA and code benchmarks, not prompt compilation. Part 4's DONE WHEN measures the sign rather than assuming it.

### E-3 — LLM-judge bias practice, 2026

**CLAIM** — Five named biases with distinct measurements and mitigations: **position** (run both orderings, average), **verbosity** (length-normalize or penalize), **self-preference** (a judge inflates its own family's outputs; use a different family), **format**, and **calibration drift**. Calibration: 100–300 production traces, 2–3 human annotators, Cohen's κ ≥ 0.6 acceptable / ≥ 0.8 strong, judge-to-human agreement on the same scale, **monthly** re-runs with an alert on κ drop. A judge contract is (pinned model id, versioned rubric, hashed template); a judge swap is an eval-suite migration, not a config change.
**SURFACE** — Part 5, `contracts/judge-verdict.schema.json`.
**RELATION** — **constraining**. The existing schema is strong on two of five — it mandates `position_randomized`, `runs`, `disagreement_rate`, `rubric_hash`, and admits only chance-corrected agreement metrics. It has no field for verbosity, format, or self-preference, and `measured_at` is optional, so a stale calibration validates.
**LICENSES** — `judge-verdict` v1.1.0 adding a `bias_panel` block; `measured_at` becomes required whenever `agreement` is present; a `judge_family` field the adapter checks against the configuration under test.
**FALSIFIER** — If `judge_id` alone determined family, no new field would be needed. **Checked**: `judge_id` is a free string with `minLength: 1`; nothing derives a family from it and nothing forbids self-grading. ADR-0008's "the judge is never the model under test" is **written but not wired** — see AUDIT C-2.

### E-4 — Adding Error Bars to Evals

**CLAIM** — arXiv 2411.00640 (Anthropic, Nov 2024). Compute SEM via CLT; where questions are drawn in **related groups, compute clustered standard errors** — cluster-adjusted SEs can be **3× larger** than naive ones. Eval scores are positively correlated across models, so paired differences are a "free" variance reduction and the paired SE is recommended wherever practicable. Bootstrap CIs; power analysis at design time.
**SURFACE** — Part 6, Part 7, `core/src/eval/compare.ts`.
**RELATION** — **contradicting**, and this is the most consequential finding in the register. The comparator's exact-binomial McNemar over discordant pairs is correct for *independent* paired binary outcomes. Part 6 introduces perturbations — variants of the same base case — which are precisely "questions drawn in related groups." The moment perturbations ship, the current test's independence assumption fails and every p-value it reports is anticonservative by up to 3×.
**LICENSES** — `cluster_id` on `EvalCase`; a clustered variant in `core/src/eval/cluster.ts`; and a **refusal path**: the comparator returns `inconclusive` rather than a number when a suite is clustered and the configured protocol assumes independence. `eval-suite` gains a required `significance_protocol`, which also discharges ADR-0008's open item "record the significance protocol per suite type before running comparisons that anyone will cite."
**FALSIFIER** — If the intended perturbation design produced independent cases, clustering would not apply. **Checked**: ADR-0008 specifies expansion as `cases × perturbations`, which is a within-case product — the definition of a cluster. The exposure is real and is created by a feature not yet built, which is the cheapest possible moment to find it.
**Ordering note** — this source's conditions match the target well (paired binary outcomes, model comparison), but its clustering guidance assumes clusters are known at design time. Here they are, because the expansion generates them.

### E-5 — Prompt CI/CD and registry practice, 2026

**CLAIM** — "A prompt registry that does not gate against your eval suite is just a config store." The shape in production use: immutable versioning, validation against a golden dataset, promotion gated on eval scores in CI, weighted rollout, rollback by repointing a label. Promptfoo (MIT) is the common CI gate; thresholds block merges.
**SURFACE** — Part 8, Part 2.
**RELATION** — **corroborating**. Independently reproduces ADR-0008's Pipeline C from industrial practice rather than from the paper corpus — a second, unrelated derivation of promotion-gated-on-evidence.
**LICENSES** — Nothing new architecturally. It does license one *naming* correction: what ADR-0008 calls the registry is, in this vocabulary, a registry **plus** a gate, and the gate is the part that carries the value. It also supplies the rollback primitive the ADR omits: promotion is a label repoint, so rollback is a repoint too, not a rebuild.
**FALSIFIER** — If the repository already had a rollback story, this would add nothing. **Checked**: `RELEASE_OPERATIONS.md` describes build-hash reproducibility and byte-parity exports; it does not describe reverting a promoted configuration. Genuine gap.

### E-6 — OpenTelemetry GenAI semantic conventions

**CLAIM** — As of mid-July 2026 **every** `gen_ai.*` attribute, span, metric and event carries stability "Development"; none is Stable. At v1.42.0 (12 June 2026) they moved out of the main semconv repository into a dedicated GenAI repository — an organizational change with its own cadence, explicitly not a graduation. Recommended posture: adopt while pinning the convention version.
**SURFACE** — `OBSERVABILITY.md`, the event spine.
**RELATION** — **corroborating**, with one fact ADR-0008 could not have had. The ADR's "deliberately not adopted: `gen_ai.*` as the internal contract" was decided on churn risk; the repo split confirms the churn is structural, not transitional.
**LICENSES** — Keep the internal event spine as the contract; add a **pinned** export mapping (`semconv_version` recorded on export) rather than an unpinned one. Mirror the span-tree structure, not the names — unchanged from the ADR.
**FALSIFIER** — A Stable release would flip this to "adopt directly." Not observed; re-check at each semconv release.

---

## Internal corpus clusters

### I-1 — Silent-failure taxonomy → the architecture's purpose

**CLAIM** — Fifteen system-level failure modes; the recurring property is absence of an error signal ("silently propagate… without any error signal"; truncation produces "no failure signal"; cost-driven degradation degrades correctness "without triggering alerts"). Conclusion: "these breakdowns are indeed not model failures but system failures."
**SURFACE** — every part.
**RELATION** — **corroborating**, and it supplies this specification's admission test: *what silence does this break?* Any part that adds capability without adding a signal is rejected.
**LICENSES** — The signal column in SPEC §2. Two parts were cut by this test during drafting (see AUDIT C-5).
**FALSIFIER** — A proposed part that manufactures no signal but is still worth building would weaken the rule as an admission test. One candidate: caching (Part 3) is pure cost reduction. **Resolved**: it manufactures `cache_hits`, which is the signal for "a silent invalidator is at work" — a real failure mode with no other alarm.

### I-2 — The prompting inversion

**CLAIM** — Constrained prompt beat CoT on gpt-4o (97 vs 93) and **lost** on gpt-5 (94.00 vs 96.36); generic improvement rules cut a compliance suite 26/30 → 9/30; decomposition net negative 34% against single-shot on a modern model.
**SURFACE** — `Configuration` as the versioned unit; the catalog's status as hypothesis space; Loop D.
**RELATION** — **constraining**. It forecloses the most natural feature — a recommendation engine over 195 technique records — and it is why Part 9 is cheap and high-coverage rather than optional.
**LICENSES** — No catalog recommendation without a measured configuration; `provider_model_fingerprint` watch as a first-class build failure.
**FALSIFIER** — If inversions were rare rather than systematic, a static recommender would be defensible. Three independent measurements across different tasks and model generations; not rare.

### I-3 — Depth and the reliability cliff

**CLAIM** — 99%/step → 90.4% at 10 steps, 36.6% at 100. Measured behaviour is a cliff, not a curve: GPT-4o Mini 100% at 4 steps, **0% at 5**; all seven models tested scored 0% at 11–12 steps. Architecture ranking inverts with load: reflexive best at 1k docs/day (F1 0.943), **worst at 100k** (0.871).
**SURFACE** — the eleven-stage pipeline; Part 4's retry cap; Part 10.
**RELATION** — **constraining**, with a boundary condition that must be stated inline. The cited measurement is of an *unvalidated reasoning chain*, not of separate calls with typed contracts and validation between stages. It does not condemn eleven stages; it says depth without per-stage validation is where the cliff lives, and quantifies how little depth is available without it.
**LICENSES** — Per-stage schema + gate + persisted revision restated as the mitigation's *purpose*. Bounded loops with the cap in the contract (Part 4). Architecture as a `Configuration` parameter to be measured (Part 10), not a decision made once.
**FALSIFIER** — If per-stage validation did not change the compounding, the mitigation would be decoration. Untested here — **labeled a hypothesis**, and it is the one this repository is best positioned to measure once Part 3 exists.

### I-4 — Self-modification invariants

**CLAIM** — Disjoint ownership (file-level locking is the wrong primitive: it serializes the write, not the read–compute–write cycle); the conservative join (evidence valid on both a structural and an evaluator clock, else quarantine) with α·ν ≤ λ/|U|; anchored evaluative authority, where a cycle in the "grades" relation **constructs** reward hacking rather than risking it. An anchor must be *sized* — n₀ ≳ z²/(2Δ²) ≈ 3,400 items for a 2-point target at ε=0.05 — and anchoring is selection, not containment: sweeping anchor size 25 → 3,200 raised true utility 20% while raising the specification gap 709%.
**SURFACE** — Part 5 (judge ≠ model under test), Part 7 (anchor sizing), Part 11.
**RELATION** — **constraining**. It is the formal reason Part 11 is last and the reason Part 5's self-preference check is structural rather than advisory.
**LICENSES** — Gate registry and differential oracle outside any optimizer's write surface, proven by probe; Goodhart alarm on the generalization ratio; the two-set split (fast smoke, sized anchor) rather than one conflated suite.
**FALSIFIER** — If the anchor bound were satisfiable here, promotion could be certified today. **Checked**: `requiredAnchorSize(0.02)` in `core/src/eval/compare.ts` returns ≈3,400; the largest suite has 14 cases. **The repository cannot certify a 2-point improvement and must say so** rather than reporting one. Recorded in SPEC §7.

### I-5 — LLMRouter

**CLAIM** — Routing decomposes into context encoder, model encoder, scoring function, decision rule, learning signal. Adding a router requires "implementing only a routing method and a loss function"; 16+ routers built on that seam. Routers are evaluated on quality **and** cost under one protocol.
**SURFACE** — Part 10, and the seam template generally.
**RELATION** — **extending**. Cited for its structural decomposition, not its results — it reports one system, one benchmark family.
**LICENSES** — The two-function seam shape for detector, judge, perturbation and router alike; routing policy pure in Core, selection in Application.
**FALSIFIER** — If a router needed an effect to decide, the placement would break I2. Scoring over a context and a model table is a pure function; invocation is not. Placement holds.

### I-6 — The catalog's verification partition

**CLAIM (as documented)** — `verifier-checkable` 137, `judge-checkable` 8, `unverifiable-by-text` 35, total 180, and ADR-0008 names this partition "the routing rule" for deciding what may reach a judge.
**SURFACE** — Part 5's routing check.
**RELATION** — **contradicting**. Measured from `core/src/catalog/techniques.json`: **151 / 10 / 34, total 195.** The documented partition is stale in all four numbers.
**LICENSES** — Part 1. The fix is not to correct three documents — it is that no checker reads them.
**FALSIFIER** — If `check:plan` covered these documents the drift would have failed the build. **Checked**: `check-plan.mjs` reads `Documentation/IMPLEMENTATION_PLAN.md` only. Confirmed R9 instance #7.

---

## Exclusions

| Cluster | Reason | Re-inclusion condition |
|---|---|---|
| `PDF/Memory` (25 docs) — agent long-term memory, temporal knowledge graphs, semantic consolidation | No surface. This environment authors and evaluates prompts; it holds no cross-session agent state. Including it would license a memory subsystem nothing in the artifact needs. | If Loop D's "production failures become new cases" grows into a retrieval problem over accumulated runs, the consolidation results become directly relevant. |
| `PDF/RAG` (134 docs) — retrieval architectures, chunking, agentic RAG | Mostly out of scope *as architecture*, but **not fully excluded**: `retrieval_config` is already a component of `Configuration`, and three gates (`RAG_SHIELD_GAP`, `DELIMITER_ENTROPY`, `QUTM_CEILING`) exist because of this literature. Excluded as a subsystem, retained as gate provenance. | Building a retrieval adapter, or any suite whose cases carry retrieved context. |

Exclusion by directory name is a heuristic, and heuristics get audited. `PDF/RAG` was nearly excluded wholesale before the gate-provenance link was checked — see AUDIT C-6.

---

## Non-exposures

An audit that reports only problems has unknown calibration. Three checks that came back clean:

1. **The scorer does not call the model.** The common shape in external harnesses is a scorer that invokes an LLM inline, which makes historical recomputation impossible and hides judge cost inside the score. Invariant I1 forbids it statically: `core/src/eval/detectors.ts` cannot import anything effectful, and `scripts/check-boundaries.mjs` reads every file rather than relying on test coverage. **Verified — not exposed.**
2. **Cost is not a report appended after the fact.** `eval-run.cost` makes `budget_exceeded` a required boolean rather than an optional metric. The failure mode E-1 warns about — cost-driven degradation with no alert — has a field. (Enforcement is a separate matter; see AUDIT C-3.)
3. **Exact-match agreement is inadmissible.** External practice warns that exact match overstates discriminative ability; `judge-verdict.schema.json` admits only `cohens-kappa`, `krippendorff-alpha`, `scotts-pi`. **Verified — the schema forecloses the mistake before a judge exists.**

## Single-source dependencies

Named here so that if one is wrong, exactly one part fails.

| Dependency | Sole source | Part it carries | Containment |
|---|---|---|---|
| Clustered SEs up to 3× naive | E-4 | Part 7 | Part 7's refusal path degrades to `inconclusive`, never to a wrong number. If the 3× figure is off, the refusal is still correct. |
| Anchor bound ≈3,400 items at Δ=2pp | I-4 (two unreviewed drafts in `PDF/pipeline/`) | Part 7's certification threshold | Already implemented as a *function* (`requiredAnchorSize`) with the confidence and delta as parameters, so a different constant is a call-site change, not a redesign. |
| GEPA rollout economics | E-2 | Part 11 only | Part 11 is specified and unscheduled. Part 4 does not depend on the numbers, only on the mechanism. |
| Judge bias taxonomy (five) | E-3 | Part 5's `bias_panel` | Additive schema block; an extra or missing bias changes fields, not architecture. |

## Composition map

```
Part 1 (claim checker) ──► guards the numbers every other part cites
Part 0 (corpus)        ──► guards Part 1's corpus claim

Part 2 (evidence plane) ─┬─► Part 3 (execution) ──► Part 6 (perturbation) ──► Part 7 (statistics) ──► Part 8 (release) ──► Part 10 ──► Part 11
                         └─► Part 5 (judge) ─────────────────────────────────┘

Part 4 (gate feedback)  ──► independent; measured by the existing smoke suite
Part 9 (fingerprint)    ──► independent; needs only ExecutionProvenance
```

**What breaks if each is wrong**

- **Part 1 wrong** → stale numbers keep shipping; nothing else fails. Cheapest part, widest blast radius if omitted.
- **Part 2 wrong** → Pipeline C has nothing to read; B still runs and reports.
- **Part 3 wrong** → evaluation stays offline-only. Everything downstream degrades to "measured against pinned stubs", which is honest but not evidence about a model.
- **Part 5 wrong** → judged cases are unusable; verifier-checkable cases (151 of 195) are unaffected. This is why the routing rule is load-bearing: it bounds the judge's blast radius to a fifth of the catalog.
- **Part 6 wrong** → results overstate robustness. Detectable only by Part 7 refusing.
- **Part 7 wrong** → **the worst failure in the set**: a confident wrong promotion. Contained by the refusal path and by Part 8 requiring significance ∧ no-regression ∧ budget ∧ calibration ∧ equalization jointly, so no single check carries the promotion alone.
- **Part 9 wrong** → silent provider drift, which is the one failure class offline evaluation structurally cannot catch.
