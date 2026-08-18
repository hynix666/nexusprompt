# Extension seams, routing, and the optimization loop

**Status: design, not built.** A companion to [ADR-0008](./0008-evaluation-first-environment.md), which owns the decision that evaluation is the primary subsystem and specifies the evaluation, authoring and release pipelines, the contract changes, and the scalability logic.

This page deliberately does **not** restate any of that. It covers five things the ADR leaves open, drawn from the infrastructure and pipeline literature rather than the prompting literature:

1. where extension points fall, and why that is what "scalable" means here
2. routing, which the ADR lists only under *to revisit*
3. the optimization loop that sits above the authoring pipeline
4. how a self-modifying system keeps evaluative authority — including **one correction to an action item in ADR-0008**
5. pipeline depth as a first-order variable, with the measured reliability data

Sections 4 and 4a draw on material in `PDF/pipeline/` that is not in the earlier corpora: two formal drafts on harness-optimizer composition, and three evidence tables with per-row source attribution.

---

## 1. Seams — scalability as the cost of the two-hundredth addition

Throughput is not the scaling problem in this system. The scaling problem is **what it costs to add the next gate, scorer, technique, judge, or provider** — and the failure mode is well-evidenced: of the seventeen prototypes surveyed in `SOURCE_VERIFICATION.md`, none had a registry, and not one grew past its author's original set. **The hardcoded list is the ceiling.**

The design rule is that each extension point requires implementing the minimum that cannot be defaulted, and nothing else:

| Extension | Author implements | Registration | Status |
|---|---|---|---|
| Gate | one pure function | one registry line + `ported-gates.json` entry | **built** |
| Technique | one record | import boundary, contract-validated | **built** |
| Provider | `generate` + `healthCheck` | composition root | **built** |
| Detector / scorer | `score(candidate, expectation, config) → Score` | one registry line | to build |
| Judge | `grade(candidate, rubric) → JudgeVerdict` behind the port | composition root | to build |
| Perturbation | `perturb(case, seed) → case` | one registry line | to build |
| Router | a routing method **and** a loss function | one registry line | to build |

The router row is copied deliberately. [LLMRouter](https://arxiv.org/abs/2608.06867) reports that adding a router to its library requires "implementing only a routing method and a loss function", with more than sixteen routers built on that seam. That is the shape to aim for everywhere: a two-function interface with the registry supplying everything else.

**The registry is also where the contract is enforced.** `import:catalog` already refuses an addition that collides with a frozen id, omits a required field, or names a `related_techniques` target that does not resolve — the last of which caught a real error in hand-written data on its first run. A seam without a validating registry is just a convention.

---

## 2. Routing — a component with a decision rule, not a configuration constant

No single model is optimal across all queries and budgets, so model selection is a decision the system makes repeatedly, and a decision made repeatedly deserves a contract.

[LLMRouter](https://arxiv.org/abs/2608.06867) formalises routing as a sequential decision process decomposed into five parts:

```
context encoder  →  ┐
model encoder    →  ├─►  scoring function  →  decision rule  →  selected model
                    ┘                              ▲
                                            learning signal
```

Two properties transfer directly.

**Routers are evaluated on quality *and* cost, under one protocol.** A router judged on quality alone always selects the largest model, which is not a router. This is the same discipline ADR-0008 applies to techniques — cost is a dimension of the result, not a footnote to it — and it means the evaluation pipeline's `EvalRun` needs no special casing to evaluate a router: a routing policy *is* part of a Configuration.

**The learning signal is a first-class component**, which is what makes a router improvable rather than hand-tuned. It is also what makes routing dangerous without ADR-0008 in place first: a router trained against an unmeasured objective optimises toward whatever the objective actually rewards.

**Placement.** Routing is a decision, so the *policy* is pure and belongs in Core; the *selection and invocation* is an effect and belongs in the Application layer, alongside retry and budget. This is `decide → invoke → reduce` again, and it means routing needs no new layer — which answers the question ADR-0008 leaves open under *to revisit*.

---

## 3. The optimization loop — a meta-harness over the authoring pipeline

[AutoDesign](https://arxiv.org/abs/2608.13560) supplies the cleanest framing available for what an optimizer in this system actually optimises. It defines a **meta-harness** as a system that operates on the harness, with the objective

> J(H) = E<sub>(x,c)~p<sub>task</sub></sub> [ R<sub>meta</sub>(y, x, c) ]

and makes the point that matters: *"the optimization acts on the system surrounding the model rather than on the model itself"* — the model-versus-scaffold distinction. Model weights are fixed; the scaffold is the variable.

```
outer loop — meta-harness                inner loop — authoring pipeline (Pipeline A)
   propose a candidate Configuration  ──►   run Pipeline B (evaluation)
        ▲                                        │
        └────── objective = EvalRun verdict ◄─────┘
```

Four constraints keep this from becoming random search with a large bill:

- **The objective is Pipeline B's verdict**, not a scalar invented for the optimizer. An optimizer sitting on an untrustworthy evaluator amplifies the evaluator's errors — which is the structural reason ADR-0008's ordering is not negotiable.
- **Constrained, not free.** Gate verdicts and the cost budget bound the search space rather than trading off against quality. The automatic-prompt-engineering survey names constrained optimisation an underexplored frontier; for production it is the only responsible form.
- **The unit of proposal is a Configuration**, per ADR-0008 — prompt text, model, decoding parameters, retrieval and tool config together. Optimising prompt text alone reproduces the inversion problem the ADR documents, where a prompt that wins on one model generation loses on the next.
- **Every proposal is an `EvalRun`.** The optimizer produces evidence as a side effect of running, or it produces nothing checkable.

---

## 4. Self-modification: three invariants, and one correction to make now

Once an optimizer can change the scaffold, the system modifies itself. [Ouroboros](https://arxiv.org/abs/2608.08311) gives the operational shape — a harness whose "tools, context assembly, prompts and core implementation improve through **reviewed commits** that become the runtime for later work", with benchmark campaigns on frozen seeds while live evolution proceeds on a separate lineage.

Two drafts in `PDF/pipeline/` — *The Self-Improving Layer Is Not Exempt* and *When the Bottom Layer Moves* — give the formal account, and they are more demanding than the operational one. They state three invariants and prove that every reported failure class in this literature follows from violating one of them. Their setup matters: harness effects range 13–42 pp at fixed backbone, but backbone upgrades within a fixed harness move performance comparably, and **scaffold complexity does not predict effectiveness**.

**Invariant I — disjoint ownership.** For distinct optimizers, write surfaces are disjoint, and producer–consumer relationships go through explicit versioned contracts rather than shared mutable state. The accompanying proposition shows that if this fails, some schedule produces a configuration *neither optimizer ever observed* — and that **file-level locking is the wrong primitive**, because it serialises the write but not the read–compute–write cycle. This is the layer-and-contract discipline ADR-0001 and ADR-0005 already impose, restated as a concurrency requirement.

**Invariant II — the conservative join.** Evidence counts toward attribution only when valid on **both** a structural clock and an evaluator clock; where they disagree the record is quarantined, never reinterpreted. Keying on one clock alone admits stale evidence *without raising an error*, which is why the defect is invisible to systems tracking a single counter. Two consequences worth having:

- **α · ν ≤ λ / |U|** — attribution depth times structural change rate is bounded by throughput per unit. Frequent restructuring and deep per-unit attribution are jointly unattainable at fixed throughput. This turns "budget your structural change" into a computable constraint with three observable terms.
- Quarantining *more* units does not lengthen the recovery window, because quarantined units recover in parallel. Conservatism here is cheap, which is the opposite of the usual intuition.

**Invariant III — anchored evaluative authority.** The "grades" relation must be well-founded with a unique minimal element, and that anchor must not be writable by any optimizer. The converse is the sharp result: **a cycle in the grades relation does not merely risk reward hacking, it constructs it** — given only that the search can find higher-scoring evaluators, which is the capability the search exists to have.

### The correction

An earlier version of this section said the gates "constrain the search, so they must not be reachable by it". That is Invariant III, and it is **necessary but not sufficient**. Two results say so directly, and both change what ADR-0008 must specify:

**An anchor must be sized, or it certifies nothing.** Well-foundedness is satisfied vacuously by an uninformative anchor. Resolving a true gap Δ at one-sided confidence 1−ε needs

> n₀ ≳ z<sub>ε</sub>² / (2 Δ<sub>target</sub>²)

which for ε = 0.05 and a 2-percentage-point target is **≈ 3,400 anchor items**. Below that, two evaluators differing by less than the resolution are indistinguishable, the tie-break retains the incumbent, and no improvement is ever certified.

This is in direct tension with ADR-0008's action item 3, *"a golden set small enough to run offline in seconds"* — and both are right, for different jobs. The resolution is **two sets, named differently**: a small fast **smoke set** that gates every change, and a large **anchor** that alone may certify a promotion. Conflating them yields either a suite nobody runs or a promotion nobody can justify.

**Contamination flows through the scorer.** Sample disjointness of a held-out set is *insufficient*. If the scorer was selected using the optimization set, the promotion decision carries information about that set even when the items are disjoint. The guarantee requires **both** H ⊥ O **and** s ⊥ O. ADR-0008's `EvalRun` therefore needs the scorer's provenance, not only the dataset's — a scorer tuned on the optimization set invalidates the held-out claim silently.

**And anchoring is selection, not containment.** *When the Bottom Layer Moves* reports that increasing anchor precision *increases* the accumulated specification gap: sweeping anchor size 25 → 3,200 raised true utility by 20% while raising the gap by 709% and driving the generalization ratio from 0.572 to 0.173. An anchor constrains which candidate is promoted; it places no bound on how far the promoted candidate's measured utility diverges from its real one. Plan for detection — a Goodhart alarm on the generalization ratio — not for prevention by anchoring alone.

### What follows for this repository

The gate registry and its `ported-gates.json` pin sit outside any optimizer's write surface; a change to a guard is a separate reviewed commit, never part of a candidate Configuration; and the differential oracle ([ADR-0007](./0007-permanent-differential-oracle.md)) keeps checking gates against an implementation the optimizer cannot reach. That last one is Invariant III with an anchor that is, by construction, not writable — which is the property the frozen Python linter had all along.

---

## 4a. Pipeline depth is a first-order design variable

`PDF/pipeline/` includes three evidence tables with per-row source attribution. The reliability table is the most consequential thing in this corpus for an eleven-stage pipeline.

**Compounding is exponential, and the constants are unforgiving.** At 99% per-step success: 10 steps → 90.4%, 100 steps → 36.6%, 1,000 steps → 0.004%. At a more realistic 85% per-step: 5 steps → 44%, 10 steps → ~20%, 20 steps → effectively 0%. The cited source uses this to argue for *architectural* rather than model-quality solutions, which is the right reading.

**Measured behaviour is worse than the smooth model — it is a cliff.** In a seven-model comparison on stepwise algebraic reasoning, GPT-4o Mini scored **100% at 4 steps and 0% at 5**. The most resilient models tested stayed non-zero to 9 steps. **At 11–12 steps, all seven models scored 0%.**

The honest reading matters here. That measurement is of an *unvalidated reasoning chain*, not of a pipeline of separate calls with typed contracts and validation between stages — which is precisely what this architecture is. The finding does not condemn an eleven-stage pipeline; it says that **depth without per-stage validation is where the cliff lives**, and it quantifies how little depth is available without it. Each stage boundary in this design carries a schema, a gate set, and a persisted revision. That is the mitigation, and it is now worth stating as its purpose rather than as a side effect.

**Architecture ranking inverts with load.** In a four-way comparison on financial document processing, a reflexive self-correcting architecture was best at 1,000 documents/day (F1 0.943) and **worst at 100,000** (0.871), falling below hierarchical, parallel and sequential — because queuing-induced timeouts truncate the correction loops. The reported mitigation is specific: hierarchical supervision with semantic caching, confidence-gated model routing and escalation-on-failure retry recovered ~89% of the reflexive gain at ~1.15× sequential cost.

This is the same inversion pattern ADR-0008 documents for prompts across model generations, now for *architecture across throughput*. It means the architecture choice is a Configuration parameter to be measured, not a decision to be made once — and it is another argument for the routing seam in §2, since confidence-gated routing is one of the three components in that mitigation.

**Two further rules from the pattern table**, both cheap:

- **Bounded loops.** The recorded hazard for verification loops is "unbounded retry without a termination rule"; the mitigation is an explicit iteration cap. Agentic-RAG rows put the practical hop cap at 2–3 before latency dominates. Any `Retry` in §3.1 needs a cap in the contract, not in a comment.
- **Inspectable intermediates are an audit requirement.** Comparing cascaded and unified speech-to-speech voice pipelines, the row for the unified architecture records that "loss of an inspectable intermediate transcript makes independent per-stage grading and compliance auditing impossible." Per-stage revisions are not overhead; they are what makes per-stage grading possible at all.

---

## 5. What keeps the codebase itself honest

These are not style preferences. Each was measured in this repository this month, and the mutation data is in the git history.

**Every invariant needs a second, independently-authored checker.** The strongest finding available here, and it recurred in four different subsystems:

| Defect | Found by | Missed by |
|---|---|---|
| Gate regex reverted to a shipped bug; key-length bound widened | differential oracle | the entire test suite |
| Eight wrong citation titles | arXiv metadata | the internal consistency checker, which passed all 172 |
| Two invented vocabularies | the frozen XSD | the JSON Schema, which typed them as free strings |
| `node:fs` reachable from Core | static import scan | the runtime purity harness |

Not one was found by making the first checker stricter. This is [ADR-0007](./0007-permanent-differential-oracle.md)'s argument observed three more times, and it is why ADR-0008 requires detector-recall equalization before comparison: an instrument that has not itself been measured is not evidence.

**A guard's scope must be probed, not assumed.** Three guards here were silently narrower than their names — the purity harness never blocked the filesystem, `typecheck` covered a third of the code, the cross-shell rule missed relative imports. All three passed continuously while incomplete. Plant a defect in *each place the guard is believed to cover*.

**Mutation-prove every guard, and measure by exit code.** An early probe reported five surviving mutations because it grepped colourised output that never matched. The instrument was broken, not the code.

**Generated artifacts need a `--check` mode.** `import:catalog --check` fails when the committed file is not what the inputs currently produce. Without it, a generated file is one somebody edited once.

**Never edit frozen inputs; correct at the boundary.** Eight wrong titles live in hash-pinned `sources/`. They are fixed in `catalog-corrections.json` with `from`, `to`, reason and evidence, and the import refuses if the frozen value stops matching `from` — so a stale correction cannot apply silently.

**Allowlists must expire.** A known defect is excused only with a stated reason, and an entry whose defect no longer occurs **fails as stale**. An allowlist that outlives its problem silently excuses the next one.

---

## What this page does not claim

- **Not that any of it is built.** Routing, optimization and the meta-harness are design. The status table in [`README.md`](./README.md) is authoritative and `npm run check:plan` enforces it.
- **Not that the optimizer should be built soon.** It is last in the order for a reason: it is the component that most amplifies a weak evaluator, and ADR-0008's pipeline does not exist yet.
- **Not that the infrastructure papers generalise.** LLMRouter, AutoDesign and Ouroboros each report on one system, one benchmark family, one set of models. They are cited here for their *structural* decompositions, which transfer more readily than their results.
