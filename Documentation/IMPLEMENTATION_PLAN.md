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
  "contracts": { "schemas": 13 },
  "adapters": ["provider-local-proxy", "storage-local"],
  "shells": ["cli"],
  "catalog": { "records_imported": 180, "records_available": 172, "records_added": 8 },
  "sources": { "frozen_files": 420 },
  "ci": { "configured": false },
  "commands": [
    "verify", "lint:boundaries", "verify:sources", "test", "typecheck",
    "differential", "cli", "check:plan", "check:citations", "check:citations:online",
    "import:catalog", "check:catalog", "check:xsd", "check:depth", "eval"
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
contracts   ████████████████████       13 schemas — 11 validated against real values, 2 awaiting a judge and a promotion path
core/gates  ██▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       2 of 16
core/stages █▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       1 of 11
application ████████████████▒▒▒▒       decide/invoke/reduce + lint; no cancellation, no catalog ops
adapters    ██████████▒▒▒▒▒▒▒▒▒▒       2 of 4 (hosted-server, storage-db absent)
shells      ██████▒▒▒▒▒▒▒▒▒▒▒▒▒▒       1 of 3
catalog     ███████████████████▒       180 records + registry, JSON contract and XSD both enforced; 15 gaps
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

### Phase 2b — The evaluation subsystem

**Entry condition: none.** This phase is not blocked by the divergence allowlist, the gate port, or anything else, and it is the one that makes every other phase's output measurable. [ADR-0008](./0008-evaluation-first-environment.md) is the design and the evidence.

**Why it moved ahead of the stage port.** Four measured results say prompt improvements are not monotonic and their sign depends on the model — a constrained prompt that beat CoT on one model generation lost on the next; appended generic rules cut a RAG suite from 26/30 to 9/30. Building ten more stages before anything can measure them raises the rate of unverifiable change.

**Scope.** The contract set first per ADR-0002, then Pipeline B at its minimum: one suite, deterministic detectors only, no judge, no perturbation — and it must be able to fail.

**Built so far.** The deterministic path runs end to end as `npm run eval`, inside `npm run verify`:

- **Contracts.** Eleven of thirteen schemas are now validated against values a real run produced. `judge-verdict` and `baseline` remain in `contracts/pending-implementation.json` because a judge adapter and a promotion path do not exist — and the stale rule means those entries fail the moment either does.
- **Core, pure.** `eval/detectors.ts` is a detector registry, and `eval/compare.ts` is the comparator: exact-binomial McNemar rather than the chi-square approximation, since a smoke suite lives exactly where the approximation misbehaves. `inconclusive` and `refused` are reachable verdicts, and alpha is Bonferroni-corrected by the declared family size.
- **Application.** `eval.ts` owns the effects and pins the provider per case, so the suite is offline, deterministic and free.
- **A suite.** `eval/compile-smoke.json`, eight cases, each naming the failure mode it exists to catch.

**What it measures, and what it does not.** This is a *pipeline* suite, not a model evaluation: it checks that gates fire when they should, degraded output labels itself and fabricates nothing, and provenance is complete. Those are the properties that fail silently. It calls no live provider, runs no judge, and at eight cases sits three orders of magnitude below the ≈3,400 items the sizing rule requires to certify a promotion. A green run here must never be read as evidence about a model.

**Probed.** Eight mutations — demo marker removed, degraded output fabricating a prompt, a gate unregistered, the secret scanner stopped matching, provenance losing its build hash, fenced documentation scanned as live text, and a suite naming a case nobody wrote. All eight failed the suite; the control stayed green.

**Still open in this phase:** detector-recall equalization (the comparator refuses without it, so nothing can compare yet), a live-provider path, the judge port, perturbation, and an anchor suite.

**Exit gate:** a candidate configuration is compared against a baseline over a suite, the comparison carries a significance result and detector-recall evidence, and a deliberately worse prompt is measured as worse. The last clause is the one that matters: a harness that has never reported a regression has not been shown to detect one.

### Phase 3 — The remaining ten stages

**Entry condition:** Phase 2 complete. The `lint` stage needs the full gate set to mean anything.

**Scope.** `deconstruct`, `calibrate`, `harden`, `critique`, `refine`, `lint`, `critic`, `preview`, `cost_estimate`, `tone_check`. Stage templates come from the eleven-stage pipeline component in `files_3.zip` — **which is not in this repository and is not frozen.** Extracting and freezing it is the first task of this phase, not an assumption of it.

Each stage is a `decide`/`reduce` pair with no callback, per ADR-0005. `cost_estimate` and `tone_check` are the two the inherited `docs/` tree never mentions; they have no prior documentation to port from and need their contracts written fresh.

**Exit gate:** an eleven-stage run persists and reloads intact as one bundle; every stage's `decide` returns a `GenerationRequest` and its `reduce` accepts a classified outcome; the purity harness stays green; `npm run verify` passes.

### Phase 4 — Catalog import — *mostly done*

**Entry condition:** none beyond Phase 1. **This phase is independent and can be pulled forward at any point** — nothing depends on it until Phase 6's toolkit surface, and it is the cheapest phase in the plan.

**Scope.** Import 172 technique records from the frozen `sources/catalog/data/`, validate against both the corrected 21-field `TechniqueRecord` contract and the frozen XSD, and build the catalog registry alongside the gate registry.

Worth doing early for a reason unrelated to its cost: `CONTRACTS.md` had the `TechniqueRecord` shape wrong, and importing the real records is what proves the correction.

**What is already known about the data**, from the literature review recorded in [`LITERATURE_CORPUS.md`](./LITERATURE_CORPUS.md):

- Every citation is internally consistent — 159 arXiv ids, none malformed, none reused for a different paper, no year contradicting its own preprint date, no missing author/year/title. `npm run check:citations` keeps that true.
- **39** **all 159** arXiv-cited records have been checked against arXiv's own metadata. Every identifier resolves — none is fabricated or dead. 149 titles match exactly; of the 10 that differ, one is cosmetic LaTeX, one is a stale-but-defensible original title, and **eight are wrong** and must be corrected during import. A further three records name `arXiv preprint` as their venue with no identifier, recorded in `scripts/catalog-known-defects.json`. `sources/` is hash-frozen, so every fix belongs in the import step.
- **Coverage has now been measured** against *The Prompt Report* (arXiv 2406.06608v6). Of 57 techniques recovered from its taxonomy, 34 have a catalog record and **23 do not** — and the gap is concentrated rather than general: **8 of the survey's 10 ensembling techniques are missing** (COSP, DENSE, DiVeRSe, Max Mutual Information, Meta-CoT, MoRE, USP, Prompt Paraphrasing), plus five few-shot exemplar/instruction-selection methods. The catalog is *wider* than the survey elsewhere, so this is a specific hole, not thinness.

**Done.** `npm run import:catalog` reads the frozen source, applies `scripts/catalog-corrections.json`, validates every record against `contracts/technique-record.schema.json`, and writes `core/src/catalog/techniques.json`. `core/src/catalog/registry.ts` exposes it as a pure registry — the data arrives as a module import, which is resolution rather than I/O, so Core keeps its purity. `npm run check:catalog` runs in `verify` and fails if the committed file is not what the source plus corrections currently produce.

**The eight wrong titles are fixed here, not in `sources/`.** The frozen tree is the record of what was inherited, defects included, and editing it would break the freeze. Each correction states its `from`, `to`, reason, and arXiv evidence, and the import **refuses** if the frozen value no longer matches `from` — a stale correction cannot apply silently. The three adjudicated non-defects are deliberately untouched and pinned by test.

**Still open in this phase:**

- ~~**XSD validation.**~~ **Done.** `npm run check:xsd` validates both the frozen XML export and XML generated from the imported 180 records against the frozen `prompt_technique_catalog_1.3.0.xsd`, using a WebAssembly build of libxml2 — no system `xmllint`, no Java, no native compilation, so `verify` stays offline and portable.

  Running it was not redundant with the JSON contract. The XSD carries **controlled vocabularies the JSON Schema had typed as free strings**, and the eight records added for ensembling had invented values in two of them: a `source_audit.description` of `abstract-verified` where the vocabulary is `verified-against-abstract`, and three `determinism` values of the form `deterministic-given-…` that exist in no schema. Both are fixed, and `contracts/technique-record.schema.json` now carries the same enumerations so the offline check catches this class too.

  The XSD's own header lists five constraints it cannot express — reference resolution, count agreement, category agreement, cross-record uniqueness of name/id/title/template_id, and template placeholder declaration. `import:catalog` and `check:citations` carry those. A green XSD result is necessary, not sufficient, and the command says so.
- **The 15 remaining coverage gaps now have resolved sources.** All fifteen were located by targeted arXiv lookup, every match exact, reducing to thirteen distinct papers — `scripts/catalog-gap-sources.json`. The corpus did not contain them because they are 2022–2023 originals and it skews 2025–2026; more reading would not have found them. What remains is authoring the records, on the same terms the ensembling eight got: description from the abstract, `verified-against-abstract`, pitfalls left unverified.
- **A scope question the corpus raises.** 127 RAG papers and 25 on long-term memory sit outside what the catalog covers — `retrieval-augmentation` holds 11 records and there is no memory category at all. Whether the platform's technique catalog should extend into either is a decision, not an oversight to quietly correct.
- ~~**The ensembling coverage gap.**~~ **Closed.** All eight missing techniques now have records, added at the import boundary through `scripts/catalog-additions.json` — 172 frozen records plus 8, giving 180. Every citation was resolved against arXiv's own metadata, and the additions are held to the same contract as the frozen records, with no id allowed to collide with one. Coverage against The Prompt Report's taxonomy went from 34 of 57 to 42 of 57; ensembling is 10 of 10. Fifteen scattered absences remain, but no category is now missing most of itself.
- **Three records naming `arXiv preprint` with no identifier**, excused in `scripts/catalog-known-defects.json`. Unlike the titles these cannot be corrected from evidence — the identifier is simply absent and no index resolved it.

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
| R10 | Catalog records are wrong in ways no internal check can see — a citation whose fields agree with each other but not with the source | Measured: **8 wrong titles in 159**, a 5% error rate | Medium — the catalog's authority rests on its citations | An external oracle. `check:citations` proves internal consistency and is structurally blind to this, exactly as parity is blind to a shared defect ([ADR-0007](./0007-permanent-differential-oracle.md)) | **Closed for arXiv.** All eight corrected at import with evidence; `check:catalog` keeps the emitted data honest. 12 non-arXiv citations remain unverified — no index resolved them |

---

## What this plan does not cover

- **Effort estimates.** Solo execution with no fixed schedule; a date here would be invention, and invented numbers are what this repository is recovering from.
- **The nineteen target properties.** There are fifteen in `ARCHITECTURE.md` and twenty-one in `SYNTHESIS_STRATEGY.md`, tracked there rather than duplicated here. Duplicating them is how the counts diverged in the first place.
- **Prose accuracy.** `check:plan` verifies numbers and command names. It cannot tell you a phase description has quietly stopped matching the work.
- **Prose in the phase descriptions.** Closed for the checkers themselves — `test/checkers.test.ts` now gives all three planted-defect pairs against fixture trees — but nothing checks that a phase's *description* still matches the work.
- **Anything past Phase 7.** Multi-tenancy, hosted deployment, and the technique-authoring workflow appear in the documentation set as target state and have no phase here, because their dependencies are not yet real enough to sequence.
