# The Prompt Engineering Environment — architecture and pipelines

**Status: design, not built.** Nothing on this page is implemented except where it says so. It is written target-state like the rest of this set, and the same warning applies: check before believing. What *is* built is listed in [`README.md`](./README.md)'s status table and verified by `npm run check:plan`.

This document answers one question: what does a prompt engineering environment need in order to be *reliable in production*, as opposed to capable in a demo. It is grounded in three kinds of evidence, and says which is which throughout — measured in this repository, read from the literature corpus, or checked against current practice.

---

## 1. The problem the architecture exists to solve

> *"Agent scores on long-horizon benchmarks are products of the base model, the execution harness, the environment, and the grader."*
> — Ouroboros (arXiv 2608.08311)

This is the whole difficulty in one sentence. A prompt's measured quality is a function of **four** things, and a change in any one moves the number. If the four are not pinned and recorded together, an improvement is indistinguishable from a model update, a harness edit, a dataset shift, or a different judge.

The security literature reaches the same conclusion from the other end. [SoK: Systematizing LLM Prompt Security](https://arxiv.org/abs/2510.15476) reports that prior work "often uses incompatible threat models, access assumptions, cost budgets, datasets, and success criteria", which "can obscure whether progress comes from a stronger method, a weaker target, a different judging rule, or a larger query budget." Its remedy is to make every experiment an explicit tuple of *(model, attack, defense, dataset, judger)* with threat, access and cost as declared metadata.

**Design consequence — the load-bearing one.** The unit of work in this environment is not a prompt. It is an **attributable run**: a prompt *plus* the full configuration under which it was measured. Everything below follows from taking that seriously.

The existing `ExecutionProvenance` contract is the right primitive and is **incomplete**. It carries `core_build_hash`, `contract_versions`, `provider_model_fingerprint` and `config_fingerprint`. It is missing decoding parameters, the grader's identity, the dataset version, and the cost budget — four of the things that most change a result.

---

## 2. Layer model

The five-layer stack in [`ARCHITECTURE.md`](./ARCHITECTURE.md) is unchanged and remains the dependency backbone. This design adds **one plane** and no layers.

```
    Shells ──────────────────────────────────────────────┐
    Application / Orchestration  (owns all live effects)  │  Observability spine
    Contracts   (versioned schemas, sole interface)       │  (exists)
    Core        (pure: gates, catalog, stages, scoring)   │
    Adapters    (provider, storage, grader, index)        │  Evidence plane
    Composition Root                                      │  (new)
```

**Why a plane and not a layer.** Evaluation is not something the pipeline calls; it is something that *observes* the pipeline and outlives any single run. It needs to reach every layer — the gate verdicts in Core, the provider fingerprint in Adapters, the stage decisions in Application — without any of them depending on it. That is the same shape as the observability spine, and for the same reason.

The Evidence plane holds four record types, all immutable once written: **datasets**, **runs**, **scores**, and **baselines**. A run is never edited; a re-run is a new run. This is the freeze discipline already used for `sources/`, applied to measurements.

### Where scoring lives

Deterministic scoring is Core — it is a pure function of *(candidate, reference, config)* and must stay so. Judge-based scoring is an **adapter behind a port**, exactly like a provider, because it performs a live effect. The Application layer decides which to invoke, and Core reduces the classified result. `decide → invoke → reduce` applies unchanged.

This distinction is not cosmetic. It is what lets the deterministic half of the eval suite run offline, in milliseconds, with no budget — which is the difference between a suite people run and a suite people skip.

---

## 3. The five pipelines

### 3.1 Authoring — *partially built*

The eleven-stage pipeline. Built: one stage (`compile`), end to end, with demo-mode honesty. Each stage is a `decide`/`reduce` pair; Core returns a `GenerationRequest`, the Application executes it, Core reduces the classified outcome ([ADR-0005](./0005-application-orchestration-boundary.md)).

**The one change worth making: gates become a control signal, not a report.**

Today a gate emits a verdict that is recorded and ignored. [DSPy Assertions](https://arxiv.org/abs/2312.13382) shows the same constraints used as runtime backtracking triggers and as a compiler objective raise constraint satisfaction "up to 164% more often" with "up to 37% more higher-quality responses". You already have the hard part: pure, deterministic, typed `GateResult`s with `message_code` and `location`. What is missing is a reducer that treats a FAIL as *retry with this feedback attached*, under a bounded attempt budget.

```
reduce(input, outcome, gateResults) →
    | Accept(output)
    | Retry(GenerationRequest, feedback, attempt)   ← new
    | Degrade(demo placeholder)
```

`Retry` must be Core-pure and bounded: it returns the next request, it does not perform it. The attempt cap belongs in the Application, where the other effect budgets already live.

### 3.2 Evaluation — *not built, and it is the blocking gap*

Everything else in this document is unmeasurable without it.

```
dataset@version
      │
      ├── case × technique × model × params  ──►  run matrix
      │                                              │
      │                                     (content-addressed cache)
      │                                              │
      ├── deterministic scorers (Core, offline, free) ┤
      ├── judge scorers (adapter, budgeted, recorded) ┤
      │                                              ▼
      └────────────────────────────────►  scores  ──►  compare(baseline)
                                                          │
                                          Verdict: improved | regressed | inconclusive
```

Four properties matter more than the shape:

**Offline and online catch different things.** Offline evaluation catches regressions *you* introduce. Online evaluation catches changes that *happen to you* — provider models now ship faster than internal release cycles and shift behaviour without a version bump. You already record `provider_model_fingerprint`; nothing acts on it. Making a fingerprint change trigger a baseline re-run converts an existing field into online-regression detection for almost no work.

**The grader is a component with an error rate.** The [LLM-as-a-Judge survey](https://arxiv.org/abs/2411.15594) spends its evaluation section on agreement-with-humans, bias, and adversarial robustness — the judge is a subject, not an instrument. The industrial study below flags *same-model judge* limitations explicitly. Two rules follow: the model under test never grades its own output, and grader identity goes in provenance.

**Clean inputs overstate quality.** [Auto-Prompt Generation is Not Robust](https://arxiv.org/abs/2412.18196) shows that methods assessed "only on clean, well-structured inputs" degrade sharply under minor perturbation. The adversarial corpus should therefore be *generated* — systematic seeded perturbations of the golden set — not a handwritten attack list, which only covers what its author already imagined.

**Inconclusive is a real verdict.** With stochastic decoding, a single run pair cannot distinguish improvement from noise. The comparison must report *inconclusive* rather than round toward a decision. The industrial study below used **100 trials per method** to make its claims; a suite that runs each case once is measuring sampling noise.

### 3.3 Optimization — *not built*

[A Survey of Automatic Prompt Engineering](https://arxiv.org/abs/2502.11560) formalises this as maximisation over discrete, continuous and hybrid prompt spaces, organised by optimisation variable (instructions, soft prompts, exemplars), objective, and method family. AutoDesign (arXiv 2608.13560) frames it more usefully for our purpose: a **meta-harness** optimises the harness, and "the optimization acts on the system surrounding the model rather than on the model itself."

```
outer loop  (meta-harness)         inner loop  (authoring pipeline)
   propose candidate harness   ──►   run the eval pipeline
   ▲                                        │
   └──────── objective = eval verdict ◄─────┘
```

Two constraints keep this from becoming a random-search toy:

- **The objective is the eval pipeline's verdict, not a scalar someone invented.** If the eval pipeline is not trustworthy, the optimizer amplifies its errors rather than the system's quality.
- **Constrained optimisation, not free.** Gate verdicts and cost budget are constraints on the search space, not soft preferences. The survey names constrained optimisation as an underexplored frontier; for a production environment it is the only responsible form.

### 3.4 Runtime — *partially built*

Serve, route, guard, degrade, record. Built: provider invocation with typed failure, retry policy, demo-mode degradation, event emission.

**Routing is the significant addition, and there is a good shape to copy.** [LLMRouter](https://arxiv.org/abs/2608.06867) formalises routing as a sequential decision process decomposed into five components — *context encoders, model encoders, scoring functions, decision rules, learning signals* — and reports that a new router requires implementing "only a routing method and a loss function". Its benchmark evaluates routers on **response quality and inference cost jointly**, under one protocol.

Copy both: the five-part decomposition as the port, and quality-with-cost as the only honest evaluation of a routing decision. A router evaluated on quality alone will always select the largest model.

### 3.5 Release — *not built; blocked*

Freeze, stamp, promote, roll back. Blocked on there being a git remote at all (risk R8 in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)).

Ouroboros contributes the sharpest operational rule here. Its harness modifies *itself*, so it separates lineages: **"Benchmark campaigns use frozen seeds, while Hope continues live evolution on a separate lineage."** Generalised — and this applies even without self-modification — the configuration you measure against must be frozen and separate from the configuration you are changing. A baseline that drifts with the branch is not a baseline.

Its safety framing is the other transferable piece: *"guardrails must remain authoritative under evolutionary pressure."* When an optimizer is searching over prompts, the gates constrain the search. They must not be reachable *by* the search, or the optimizer will learn to satisfy the measurement instead of the goal.

---

## 4. Seams — where scalability actually comes from

Scalability here is not throughput; it is **the cost of adding the two-hundredth of something**. Every extension point should require implementing the minimum that cannot be defaulted:

| Extension | Author implements | Registry cost |
|---|---|---|
| Gate | one pure function | one line + `ported-gates.json` entry — *built* |
| Technique | one record | import boundary — *built* |
| Scorer | `score(candidate, reference, config) → Score` | one line |
| Judge | `grade(candidate, rubric) → Verdict` behind the port | composition root |
| Router | a routing method + a loss | one line (LLMRouter's shape) |
| Perturbation | `perturb(input, seed) → input` | one line |
| Provider | `generate` + `healthCheck` | composition root — *built* |

The gate registry already demonstrates the property: 0 of 17 surveyed prototypes had one, and every one of them capped at its author's original set. **The list is the ceiling.** Registries are what stop that.

### Concurrency and cost

The run matrix is embarrassingly parallel and bounded by two things that must be explicit, not emergent: **provider concurrency** and **budget**. Both belong in the request contract.

The highest-leverage single mechanism is a **content-addressed run cache**, keyed on `sha256(prompt, model, decoding params, seed, tool set)`. Evaluation re-runs the same cases constantly; without a cache the suite's cost is the reason people stop running it. With one, a re-run after an unrelated change is nearly free. This is also why decoding parameters must be *in* the provenance — they are part of the cache key, and a cache keyed on less than the full configuration returns confidently wrong results.

---

## 5. What the evidence says to build first, and what to resist

Two results from the corpus are worth more than the rest of it combined, because both are negative:

**[Toward Epistemic Stability](https://arxiv.org/abs/2603.10047)** — 100 trials per strategy at temperature 0.7, industrial setting:

| Strategy | "Better" verdicts |
|---|---|
| M4 Enhanced Data Registry | **100 / 100** |
| M3 Single-Task Agent Specialization | 80 % |
| M5 Domain Glossary Injection | 77 % |
| M1 Iterative Similarity Convergence | 75 % |
| M2 Decomposed Model-Agnostic Prompting | **34 % — net negative** |

Grounding beat every prompting trick, and *decomposition made things worse* than single-shot on a modern model. The catalog is a reference of techniques; used naively it will recommend M2. **Technique selection has to be measured per model, not imported from a survey** — which is exactly what the eval pipeline is for, and another reason it comes first.

**[Auto-Prompt Generation is Not Robust](https://arxiv.org/abs/2412.18196)** — optimizers tuned on clean inputs collapse under perturbation. Build the perturbation harness alongside the optimizer, not after it.

### Resist

- Adding techniques to the catalog faster than they can be measured. 180 unmeasured records is a bibliography.
- Building the capability-matrix generator before there is evidence for it to generate from.
- Adopting `gen_ai.*` as the internal event contract. Every attribute in the OpenTelemetry GenAI registry is still **"Development"** status, none stable, and names have already churned. Keep `ObservabilityEvent` as the contract and add a *mapping layer* for export. The conventions' span-tree structure — `create_agent`, `invoke_agent`, `execute_tool`, `retrieval`, memory operations — is worth mirroring structurally while the names move.

---

## 6. What makes the codebase hold up

These are not style preferences. Each was measured in this repository, and the mutation data is in the git history.

**Every invariant needs a second, independently-authored checker.** This is the strongest finding available here. Of the defects found this month, the ones that mattered were each caught by an independent check and missed by the primary one:

| Defect | Found by | Missed by |
|---|---|---|
| Gate regex reverted to a shipped bug; key bound widened | differential oracle | the entire test suite |
| 8 wrong citation titles | arXiv metadata | the internal consistency checker, which passed all 172 |
| 2 invented vocabularies | the frozen XSD | the JSON Schema, which typed them as free strings |
| `node:fs` reachable from Core | static import scan | the runtime purity harness |

Not one was found by making the first checker stricter. Internal consistency is structurally blind to a systemic error — the same argument [ADR-0007](./0007-permanent-differential-oracle.md) makes for the oracle, observed three more times in three different subsystems.

**A guard's scope must be probed, not assumed.** Three guards here were silently narrower than their names: the purity harness never blocked the filesystem, `typecheck` covered a third of the code, and the cross-shell rule missed relative imports. All three passed continuously while incomplete. Plant a defect in *each place the guard is believed to cover* and confirm it fires there.

**Mutation-prove every guard, and measure by exit code.** A guard not observed failing is not known to work. An early probe here reported five surviving mutations because it grepped colourised output that never matched — the instrument was broken, not the code.

**Generated artifacts need a `--check` mode.** `import:catalog --check` fails when the committed file is not what the inputs currently produce. Without it a generated file is just a file somebody edited once.

**Never edit frozen inputs; correct at the boundary.** Eight wrong titles live in hash-pinned `sources/`. They are fixed in `catalog-corrections.json`, each with `from`, `to`, reason and evidence, and the import *refuses* if the frozen value stops matching `from`. The inherited record stays intact, the fix is a reviewable diff, and a stale correction cannot apply silently.

**Allowlists must expire.** Known defects are excused only with a stated reason, and an entry whose defect no longer occurs **fails as stale**. An allowlist that outlives its problem silently excuses the next one.

---

## 7. What this design does not claim

- **Not that it is built.** One stage of eleven, two gates of sixteen, no eval pipeline at all. The status table in `README.md` is authoritative.
- **Not that the technique catalog is validated.** 180 records, citations verified against arXiv, and **zero measured on any task**. Every `when_to_use` in it is an assertion from a paper, not a result from this system.
- **Not that the literature generalises to your workload.** The 100/100 registry result and the net-negative decomposition result are one industrial setting, one model, one task family. They are strong enough to set a default and nowhere near strong enough to end an argument.
- **Not a throughput design.** Nothing here has been load-tested. "Scalable" above means the cost of adding capability, not requests per second.
