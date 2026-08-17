# ADR-0008: Evaluation Is the Primary Subsystem, and Runs Are Attributable or They Are Nothing

## Status
Accepted — 17 August 2026. Constrains the Application layer, the contract set, and the phase order in `IMPLEMENTATION_PLAN.md`. Amends nothing; extends [ADR-0005](./0005-application-orchestration-boundary.md) and [ADR-0007](./0007-permanent-differential-oracle.md).

**Deciders:** whoever owns Core and the build pipeline.

*(Follows the section convention of ADR-0001 through ADR-0007.)*

## Context

The environment can compile a prompt, lint it against two gates, degrade honestly when no model answers, and persist the run. It cannot say whether any output is **good**, whether a change made it better, or whether a technique from the 180-record catalog helps on a given task. There is no dataset, no scorer, no baseline, no verdict.

That is not one missing feature. It is the absence of the subsystem every other claim depends on. `CAPABILITY_MATRIX.md` is explicitly illustrative because nothing generates evidence for it. The catalog's `when_to_use` fields are assertions copied from papers. Any optimizer built before this exists would be maximising a quantity nobody has defined.

Two facts from the literature review sharpen what the subsystem has to do.

**A score is a four-way function.** Ouroboros (arXiv 2608.08311) states it directly: *"Agent scores on long-horizon benchmarks are products of the base model, the execution harness, the environment, and the grader."* [SoK: Systematizing LLM Prompt Security](https://arxiv.org/abs/2510.15476) reaches the same place from the security side — incompatible threat models, budgets, datasets and success criteria make published numbers incomparable, and its remedy is to treat every experiment as an explicit tuple with declared cost and access metadata.

**The received wisdom about techniques does not survive measurement.** [Toward Epistemic Stability](https://arxiv.org/abs/2603.10047), 100 trials per strategy in an industrial setting, found a data registry winning 100/100 while *decomposed prompting was net negative at 34%* against single-shot on a modern model. A catalog used without measurement will recommend the losing strategy with a citation attached.

Constraints in play: solo execution, no CI service, no git remote, provider calls cost money and time, and `sources/` is hash-frozen.

## Decision

**Make evaluation a first-class plane of the architecture, and make the attributable run its unit of work.**

Three parts:

1. **An Evidence plane**, cross-cutting like the observability spine — datasets, runs, scores and baselines, immutable once written. It observes every layer and no layer depends on it.

2. **`ExecutionProvenance` is extended to the full attribution tuple.** It currently records build hash, contract versions, provider/model fingerprint and config fingerprint. It must also record **decoding parameters and seed, dataset version, grader identity, and cost budget**. A run missing any of these is not comparable to another run and must not be scored against a baseline.

3. **Deterministic scoring is Core; judge-based scoring is an adapter behind a port.** The offline half of the suite then runs in milliseconds at zero budget, which is what makes it a suite people actually run.

Phase order changes accordingly: the evaluation pipeline moves ahead of further gate porting, stage porting, and any optimizer.

## Options considered

### Option A — Evaluation as a plane, attributable runs *(chosen)*

| Dimension | Assessment |
|---|---|
| Complexity | Medium — new contracts, one new port, a run cache |
| Cost | Provider spend during evaluation; mitigated by content-addressed caching |
| Scalability | Run matrix is embarrassingly parallel; bounded by budget and provider concurrency |
| Team familiarity | The freeze-and-attribute discipline is already used for `sources/` |

**Pros:** makes every later claim checkable. Turns the catalog from a bibliography into measured guidance. Detects provider drift, which nothing else can. Reuses the layering and freeze conventions already in place.
**Cons:** the largest single piece of unbuilt work here. Judge-based scoring introduces a component with its own error rate. Costs real money per run.

### Option B — Add scoring inside the Application layer, no separate plane

| Dimension | Assessment |
|---|---|
| Complexity | Lowest |
| Cost | Same provider spend |
| Scalability | Poor — evaluation state ends up entangled with request handling |
| Team familiarity | Highest |

**Pros:** fastest to a first number.
**Cons:** rejected. Evaluation outlives any single run and must reach every layer; putting it inside the layer that serves requests makes baselines a property of the serving path. It also puts scoring on the same failure budget as production traffic.

### Option C — Adopt an external evaluation framework wholesale

| Dimension | Assessment |
|---|---|
| Complexity | Low to integrate, high to control |
| Cost | Another dependency, another vocabulary |
| Scalability | Good until the framework's model diverges from ours |
| Team familiarity | Low |

**Pros:** immediate datasets, scorers and reporting; someone else maintains them.
**Cons:** rejected for now, on one specific ground: the attribution tuple is the load-bearing idea, and a framework that records less than the full tuple silently reintroduces the problem this ADR exists to solve. Reconsider once the contracts are defined — an external runner behind our own contracts is a reasonable later move, and much cheaper than adopting its data model.

### Option D — Defer evaluation until the port is complete

| Dimension | Assessment |
|---|---|
| Complexity | None now |
| Cost | None now |
| Scalability | N/A |
| Team familiarity | N/A |

**Pros:** finishes the visible work sooner — fourteen gates, ten stages.
**Cons:** rejected. Fourteen more gates and ten more stages would all be unmeasured, and the catalog would grow further past what anyone has tested. The cost of building evaluation does not fall by waiting; the amount of unverified surface it must then cover rises.

## Trade-off analysis

**Evaluation competes directly with porting for the same scarce attention, and wins on evidence rather than preference.** The strongest available argument is the epistemic-stability result: a plausible, widely-recommended technique measured *net negative* on a modern model. Porting more gates adds capability whose value is assumed; building evaluation converts assumptions into measurements, including about the work already done.

**The grader is the weak point, and must be treated as a subject.** The [LLM-as-a-Judge survey](https://arxiv.org/abs/2411.15594) devotes its evaluation section to agreement with humans, bias, and adversarial robustness; the epistemic-stability paper flags same-model judging explicitly. Mitigations adopted here: the model under test never grades its own output, grader identity is recorded in provenance, and deterministic scorers are preferred wherever a property is checkable without a judge — the same `verifier-checkable` / `judge-checkable` distinction the catalog already carries.

**Stochastic decoding makes single-run comparison meaningless.** The comparison step must be able to return *inconclusive*. This is uncomfortable — it means some changes cannot be pronounced on cheaply — and it is the honest reading of a temperature-0.7 system. The alternative, rounding toward a decision, manufactures exactly the false confidence this repository keeps finding.

**Cost is a first-class constraint, not an afterthought.** [LLMRouter](https://arxiv.org/abs/2608.06867) evaluates routing on quality *and* inference cost under one protocol, for the obvious reason that quality-only evaluation always selects the largest model. The same applies to technique selection: a technique that wins by spending ten times the tokens has not won until the budget says so.

## Consequences

**Easier**
- Every later claim about a gate, technique, stage or router becomes checkable rather than asserted.
- Provider drift becomes detectable: `provider_model_fingerprint` already exists and can trigger a baseline re-run.
- The catalog gains measured per-model guidance instead of imported assertions.

**Harder**
- Provider spend becomes part of the development loop; the content-addressed run cache stops being an optimisation and becomes a requirement.
- Contract-first applies here too — the dataset, run, score and baseline schemas land as reviewed PRs before any code, which slows the first result.
- Gate porting slips further.

**To revisit**
- Whether an external evaluation runner sits behind our contracts (Option C) once those contracts exist.
- The `inconclusive` threshold, once there is enough data to know the noise floor.
- Whether judge-based scoring earns its cost against deterministic scorers on this workload.

## Enforcement

- A run whose provenance is missing any element of the attribution tuple **is not scorable** — the comparison step refuses rather than silently comparing across configurations.
- Baselines are frozen and versioned; a baseline that moves with the working branch is not a baseline. Ouroboros' separation is the model: *"benchmark campaigns use frozen seeds, while [live evolution continues] on a separate lineage."*
- Datasets, runs, scores and baselines are append-only. A re-run is a new run.
- The model under test never grades its own output.
- Gate verdicts constrain any optimizer's search space and must not be reachable by it — *"guardrails must remain authoritative under evolutionary pressure"* (Ouroboros).

## Action items

1. [ ] Land the `Dataset`, `Run`, `Score` and `Baseline` schemas as a reviewed contract PR, before any implementation ([ADR-0002](./0002-contract-first-design.md)).
2. [ ] Extend `ExecutionProvenance` with decoding parameters and seed, dataset version, grader identity, and cost budget. This is a contract change with a version bump.
3. [ ] Build the deterministic scorer path end to end on the one stage that exists, with a golden set small enough to run offline in seconds.
4. [ ] Add the content-addressed run cache keyed on the full configuration, before the first judge-based scorer makes re-runs expensive.
5. [ ] Wire a `provider_model_fingerprint` change to a baseline re-run — cheapest online-drift detection available given the field already exists.
6. [ ] Only then: the perturbation harness, the judge port, and the optimizer, in that order.
