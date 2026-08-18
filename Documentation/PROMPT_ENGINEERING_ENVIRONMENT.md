# Extension seams, routing, and the optimization loop

**Status: design, not built.** A companion to [ADR-0008](./0008-evaluation-first-environment.md), which owns the decision that evaluation is the primary subsystem and specifies the evaluation, authoring and release pipelines, the contract changes, and the scalability logic.

This page deliberately does **not** restate any of that. It covers four things the ADR leaves open, each drawn from infrastructure papers in the corpus rather than from the prompting literature:

1. where extension points fall, and why that is what "scalable" means here
2. routing, which the ADR lists only under *to revisit*
3. the optimization loop that sits above the authoring pipeline
4. how a system that modifies itself keeps its guardrails authoritative

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

## 4. Self-modification, lineages, and keeping guardrails authoritative

Once an optimizer can change the scaffold, the system modifies itself, and two failure modes appear that no amount of evaluation quality prevents.

[Ouroboros](https://arxiv.org/abs/2608.08311) is the corpus's most direct treatment — a coding-agent harness whose "tools, context assembly, prompts and core implementation improve through **reviewed commits** that become the runtime for later work". Three of its operating rules generalise beyond self-modifying agents:

**Reviewed commits as the evolution mechanism.** Changes become the runtime only after review. This repository already works this way, and the discipline is what makes an optimizer's output safe to adopt: a proposed Configuration is a diff, with an `EvalRun` attached as its justification.

**Separate lineages for measuring and for changing.** Ouroboros runs *"benchmark campaigns … [with] frozen seeds, while [live evolution continues] on a separate lineage."* Generalised: **the configuration you measure against must be frozen and separate from the one you are changing.** A baseline that drifts with the working branch is not a baseline — which is why ADR-0008 makes baselines immutable, and why the optimizer must not be able to promote its own candidate.

**Guardrails must remain authoritative under evolutionary pressure.** This is the sharpest of the three. When a search is running over prompts, the gates *constrain* the search — so they must not be reachable *by* it. An optimizer that can weaken a gate will learn to satisfy the measurement instead of the goal, and will do so faster than a reviewer notices.

Concretely, three properties follow: the gate registry and its `ported-gates.json` pin are outside the optimizer's search space; a proposal that changes a guard is a separate reviewed change, never part of a candidate Configuration; and the differential oracle ([ADR-0007](./0007-permanent-differential-oracle.md)) keeps checking the gates against an implementation the optimizer cannot touch.

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
