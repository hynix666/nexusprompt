# Synthesis Strategy — a skeleton

How to combine everything that exists here into one application without inheriting what made the parts fail.

This is thinking, not a specification. It precedes `IMPLEMENTATION_PLAN.md` (still unwritten) and is meant to be argued with. Where it asserts something checkable, the check is named.

---

## 0. The twenty-one properties are now enumerated

`ARCHITECTURE.md` names fifteen and cites nineteen; the missing four were searched for across every archive and not found. The list supplied with this request has **twenty-one** and is a strict superset of the fifteen, adding: *scalability, maintainability, extensibility, explainability, long-term architectural sustainability,* and *architectural structure*.

That closes the open item, and it closes it the right way — by someone stating the intent rather than by inferring four to make arithmetic work. `ARCHITECTURE.md` should adopt the twenty-one and drop the nineteen.

---

## 1. Inventory — what exists and what each part uniquely contributes

Nothing here is greenfield. The synthesis is a merge, and knowing precisely what each input is *good at* determines what to take from it.

### The frozen sources — where the rigor is

| Source | Unique contribution | Why it matters |
|---|---|---|
| `prompt_lint.py` (16 gates) | The only real verification engine in the entire corpus | Deterministic, dependency-free, documented against a framework spec |
| `fixtures.json` (40 cases) | **11 cases pin a defect that actually shipped** | A regression history, not examples. Port these before the gates |
| `differential.mjs` | An *oracle* — fuzzing against an independently written implementation | Catches what parity structurally cannot: a shared defect |
| `scorer.py` | Deterministic adversarial scoring with explicit epistemic limits | Produces a number where there was an assumption marker, and says what it doesn't prove |
| `serve.py` + 27 assertions | Stdlib-only proxy, allowlist, path-tail validation, loopback default | Key custody that works with zero infrastructure |
| `check_versions.py` | Build-hash stamping | The mechanism behind reproducibility claims |
| Catalog v1.20.0 (172 records) | Data + XSD + four export formats + CI toolchain | The highest-confidence port in the project |
| Pipeline component (11 stages) | Full stage templates, exports, revision audit, stale invalidation | Validated UX, with prompts written and tuned |
| `hostedProviders.ts` | Typed provider health/error, timeout, model probing | Multi-tenant provider handling |

### The prototype collection — where the surface is

Seventeen components. Almost all are non-functional (no key, deprecated model), and several display numbers nobody measured. But they are a **requirements corpus**: seventeen attempts at the same product tell you what the product keeps wanting to be.

| Capability | Where it exists | State |
|---|---|---|
| Chain composition — sequential, parallel, conditional, iterative, map-reduce, ensemble, LLM-router, fallback-with-validation | `PromptChainStudio.jsx` **only** | Genuinely implemented; honest statistics |
| Technique catalog browsing | 8 prototypes | Repeated everywhere — clearly core |
| Lint surface | 8 prototypes | Always hardcoded, never a registry |
| Revision history / compare | 10 prototypes | Repeated; only 2 actually persist |
| DSPy-style optimization | 4 prototypes | All simulated; the *generated code* is real and useful |
| A/B comparison | 5 prototypes | Repeated |
| Graph / tree visualization | 9 prototypes | Repeated |
| Cross-session persistence | **2 of 17** | The consistently missing piece |
| Gate registry (vs hardcoded list) | **0 of 17** | The extensibility gap, unanimous |

Two facts to carry forward: **`PromptChainStudio` is the only prototype that does real work**, and its `runChain` loop is an unwitting sketch of the Application layer — decide, invoke, classify, reduce. And **no prototype has a gate registry**, which is exactly why none of them could grow past their author's original list.

### Built this session

`sources/` + `MANIFEST.json` + `verify-sources.mjs` (frozen, hash-verified) · `core/gates/secret-leak-scan.ts` with its fence-stripping dependency and a purity harness proven to fail on injected effects · two local proxies with tested failure paths · `SOURCE_VERIFICATION.md`.

---

## 2. The through-line

The best code here already shares a philosophy, and it is not "be correct." It is narrower and more useful:

> **Refuse to report success you have not earned, and name what your check does not prove.**

It appears independently in four places, written by different efforts:

- `differential.mjs` refuses to run zero cases: *"zero cases is not a pass; refusing to report agreement"* — a green build that compared nothing is worse than a red one.
- A missing oracle is a skip, not a pass: *"a missing oracle is not a passing test."*
- `scorer.py` says of itself: *"substring proxy, not proof"*, and prefers `[ASSUMPTION:adversarial_untested]` over a resilience claim it cannot support.
- `⟦WORKFLOW DEMO — no model⟧` refuses to fabricate output when no provider answered, and `CLAIM_DISCIPLINE` enforces that the refusal stays visible.

And its absence explains every failure catalogued this week: fourteen false documentation claims, a section checklist driven by a `setInterval`, a confidence score that was `Math.random()`, an "Improvements: 7" that was `Math.floor(Math.random()*8)+3`, a parity suite reporting green over a defect both sides shared.

**This is the spine.** Every one of the twenty-one properties should be built as an instance of it.

---

## 3. The organizing rule

A property you cannot mechanically fail is a property you do not have. So each of the twenty-one gets three things, and is not considered delivered until all three exist:

1. **A mechanism** — the thing that makes the property true.
2. **A test that can fail** — and that has been *observed* failing. A guard never seen to fail is not known to work; this is why `verify-sources` was tested by corrupting a byte and the purity harness by injecting `fetch`.
3. **A stated non-claim** — what the mechanism does *not* establish. This is the `scorer.py` move, and it is what stops a property from quietly inflating into a guarantee nobody can support.

The third column is the one that makes the set honest. Without it, "observability" grows into "we'd notice any problem" and "reproducibility" into "you can reproduce the output."

---

## 4. The twenty-one properties

### Structural — enforced by boundaries

| # | Property | Mechanism | Test that can fail | Does **not** prove |
|---|---|---|---|---|
| 1 | **Scaffolding** | Generators for gates/techniques; monorepo layout; CI templates | Generated stub passes a check a hand-written one fails | That the scaffold's shape is right |
| 2 | **Architectural structure** | Layer boundaries as import-lint rules | Adding `core → adapters` fails CI | That these are the right layers |
| 3 | **Modularity** | One capability, one home; ports and adapters | Swap an adapter; contract suite passes unchanged | Cohesion inside a module |
| 4 | **Portability** | Core with zero runtime deps; stdlib-only proxy precedent | Core suite runs with network/fs/clock/random stubbed ✅ *built* | Performance parity across runtimes |
| 5 | **Universality** | Versioned JSON Schemas as the sole cross-boundary interface | A non-TypeScript validator validates every fixture | Ergonomics in other languages |
| 6 | **Completeness** | Capability matrix generated from registrations + test evidence | Build fails on an orphaned contract or an unproven claim | That the feature set is sufficient |
| 7 | **Extensibility** | Gate and technique **registries** — the gap all 17 prototypes share | Add a gate touching only its own files and the registry | That extensions compose with each other |
| 8 | **Scalability** | Bounded work everywhere: run bundles, concurrency caps, bounded quantifiers, streaming | 500 KB adversarial input inside a time budget ✅ *built*; fan-out under cap | Multi-tenant load behaviour |

### Quality — enforced by purity and typed outcomes

| # | Property | Mechanism | Test that can fail | Does **not** prove |
|---|---|---|---|---|
| 9 | **Correctness** | Fixture parity + property tests + differential oracle | The 11 regression fixtures; oracle disagreement fails the build | Correctness outside the corpus |
| 10 | **Determinism** | No clock, randomness, or ambient tokenizer; explicit floor-rounding | Purity harness ✅ *built, observed failing*; same input twice, identical bytes | Determinism of model output |
| 11 | **Consistency** | Cross-shell parity on identical inputs | Shells disagree on a `GateResult` | Anything both shells get wrong — see #9 |
| 12 | **Reliability** | Typed `ProviderFailure`; retry/backoff owned by one layer | Every failure category exercised against both adapters | Provider uptime |
| 13 | **Resilience** | Demo-mode ladder: classify → deterministic placeholder | Kill the provider mid-run → labeled demo output, `CLAIM_DISCIPLINE` passes | Recovery from partial state corruption |

### Verification — enforced by evidence

| # | Property | Mechanism | Test that can fail | Does **not** prove |
|---|---|---|---|---|
| 14 | **Testability** | Pure Core; effects at exactly one seam | Every gate has ≥1 property test; CI rejects an empty stub | Test quality |
| 15 | **Observability** | Event spine, keyed hashes, causal parent links | Replay reconstructs a run in causal order; sink rejects a body | That the events capture what you'll need later |
| 16 | **Traceability** | `run_id` threaded end to end + `execution_provenance` | From an export alone, reconstruct every verdict and provider call | Model-output provenance — see #18 |
| 17 | **Auditability** | Source manifest with hashes; the verification ledger; immutable revision history | `verify-sources` fails on one changed byte ✅ *built, observed failing* | That the audit is complete |
| 18 | **Reproducibility** | Build hash; canonical exports; **three claims kept separate** | Independent build → identical artifact hash; byte-compare the PDF | Replay of live model output. Never claim this |
| 19 | **Explainability** | Every `GateResult` carries `message_code`, `location`, and the reason; findings cite evidence | Every emitted `message_code` resolves in the registry | That a human finds the explanation clear — needs users |

### Sustaining — enforced by process

| # | Property | Mechanism | Test that can fail | Does **not** prove |
|---|---|---|---|---|
| 20 | **Maintainability** | ADR amendment convention; generated docs; one home per capability | `docs:matrix` fails on drift | Developer experience |
| 21 | **Long-term sustainability** | Contract versioning; per-layer rollback; the verification-ledger habit | Rollback drill; an unsupported major-version pin fails CI | That the architecture survives a change of requirements |

Three of these already have observed-failing tests. That is the bar for the other eighteen.

---

## 5. What the architecture has to be, given the above

Nothing here overrides `ARCHITECTURE.md`; these are the consequences the property table forces.

**Registries, not lists.** Gates, techniques, stages, and providers are registered, not enumerated in a constant. This is property #7, and it is the single most consistent failure in the prototype collection: seventeen components, zero registries, and every one of them stuck at its author's original gate list.

**Two independent implementations of the gate rules, permanently.** Not a migration artifact — a standing oracle. The moment there is only one implementation, the class of defect that `differential.mjs` catches becomes invisible again. Cheapest honest form: keep the frozen Python linter as the oracle and diff the TypeScript port against it in CI.

**One effect seam.** Everything in the property table that depends on determinism, testability, reproducibility, or traceability collapses if effects leak into Core. This is ADR-0005 and it is load-bearing for six properties, not one.

**Provenance as a data type, not a comment.** `execution_provenance` on every revision; manifest ids in ported modules; the ledger as a committed artifact. Properties #16–18 are all the same mechanism seen from different angles.

**Honest degradation as a first-class path.** Demo mode is not error handling; it is the resilience property's mechanism, and `CLAIM_DISCIPLINE` is its test.

---

## 6. Sequencing

Ordered by what unblocks what, with an exit gate that can fail. No phase is complete because its work is done; it is complete because its gate ran and could have said no.

| # | Phase | Exit gate |
|---|---|---|
| 0 | **Freeze and verify sources** ✅ *done* | `verify-sources` passes; corrupting a byte fails it |
| 1 | **Contracts** — schemas, fixtures, generated bindings | Every fixture validates; a malformed one fails; a non-TS validator agrees |
| 2 | **Core: gates + registry + purity harness** | 16 gates via registry; all 40 fixtures pass; injected effect fails the suite |
| 3 | **Differential oracle in CI** | Seeded fuzz run; disagreement with the frozen linter fails the build; zero cases refuses to pass |
| 4 | **Application layer** — decide/invoke/reduce, typed failures, demo ladder | Provider killed mid-run yields labeled demo output; `CLAIM_DISCIPLINE` passes on it |
| 5 | **Adapters** — local proxy (27 assertions mapped), local storage (run bundles) | All 27 map one-to-one; an 11-stage run persists and reloads intact |
| 6 | **Catalog import** | 172 records validate against the corrected `TechniqueRecord` **and** the XSD |
| 7 | **Shells** — CLI first, then the pipeline surface | Cross-shell parity on identical input |
| 8 | **Release truth** — matrix generator, trace viewer, build-hash | Matrix generated from evidence; the three reproducibility claims reported separately |

Phase 3 before phase 4 is deliberate: the oracle is cheapest to stand up while the gates are the only thing in Core, and it is the phase most likely to be skipped under pressure.

---

## 7. Traps, each one evidenced from this week

1. **Porting a defect faithfully.** The port inherits its source's bugs and parity reports green. → Phase 3, non-negotiable.
2. **Trusting a count nobody re-read.** Fourteen of twenty-two documented claims were wrong. → Verify against the artifact; cite `file:line`.
3. **A metric with no measurement behind it.** Random confidence, timer-driven progress, `improvements = random()`. → If nothing computes it, do not render it.
4. **A guard never seen to fail.** → Break it on purpose, once, and keep that test.
5. **Language-default arithmetic.** Python's banker's rounding vs JavaScript's; an ambient `tiktoken` import. → Pin the arithmetic; no ambient dependencies in Core.
6. **Unbounded quantifiers.** A 500 KB prompt took minutes. → Bounded on both ends, with a timing test.
7. **Unanchored substring matching on a safety gate.** `telescope` satisfied the `scope` clause — a false clean. → Word-boundary anchoring, with a fixture.
8. **Entry-based bounds on a growing pipeline.** An 8-entry cap could not hold a 9-stage run; it is now 11. → Bound by run bundle, never by entry.
9. **Documentation that outlives its code.** The updated package added two stages and its docs stayed byte-identical. → Generate what can be generated; fail the build on drift.

---

## 8. Open questions

- **`TechniqueRecord` shape.** The contract disagrees with the 172 records. Fix the contract, not the data — but it is a contract change and needs its own reviewed PR.
- **`storage-db` revision schema.** Genuinely new work; no source has a revisions table. Should land as a reviewed migration before either storage adapter.
- **Scalability's real target.** Property #8 has a mechanism but no stated load. Single user? A team? Until that is answered the bound is arbitrary.
- **Explainability's audience.** Property #19 can only be half-tested mechanically. The other half needs a person reading a `GateResult` and saying whether it helped.
- **Where the prototypes' UX lands.** Seventeen components agree on catalog, lint, revisions, compare, and graph. That convergence is a requirements signal worth taking seriously, and none of it is designed yet.

---

## 9. The one-line version

Take the rigor from the frozen sources, the surface from the prototypes, and the boundaries from the ADRs — and hold all of it to the rule the best code here already follows: **claim only what a test could have contradicted.**
