# Implementation Plan

**Status:** Active — 16 August 2026. Supersedes the phase skeleton in [`SYNTHESIS_STRATEGY.md`](./SYNTHESIS_STRATEGY.md), which stays in force for its property analysis.

This document was cited by six others for roughly a year before it existed. Phase numbers were quoted, exit gates referenced, and a risk register assumed — all pointing at a page nobody had written. That is the exact failure this repository was reorganised to stop, so the plan arrives with a checker attached.

## How this document stays true

Every falsifiable number below lives in one machine-checked block, and `npm run check:plan` verifies each against the repository. It runs inside `npm run verify`. A phase marked complete whose evidence has disappeared fails the build; a gate count that drifts fails the build; a command named in an exit gate that exists in neither `package.json` nor the planned list fails the build.

Prose can still go stale — the checker cannot read intent. What it can do is stop the *numbers* from lying, which is how the previous documentation set went wrong.

```json plan-status
{
  "gates": { "ported": 2, "source_total": 16 },
  "stages": { "built": 1, "target": 11 },
  "contracts": { "schemas": 5 },
  "adapters": ["provider-local-proxy", "storage-local"],
  "shells": ["cli"],
  "catalog": { "records_imported": 0, "records_available": 172 },
  "sources": { "frozen_files": 420 },
  "ci": { "configured": false },
  "commands": [
    "verify", "lint:boundaries", "verify:sources", "test", "typecheck",
    "differential", "cli", "check:plan", "check:citations"
  ],
  "planned_commands": [
    "verify:gates", "adversarial", "trace:view", "docs:matrix", "verify:hash",
    "scaffold:gate", "scaffold:technique", "catalog:validate", "parity"
  ]
}
```

## Where the work actually is

The completed work is a **vertical slice**, not a set of finished layers. It cuts through contracts, Core, Application, both adapters, and a Shell at a depth of one gate-pair and one stage. That matters for reading everything below: the architecture is proven end to end, and almost all remaining work is *widening* existing layers rather than building new ones.

```
                        built          target
contracts   ████████████████████       5 schemas, each validated against a real value
core/gates  ██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       2 of 16
core/stages █▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       1 of 11
application ████████████████▒▒▒▒       decide/invoke/reduce + lint; no cancellation, no catalog ops
adapters    ██████████▒▒▒▒▒▒▒▒▒▒       2 of 4 (hosted-server, storage-db absent)
shells      ██████▒▒▒▒▒▒▒▒▒▒▒▒▒▒       1 of 3
catalog     ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       0 of 172 records imported
release     ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       no CI, no matrix generator, no build hash
```

The slice is deliberately the *riskiest* path through the system rather than the easiest: a provider failure reaching a Core reduction and coming back out as labelled demo output. That is the mechanism the whole design exists to protect, and it works.

---

## Phases

Derived from the dependency graph, then ordered by risk. Each phase has an **entry condition** (what must be true to start), a **scope**, and an **exit gate** (a command or a check that can fail). A phase without a falsifiable exit gate is a wish.

### Phase 0 — Source freeze ✅ complete

Extract, hash, and pin the prior artifacts so every later claim about "the source" points at a fixed thing.

**Exit gate:** `npm run verify:sources` passes; altering one byte of any frozen file fails it. *Observed failing — a single-character edit to `prompt_lint.py` was caught.*

### Phase 1 — Vertical slice ✅ complete

One gate pair, one stage, both adapters at slice depth, the CLI, the differential oracle, the boundary checker, and the contract conformance suite.

**Exit gate:** `npm run verify` — boundaries, typecheck, source freeze, plan check, tests, oracle. *Passing. 26 planted defects were probed against it; 26 caught, 0 survived.*

What Phase 1 established that the rest of the plan leans on: Core purity holds under instrumentation, `decide → invoke → reduce` survives contact with a real provider failure, the oracle catches defects the test suite cannot see, and the boundary rule is enforceable.

**Hardening the verification itself** was folded into this phase after two guards turned out to be narrower than their names, both found by probing coverage rather than correctness:

- `npm run typecheck` covered only `core` and `contracts`. The Application layer, both adapters, the CLI, the whole test suite, and the differential oracle were never typechecked — about two thirds of the TypeScript, inside a command `verify` depends on. A type error was planted in seven locations; five were unchecked. `tsconfig.json` now includes every source directory, and all seven are caught.
- The cross-shell import rule only fired when the specifier text literally contained `shells/`, so a sibling shell reached the ordinary way — `../../toolkit/src/index.js` — passed. Specifiers are now resolved to repo-relative paths before any rule inspects them, which fixes the same latent weakness for every other rule at once. Found by the first test written against the checker.

### Phase 2 — The remaining fourteen gates

**Entry condition — not yet met.** The divergence allowlist ([ADR-0007](./0007-permanent-differential-oracle.md), action item 2) must exist first. Fourteen ports will hit at least one case where the frozen linter is wrong, and today the only ways to get a green build are to reproduce the defect or delete the check. Neither is acceptable, and discovering that mid-port is how the oracle gets abandoned. **This is the single highest-value piece of unbuilt tooling in the repository.**

**Scope.** `PLACEHOLDER_AUDIT`, `RUNTIME_KEY_UNDECLARED`, `TOKEN_SPAM`, `SOURCE_LEDGER_MISSING`, `ORPHAN_CLAIMS`, `GUARDRAIL_GAP`, `RECURSION_MACHINERY_PRESENT`, `RAG_SHIELD_GAP`, `TOKEN_BUDGET`, `DUPLICATE_INSTRUCTION`, `DELIMITER_ENTROPY`, `QUTM_CEILING`, `CONTEXT_LIMIT`, `ADVERSARIAL_RESILIENCE`.

Each is one module, one registry line, one `scripts/ported-gates.json` entry, a fixture test, and a property test. Four carry known hazards worth naming before they are written:

| Gate | Hazard |
|---|---|
| `TOKEN_BUDGET`, `CONTEXT_LIMIT`, `QUTM_CEILING` | Arithmetic. Python's banker's rounding diverges from `Math.round` at `.005`; the source uses explicit `floor(x*100+0.5)/100` and the port must too. No amount of parity testing surfaces this — both sides are internally consistent. |
| `TOKEN_BUDGET` and friends | No ambient tokenizer. The contract is `chars/4` everywhere; an optional `tiktoken` import would make verdicts depend on what happens to be installed. |
| `SOURCE_LEDGER_MISSING`, `ORPHAN_CLAIMS` | The pair that shipped the self-declaring-citation defect, where a citation inside an empty ledger section silenced *both*. Port them together and test the interaction, not each alone. |
| `ADVERSARIAL_RESILIENCE` | Depends on `adversarial/scorer.py`, a second frozen artifact. Decide explicitly whether the port calls it, reimplements it, or defers the gate. |

**Exit gate:** `npm run differential` compares 16 of 16 gates with zero disagreements outside the allowlist, and `scripts/ported-gates.json` lists all sixteen. Every allowlist entry states a reason and cites an ADR.

**Cost note.** The oracle spawns Python once per *case*, not per gate, so its runtime does not grow as gates are added — 440 cases takes 21 s at two gates and will take about 21 s at sixteen. ADR-0007's action item 3 assumed otherwise; that item is being corrected rather than carried.

### Phase 3 — The remaining ten stages

**Entry condition:** Phase 2 complete. The `lint` stage needs the full gate set to mean anything.

**Scope.** `deconstruct`, `calibrate`, `harden`, `critique`, `refine`, `lint`, `critic`, `preview`, `cost_estimate`, `tone_check`. Stage templates come from the eleven-stage pipeline component in `files_3.zip` — **which is not in this repository and is not frozen.** Extracting and freezing it is the first task of this phase, not an assumption of it.

Each stage is a `decide`/`reduce` pair with no callback, per ADR-0005. `cost_estimate` and `tone_check` are the two the inherited `docs/` tree never mentions; they have no prior documentation to port from and need their contracts written fresh.

**Exit gate:** an eleven-stage run persists and reloads intact as one bundle; every stage's `decide` returns a `GenerationRequest` and its `reduce` accepts a classified outcome; the purity harness stays green; `npm run verify` passes.

### Phase 4 — Catalog import

**Entry condition:** none beyond Phase 1. **This phase is independent and can be pulled forward at any point** — nothing depends on it until Phase 6's toolkit surface, and it is the cheapest phase in the plan.

**Scope.** Import 172 technique records from the frozen `sources/catalog/data/`, validate against both the corrected 21-field `TechniqueRecord` contract and the frozen XSD, and build the catalog registry alongside the gate registry.

Worth doing early for a reason unrelated to its cost: `CONTRACTS.md` had the `TechniqueRecord` shape wrong, and importing the real records is what proves the correction.

**What is already known about the data**, from the literature review recorded in [`LITERATURE_CORPUS.md`](./LITERATURE_CORPUS.md):

- Every citation is internally consistent — 159 arXiv ids, none malformed, none reused for a different paper, no year contradicting its own preprint date, no missing author/year/title. `npm run check:citations` keeps that true.
- Exactly **four** of the 172 citations have been checked against the actual paper, and all four agree. The other 168 have not.
- **Coverage has now been measured** against *The Prompt Report* (arXiv 2406.06608v6). Of 57 techniques recovered from its taxonomy, 34 have a catalog record and **23 do not** — and the gap is concentrated rather than general: **8 of the survey's 10 ensembling techniques are missing** (COSP, DENSE, DiVeRSe, Max Mutual Information, Meta-CoT, MoRE, USP, Prompt Paraphrasing), plus five few-shot exemplar/instruction-selection methods. The catalog is *wider* than the survey elsewhere, so this is a specific hole, not thinness.

**Exit gate:** all 172 records validate against the JSON Schema *and* the XSD; a record missing `primary_source` fails; `check:citations` passes; the count is asserted, not stated.

**Decide explicitly whether to close the ensembling gap in this phase or record it as scope.** Importing 172 records and shipping a catalog that silently omits most of a category is the kind of quiet incompleteness `CAPABILITY_MATRIX.md` exists to prevent. Either add the eight records or state the omission where a user of the catalog will see it.

### Phase 5 — Second adapters

**Entry condition:** Phase 3, so there is a full pipeline to persist.

**Scope.** `provider-hosted-server` (server-side key custody, ported from the GitHub product) and `storage-db`.

**`storage-db` is new work, not a port, and the plan should stop implying otherwise.** The inherited Drizzle schema is MySQL with `users` and `promptAssets` and no revisions table. The revision schema needs designing and must land as a reviewed migration *before* either storage adapter changes — contract-first applies to database schemas too.

**Exit gate:** one adapter contract suite runs against both implementations of each port with identical results; the 27-assertion proxy security suite is mapped one-to-one, with every assertion either ported or recorded as N/A with a reason.

### Phase 6 — Shells

**Entry condition:** Phases 3 and 4.

**Scope.** The shared presentation package first, then `pipeline-ui`, then `toolkit-ui`. Per ADR-0006 the Shells never import each other; reuse goes through the shared package, which is what makes per-Shell rollback real.

**Exit gate:** cross-shell parity — the same input through `cli` and through `pipeline-ui` produces identical `GateResult`s. Note that parity is a *drift* check and cannot see a shared defect; the oracle remains the correctness check.

### Phase 7 — Release truth

**Entry condition:** a git remote exists. **Currently blocked** — `git remote -v` is empty, so there is nowhere for CI to run. This is a real blocker, not an undone task, and it is why every "CI enforces…" sentence in this documentation set has been rewritten to say what actually runs.

**Scope.** CI pipeline in the documented stage order; the `CAPABILITY_MATRIX.md` generator; the trace viewer; build-hash stamping and the reproducibility check.

**Exit gate:** the matrix is generated from registrations and test evidence rather than hand-written; an orphaned contract or unproven claim fails the build; an independent build produces an identical artifact hash; the three reproducibility claims are reported separately and never merged.

---

## Phase numbering: reconciling the old citations

Four documents cite "Phase 5" meaning the capability-matrix generator, from a numbering that predates this plan. In the dependency-derived numbering above, that work is **Phase 7 — Release truth**. Those citations have been updated. If you find a stray "Phase 5" referring to the matrix generator, it is stale.

`SYNTHESIS_STRATEGY.md`'s skeleton used a different split again (contracts, Core, oracle, application, adapters as separate phases 1–5). That numbering described work now collapsed into Phase 1, because the vertical slice cut through all of it at once. The strategy document keeps its property analysis; this plan owns the phasing.

---

## Risk register

| # | Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|
| R1 | A ported gate faithfully reproduces a source defect and every test passes | High — three shipped this way in the source | High | Differential oracle against the frozen linter | **Mitigated.** Observed catching two planted defects the full suite missed |
| R2 | A gate port deliberately improves on the source, disagrees forever, and the oracle gets deleted | High once Phase 2 starts | Severe — loses R1's mitigation | Divergence allowlist with a mandatory reason | **Open. Blocks Phase 2.** First candidate already known: `CLAIM_DISCIPLINE` flags `guarantee-free` because a hyphen is a word boundary |
| R3 | Cross-language arithmetic divergence in the three numeric gates | Medium | Medium — wrong verdicts, silently | Explicit `floor(x*100+0.5)/100`; no ambient tokenizer | Open — mitigation is documented, not yet exercised |
| R4 | Documentation drifts from the code again | High — it has, repeatedly | High — it is the project's recurring defect | Machine-checked status block; `npm run check:plan` in `verify`; README status table | **Mitigated for numbers.** Prose remains unchecked |
| R5 | No CI, so every guard depends on someone running `npm run verify` | Certain today | Medium under solo execution; high with contributors | `npm run verify` is one command and runs in ~10 s | Open — blocked on a remote (R8) |
| R6 | `storage-db` revision persistence is treated as a port when it is new design | Medium | Medium — a migration written under time pressure | Named as new work; schema lands as a reviewed migration first | Open, flagged |
| R7 | Stage templates are taken from the stale nine-stage copy on disk | Medium — the stale copy is the one in the repo | High — two stages silently missing | Phase 3 begins by extracting and freezing the eleven-stage component | Open, flagged |
| R8 | No git remote; work exists only on this machine | Certain today | Severe — total loss on disk failure | None currently | **Open. Highest unaddressed operational risk in the project.** |
| R9 | A guard's *scope* is quietly narrower than its name, so it passes without checking what everyone assumes it checks | High — happened three times | High — false confidence is worse than a known gap | Probe coverage, not just correctness: plant a defect in each place the guard is believed to cover and confirm it fires there | Open as a practice. Instances so far: the purity harness never blocked the filesystem; `typecheck` covered a third of the code; the cross-shell rule missed relative imports. All three passed continuously while incomplete |

---

## What this plan does not cover

- **Effort estimates.** Solo execution with no fixed schedule; a date here would be invention, and invented numbers are what this repository is recovering from.
- **The nineteen target properties.** There are fifteen in `ARCHITECTURE.md` and twenty-one in `SYNTHESIS_STRATEGY.md`, tracked there rather than duplicated here. Duplicating them is how the counts diverged in the first place.
- **Prose accuracy.** `check:plan` verifies numbers and command names. It cannot tell you a phase description has quietly stopped matching the work.
- **Prose in the phase descriptions.** Closed for the checkers themselves — `test/checkers.test.ts` now gives all three planted-defect pairs against fixture trees — but nothing checks that a phase's *description* still matches the work.
- **Anything past Phase 7.** Multi-tenancy, hosted deployment, and the technique-authoring workflow appear in the documentation set as target state and have no phase here, because their dependencies are not yet real enough to sequence.
