# Implementation Plan

**Status:** Active — 16 August 2026. Supersedes the phase skeleton in [`SYNTHESIS_STRATEGY.md`](./SYNTHESIS_STRATEGY.md), which stays in force for its property analysis.

This document was cited by six others for roughly a year before it existed. Phase numbers were quoted, exit gates referenced, and a risk register assumed — all pointing at a page nobody had written. That is the exact failure this repository was reorganised to stop, so the plan arrives with a checker attached.

## How this document stays true

Every falsifiable number below lives in one machine-checked block, and `npm run check:plan` verifies each against the repository. It runs inside `npm run verify`. A phase marked complete whose evidence has disappeared fails the build; a gate count that drifts fails the build; a command named in an exit gate that exists in neither `package.json` nor the planned list fails the build.

Prose can still go stale — the checker cannot read intent. What it can do is stop the *numbers* from lying, which is how the previous documentation set went wrong.

```json plan-status
{
  "gates": {
    "ported": 16,
    "source_total": 16
  },
  "stages": {
    "built": 11,
    "target": 11
  },
  "contracts": {
    "schemas": 16
  },
  "adapters": [
    "content-local",
    "evidence-local",
    "provider-local-proxy",
    "storage-local"
  ],
  "shells": [
    "api",
    "cli"
  ],
  "catalog": {
    "records_imported": 195,
    "records_available": 172,
    "records_added": 23
  },
  "sources": {
    "frozen_files": 420
  },
  "ci": {
    "configured": true
  },
  "commands": [
    "build:anchor",
    "build:hash",
    "check:anchor",
    "check:catalog",
    "check:citations",
    "check:citations:online",
    "check:corpus",
    "check:counts",
    "check:depth",
    "check:fence-explanation",
    "check:hash",
    "check:fingerprint",
    "check:hygiene",
    "check:manifest-spec",
    "check:matrix",
    "check:plan",
    "check:sizing",
    "check:stages",
    "check:truth",
    "check:xsd",
    "api",
    "cli",
    "differential",
    "docs:fence-explanation",
    "docs:manifest-spec",
    "docs:matrix",
    "docs:truth",
    "eval",
    "eval:adversarial",
    "eval:anchor",
    "eval:compare",
    "eval:pipeline",
    "import:catalog",
    "lint:boundaries",
    "lint:sources",
    "test",
    "test:app",
    "test:shells",
    "test:core",
    "typecheck",
    "verify",
    "verify:sources"
  ],
  "planned_commands": [
    "verify:gates",
    "trace:view",
    "scaffold:gate",
    "scaffold:technique",
    "catalog:validate",
    "parity"
  ]
}
```

## Where the work actually is

The completed work is a **vertical slice**, not a set of finished layers. It cuts through contracts, Core, Application, both adapters, and a Shell at a depth of one gate-pair and one stage. That matters for reading everything below: the architecture is proven end to end, and almost all remaining work is *widening* existing layers rather than building new ones.

```
                        built          target
contracts   ████████████████████       16 schemas — all 16 validated against values a real run produced
core/gates  ████████████████████       16 of 16 — ADVERSARIAL_RESILIENCE takes an injected corpus
core/stages ████████████████████       11 of 11, assembled — one bundle per run
application ██████████████████▒▒       eleven-stage pipeline runner; no cancellation, no catalog ops
adapters    ████████████████████▒▒▒▒   4 of 5 (hosted-server, storage-db absent)
shells      █████████████▒▒▒▒▒▒▒▒       2 of 3 — cli runs the full pipeline; api exposes the first REST slice
catalog     ████████████████████       195 records + registry, JSON contract and XSD both enforced; 0 gaps
release     █████████████▒▒▒▒▒▒▒       gate + matrix generator + CI workflow; never executed, no build hash
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

### Phase 2 — The remaining fourteen gates ✅ complete

**Entry condition — met, 18 August 2026.** The divergence allowlist ([ADR-0007](./0007-permanent-differential-oracle.md), action item 2) exists: `scripts/divergence-allowlist.json`, enforced by the oracle. A port that deliberately fixes a source defect now has a third option besides reproducing the defect and deleting the check — it declares the difference, with a reason and an ADR, and the oracle reports it as declared rather than going quiet.

It ships with **zero entries**, which is still correct after the port: all sixteen ported gates are faithful to the source. The mechanism was drilled against a real candidate divergence instead — 11 states, 11 correct, including the two that matter most: a stale entry left behind after the divergence is removed **fails**, and an exact-input entry **refuses** to excuse a divergence that is systematic. An allowlist that fails open is worse than none, because it launders disagreement into silence.

**Fourteen gates ported, 18 August 2026 — 16 of 16.** `npm run differential` compares them against the frozen linter over 2,720 verdicts on the default corpus, with zero disagreements and an empty allowlist. Every hazard this section named was handled: the arithmetic trio uses `floor(x*100+0.5)/100` and `max(1, len//4)` with no tokenizer; the citation pair was ported in one module and its interaction tested, including the self-declaring-citation case that silenced both gates in the source.

**The port also found a guard narrower than its name — the fifth instance of R9.** `tsVerdicts` passed only `includeFences` to `runGates`, because that was the sole option the TS side understood. Every option-gated gate was therefore handed defaults and compared against a Python run that *had* the flag. The harness looked like it exercised armed behaviour and never had. It surfaced the moment gates that read the other options existed: seven fixtures failed at once, all in the same direction. Fixing it took the comparison from 320 verdicts to 2,400.

**`ADVERSARIAL_RESILIENCE` took the corpus-injection decision this section reserved.** Its Python original bridges to a scorer module by absolute path, and that scorer opens `corpus.json` itself — file I/O inside a gate, which ADR-0001 forbids in Core. So the port takes the corpus as an option and the composition root supplies it; the gate stays a pure function of `(text, corpus)`.

What made that comparable rather than merely defensible is a property of the frozen tree. The linter looks for its scorer beside itself, at `sources/v5/adversarial/scorer.py` — and the scorer actually lives at `sources/v5/promptnexus-v5/adversarial/scorer.py`. **The linter the oracle runs can never locate it.** Armed, it has exactly one reachable verdict: `WARN, cannot score`. The port mirrors that state when no corpus is injected, so both sides agree on the armed branch and the oracle compares it for real.

The scoring path is the one the oracle **structurally cannot** check, because no configuration makes the frozen linter score. It is covered by unit tests injecting the frozen corpus — including that an undefended surface fails all its cases at once rather than averaging away, and that an empty corpus reads as unscoreable rather than as a perfect 0/0. That limit is recorded here rather than left for someone to assume the oracle covers it.

One faithful-but-questionable behaviour is now recorded rather than discovered: the safety-tier clause stem is `sanitiz`, and the source's own comment claims it covers "sanitization / sanitisation" — but `\bsanitiz` cannot match the British spelling, so a prompt written in British English fails a safety gate for an orthographic reason. The port reproduces it and pins it in a test. It is a candidate for the divergence allowlist, which is now the mechanism for exactly this.

**Scope.** `PLACEHOLDER_AUDIT`, `RUNTIME_KEY_UNDECLARED`, `TOKEN_SPAM`, `SOURCE_LEDGER_MISSING`, `ORPHAN_CLAIMS`, `GUARDRAIL_GAP`, `RECURSION_MACHINERY_PRESENT`, `RAG_SHIELD_GAP`, `TOKEN_BUDGET`, `DUPLICATE_INSTRUCTION`, `DELIMITER_ENTROPY`, `QUTM_CEILING`, `CONTEXT_LIMIT`, `ADVERSARIAL_RESILIENCE`.

Each is one module, one registry line, one `scripts/ported-gates.json` entry, a fixture test, and a property test. Four carry known hazards worth naming before they are written:

| Gate | Hazard |
|---|---|
| `TOKEN_BUDGET`, `CONTEXT_LIMIT`, `QUTM_CEILING` | Arithmetic. Python's banker's rounding diverges from `Math.round` at `.005`; the source uses explicit `floor(x*100+0.5)/100` and the port must too. No amount of parity testing surfaces this — both sides are internally consistent. |
| `TOKEN_BUDGET` and friends | No ambient tokenizer. The contract is `chars/4` everywhere; an optional `tiktoken` import would make verdicts depend on what happens to be installed. |
| `SOURCE_LEDGER_MISSING`, `ORPHAN_CLAIMS` | The pair that shipped the self-declaring-citation defect, where a citation inside an empty ledger section silenced *both*. Port them together and test the interaction, not each alone. |
| `ADVERSARIAL_RESILIENCE` | Depends on `adversarial/scorer.py`, a second frozen artifact. Decide explicitly whether the port calls it, reimplements it, or defers the gate. |

**Exit gate — met.** `npm run differential` compares **16 of 16** gates with zero disagreements outside the allowlist, and `scripts/ported-gates.json` lists all sixteen. The allowlist is empty, so every entry in it trivially states a reason and cites an ADR.

Read with the limit above attached: 16 of 16 means every gate is *compared*, not that every gate's every branch is. `ADVERSARIAL_RESILIENCE`'s scoring path has no oracle coverage available to it, by a property of the frozen tree rather than by choice.

**Cost note.** The oracle spawns Python once per *case*, not per gate, so its runtime does not grow as gates are added — 440 cases takes 21 s at two gates and will take about 21 s at sixteen. ADR-0007's action item 3 assumed otherwise; that item is being corrected rather than carried.

### Phase 2b — The evaluation subsystem

**Entry condition: none.** This phase is not blocked by the divergence allowlist, the gate port, or anything else, and it is the one that makes every other phase's output measurable. [ADR-0008](./0008-evaluation-first-environment.md) is the design and the evidence.

**Why it moved ahead of the stage port.** Four measured results say prompt improvements are not monotonic and their sign depends on the model — a constrained prompt that beat CoT on one model generation lost on the next; appended generic rules cut a RAG suite from 26/30 to 9/30. Building ten more stages before anything can measure them raises the rate of unverifiable change.

**Scope.** The contract set first per ADR-0002, then Pipeline B at its minimum: one suite, deterministic detectors only, no judge, no perturbation — and it must be able to fail.

**Built so far.** The deterministic path runs end to end as `npm run eval`, inside `npm run verify`:

- **Contracts.** All fifteen schemas are validated against values a real run produced, and `contracts/pending-implementation.json` is empty. `judge-verdict` left it in Phase δ when the judge adapter landed; `baseline` left it in Phase ε when the release pipeline did, and `promotion` was written with its producer. Landing each schema first did what ADR-0002 promises — `baseline`'s `superseded_by` turned out to be unwritable, which is only discoverable by trying to write one.
- **Core, pure.** `eval/detectors.ts` is a detector registry, and `eval/compare.ts` is the comparator: exact-binomial McNemar rather than the chi-square approximation, since a smoke suite lives exactly where the approximation misbehaves. `inconclusive` and `refused` are reachable verdicts, and alpha is Bonferroni-corrected by the declared family size.
- **Application.** `eval.ts` owns the effects and pins the provider per case, so the suite is offline, deterministic and free.
- **A suite.** `eval/compile-smoke.json`, eight cases, each naming the failure mode it exists to catch.

**What it measures, and what it does not.** This is a *pipeline* suite, not a model evaluation: it checks that gates fire when they should, degraded output labels itself and fabricates nothing, and provenance is complete. Those are the properties that fail silently. It calls no live provider, runs no judge, and at eight cases sits three orders of magnitude below the ≈3,400 items the sizing rule requires to certify a promotion. A green run here must never be read as evidence about a model.

**Probed.** Eight mutations — demo marker removed, degraded output fabricating a prompt, a gate unregistered, the secret scanner stopped matching, provenance losing its build hash, fenced documentation scanned as live text, and a suite naming a case nobody wrote. All eight failed the suite; the control stayed green.

**Detector-recall equalization — done.** `detectors_equalized` was a boolean the caller supplied and nothing computed; the comparator's strongest guard was a field somebody filled in, the fourth instance of a guard narrower than its name. Recall is now *measured*, per `(detector, configuration)`, from mutation probes applied to each run's own outcomes — the design and its evidence are in [the spec](../docs/superpowers/specs/2026-08-18-detector-recall-equalization-design.md).

- **Ground truth is constructed, not labelled.** A probe injects the property a detector exists to catch, so the label is known by construction. A probe counts only on a substrate where the detector was *silent beforehand* — detection on an outcome that already carried the property proves nothing.
- **The gap bound is derived, not chosen.** `gap_bound = detectable_delta`. Since a pure recall artifact has magnitude `f·(r_b − r_c) ≤ |Δr|` with `f ≤ 1`, bounding the gap by `detectable_delta` bounds the artifact by it — while `adjusted_resolution = detectable_delta / min(r)` is strictly larger whenever a gap exists. **A recall artifact can never on its own clear the reporting threshold**, and the edge case where that would go non-strict needs both recalls to equal 1, which makes the gap zero.
- **Two zeros, deliberately distinct.** `recall: 0` is measured-and-dead and fails the build; `substrates: 0` means the detector fired on everything, so recall is `null` and the comparison refuses. Collapsing them would fail the build for the wrong reason.
- **Contracts.** `eval-run` 1.1.0 adds `detector_recall`; `comparison` 2.0.0 **deletes** `detectors_equalized` for a derived `equalization` object. The boolean was deleted rather than kept beside the evidence: a summary readable without consulting the evidence is what let the guard go unchecked. `contracts/CHANGELOG.md` now exists — ADR-0002 has required changelog entries all along with no artifact behind them.
- **The suite grew from 8 to 14 cases**, adding placeholder, leaked-secret, delimiter-lookalike, empty-input and Unicode/CRLF coverage. Not cosmetic: only four of the original eight could be flipped by a prompt change, and evidencing a regression needs **six** one-directional flips (p=0.031; five gives 0.063 and does not clear). An eight-case suite could not have demonstrated the exit gate.

**Probed.** Eight planted defects — a no-op probe mutation, a probe naming a detector nobody wrote, a hardcoded `gap_bound`, `max` for `min`, the de-attenuating resolution direction, an ignored probe-corpus mismatch, a detector rewritten to fire unconditionally, and the equalization refusal skipped outright. All eight caught, control green.

**Still open in this phase:** a live-provider path, the judge port, perturbation, and an anchor suite. Precision is also assumed rather than measured — `substrates: 0` catches the always-fires case, but a detector with a moderate false-positive rate would pass everything here, and measuring precision needs negatives known clean.

**Exit gate — met.** `npm run eval:compare` runs the suite under a baseline and a deliberately worse configuration: 14/14 against 4/14, delta −0.714, p=0.00195, verdict **regressed**, with equalization derived and checked *before* the measurement. Both runs are pinned, so the regression is declared rather than sampled — what is demonstrated is the harness's ability to report one, which is the clause that matters: a harness that has never reported a regression has not been shown to detect one.

### Phase 3 — The remaining ten stages ✅ complete

**Entry condition:** Phase 2 complete. The `lint` stage needs the full gate set to mean anything.

**Scope.** `deconstruct`, `calibrate`, `harden`, `critique`, `refine`, `lint`, `critic`, `preview`, `cost_estimate`, `tone_check`.

**Correction, 18 August 2026.** This section said the eleven-stage component "is not in this repository and is not frozen," and that extracting it was the first task of the phase. **It was already frozen**, in Phase 0, at `sources/pipeline/SystemPromptBuilderPipeline.tsx` — SHA-256 `79deaad875a8…`, byte-identical to the copy inside `files_3.zip`, carrying `Cost Estimate`, `Tone Check` and the "Unified 11-stage map" comment. The manifest has listed it under `archive_id: files_3` the whole time. The plan was wrong about its own repository, which is R4 appearing inside the sentence warning about R7.

**The real trap is still live, and it is not the one R7 named.** A *nine-stage* copy sits unfrozen in the repository root — `SystemPromptBuilderPipeline.tsx`, SHA-256 `c519e72b…`, no `Cost Estimate`, no `Tone Check`. Its mtime is **newer** than the frozen one, so "check mtimes" points the wrong way; only the content distinguishes them.

**And a port from the wrong shape has already happened once.** `compile.ts` carries the comment "Prompt template ported from … (DEFAULT_STAGES, s3 'Compile')", and its template is not that template: frozen `s3` opens "STEP 2 — SCAFFOLDING" and threads `{calibration}` and `{blueprint}`; the port opens "STEP 3 — COMPILATION" and threads neither. That was defensible — neither slot had a producer during the vertical slice — but it was never recorded, and the comment asserted a fidelity the code did not have.

**So this phase opens with a checker, not a stage.** `npm run check:stages` re-derives the eleven stage ids from the frozen component and requires `STAGE_IDS` to match *in order*, re-derives `DEPTH_PLAN` and requires the deepest plan to reach every stage, and compares every ported template against its frozen source. A deviation is legal only in `scripts/stage-template-deviations.json`, with a reason, under the stale rule the divergence allowlist uses. It caught `compile` on its first run.

This matters more here than it did for gates: **stages have no differential oracle.** A gate that drifts disagrees with the Python linter; a stage that drifts produces prose that still looks like a prompt. Ten ports were about to be written against a component nothing compared them to.

Each stage is a `decide`/`reduce` pair with no callback, per ADR-0005. `cost_estimate` and `tone_check` are the two the inherited `docs/` tree never mentions; they have no prior documentation to port from and need their contracts written fresh. Note also that **not every stage runs at every depth** — `DEPTH_PLAN` runs six of eleven at `TINY` and seven at `MINIMAL` — so an eleven-stage run is the `STANDARD`/`COMPREHENSIVE` path, not the only path.

**All eleven stages ported, 18 August 2026.** Every template verbatim, zero declared deviations. `compile`'s deviation entry is **gone**: `deconstruct` and `calibrate` supply `{previous}` and `{calibration}`, `{blueprint}` was always a constant, so frozen s3 fits. Deleting it was not optional — once the template matched, the stale rule failed the build until the entry went, which is the ratchet running the direction it was built for.

Three shapes, not one. Six stages generate and share `COMPILER_SYSTEM`. Two are **deterministic and have no `decide` at all** — `lint` and `cost_estimate` perform no effect, and ADR-0005's split exists to keep Core from performing one; forcing it here would return a request nothing should execute. Three bring their own identity: `critic` and `tone_check` have their own system prompts, and `preview` is the only stage whose system prompt is *data* — it runs the finished prompt AS the system message, because sending the compiler identity there would test the compiler instead of its output.

**The sixth instance of R9, and this one was mine.** The frozen pipeline attaches a shared compiler identity to every non-preview call — anti-override, out-of-scope refusal, fact-grounding, placeholder completeness — at the *call site*, not in the template field. `GenerationRequest` had no `system` at all, so the first six ported stages sent their stage instruction and nothing else. Every template matched the source; half of every prompt was missing; nothing failed. `check:stages` could not see it because it compared template text — a checker whose name says "stages" and whose scope was "stage templates".

The consequence was not cosmetic. `FACT-GROUNDING` forbids exactly the language `CLAIM_DISCIPLINE` flags, so its absence makes the pipeline's own gate fire on the pipeline's own output. The ports were also using an 8000-token ceiling against the source's 2400 / 800 / 1400 / 900 per stage — a ceiling is a cost control and a truncation risk at once.

Fixed by adding `system` to `GenerationRequest`, wiring it through the local-proxy adapter as a top-level field (which is the provider API's shape and the source's), and extending `check:stages` to require every declared `*_SYSTEM` constant to appear verbatim in the frozen component. Tests assert the runtime half the checker still cannot see: that each generating stage actually *sends* the identity, and that its request id covers the system prompt so two materially different requests cannot share one.

**A latent defect in the frozen component, found by porting its own invariant.** The source's `fill()` refuses to send a template with an unresolved `{slot}`, using `/\{[a-zA-Z][^}]*\}/`. That pattern matches `{VARIABLE_1}` *inside* `{{VARIABLE_1}}` — and `BLUEPRINT` is full of doubled braces, so interpolating the blueprint into s3 makes the guard throw. **The frozen compile stage cannot render.** Verified by running the source's exact `fill()` against its own s3 and blueprint: `{VARIABLE_1}, {VARIABLE_2}` unresolved, every time.

Two brace conventions were conflated: `{calibration}` is a slot *this pipeline* fills, `{{VARIABLE_1}}` is a slot the *compiled prompt* exposes to its own callers and must reach the model intact. The port fixes it and says so — reproducing this one faithfully would ship a stage that always throws. Unlike a gate divergence there is no oracle to declare it to, so it is recorded in `stage-kit.ts` and pinned by a test that asserts the frozen guard *would* have thrown.

**Exit gate — met, 18 August 2026.** `application/src/pipeline.ts` walks the plan Core supplies in `core/src/stages/pipeline.ts`; an eleven-stage run persists one revision per stage — skipped and failed stages included — under a single `run_id`, and reloads through `store.getRun` in frozen order. Every generating stage's `decide` returns a request and its `reduce` accepts a classified outcome; the purity harness stays green; `npm run verify` passes at 432 tests.

The plan is a **registry, not a switch**, for the reason the gate registry is: seventeen surveyed prototypes hardcoded their lists and none grew past its author's set. Here it is also a practical necessity — the eleven stages share no input type, so a switch would scatter eleven ad-hoc argument mappings through the runner. Core's `DEPTH_PLAN` is checked against the frozen one by `check:stages`, so the stage-id translation cannot drift.

**Assembly exposed an honesty hole that no single stage could show.** When `harden` degraded, `prompt` became a labelled placeholder — and `refine` then rewrote that placeholder into a clean-looking prompt with no marker on it. The run still reported `demo_mode: true`, but the *artifact* no longer did, and the artifact is what gets read and shipped. The guarantee is not "the run knows it degraded"; it is that output produced without a model never presents itself as though it had one.

Fixed with `isDemoArtifact`: a transforming stage handed a placeholder **declines**, because a placeholder is not a prompt and there is nothing to transform. `harden` and `refine` both skip on it.

Probing that fix caught a second, quieter mistake. The first test looked like it covered both guards and covered neither properly — it failed `harden`, so `refine`'s guard did all the work and removing `harden`'s changed nothing. Failing `compile` instead is what hands `harden` a degraded prompt. Both guards are now individually probed: remove either and the suite fails.

**`compile`'s inline gating is reconciled.** `lint` owns the run's verdict, computed with the full sixteen-gate registry against the final prompt rather than an intermediate one. `compile` still gates inline for the single-stage path the eval suite uses, and that is now a stated split rather than an unexamined leftover.

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

- ~~**XSD validation.**~~ **Done.** `npm run check:xsd` validates both the frozen XML export and XML generated from the imported 195 records against the frozen `prompt_technique_catalog_1.3.0.xsd`, using a WebAssembly build of libxml2 — no system `xmllint`, no Java, no native compilation, so `verify` stays offline and portable.

  Running it was not redundant with the JSON contract. The XSD carries **controlled vocabularies the JSON Schema had typed as free strings**, and the eight records added for ensembling had invented values in two of them: a `source_audit.description` of `abstract-verified` where the vocabulary is `verified-against-abstract`, and three `determinism` values of the form `deterministic-given-…` that exist in no schema. Both are fixed, and `contracts/technique-record.schema.json` now carries the same enumerations so the offline check catches this class too.

  The XSD's own header lists five constraints it cannot express — reference resolution, count agreement, category agreement, cross-record uniqueness of name/id/title/template_id, and template placeholder declaration. `import:catalog` and `check:citations` carry those. A green XSD result is necessary, not sufficient, and the command says so.
- ~~**The 15 remaining coverage gaps.**~~ **Closed.** All fifteen were located by targeted arXiv lookup, every match exact, reducing to thirteen distinct papers — `scripts/catalog-gap-sources.json` — and the records were then authored on the same terms the ensembling eight got: description from the abstract, `verified-against-abstract`, pitfalls left unverified. The catalog is 195 records. Two of the fifteen are parent techniques whose paper also covers a child (`exemplar-generation`/`sg-icl`, `exemplar-selection`/`vote-k`); `autodicot` cites the survey itself, and its `known_pitfalls` says so rather than implying an independent evaluation. The corpus did not contain these papers because they are 2022–2023 originals and it skews 2025–2026; more reading would not have found them.
- **A scope question the corpus raises.** 127 RAG papers and 25 on long-term memory sit outside what the catalog covers — `retrieval-augmentation` holds 11 records and there is no memory category at all. Whether the platform's technique catalog should extend into either is a decision, not an oversight to quietly correct.
- ~~**The ensembling coverage gap.**~~ **Closed.** All eight missing techniques now have records, added at the import boundary through `scripts/catalog-additions.json` — 172 frozen records plus 23, giving 195. Every citation was resolved against arXiv's own metadata, and the additions are held to the same contract as the frozen records, with no id allowed to collide with one. Coverage against The Prompt Report's taxonomy went from 34 of 57 to 42 of 57; ensembling is 10 of 10. Fifteen scattered absences remain, but no category is now missing most of itself.
- **Three records naming `arXiv preprint` with no identifier**, excused in `scripts/catalog-known-defects.json`. Unlike the titles these cannot be corrected from evidence — the identifier is simply absent and no index resolved it.

### Phase 5 — Second adapters

**Entry condition:** Phase 3, so there is a full pipeline to persist.

**Scope.** `provider-hosted-server` (server-side key custody, ported from the GitHub product) and `storage-db`.

**`storage-db` is new work, not a port, and the plan should stop implying otherwise.** The inherited Drizzle schema is MySQL with `users` and `promptAssets` and no revisions table. The revision schema needs designing and must land as a reviewed migration *before* either storage adapter changes — contract-first applies to database schemas too.

**Exit gate:** one adapter contract suite runs against both implementations of each port with identical results; the 27-assertion proxy security suite is mapped one-to-one, with every assertion either ported or recorded as N/A with a reason.

### Phase 6 — Shells

> **`shells/api` was adopted on 29 August 2026 — ADR-0012.** It arrived on 2026-08-27
> unwired, with four declared runtime dependencies of which it imported two, and one it
> imported but did not declare. It was excluded from the root typecheck and tested by nothing.
> The paragraph that stood here said installing those dependencies was an ADR rather than a
> build fix. That was right, and ADR-0012 is the ADR.
>
> What forced the decision was not tidiness: a botched commit truncated `shells/api/package.json`
> and `package-lock.json` mid-file, so `npm ci` refused outright and CI could not install the
> project at all. A directory that is neither owned nor deleted stops being a question about
> architecture and becomes an outage.
>
> It now compiles, is typechecked with everything else, and its routes and socket seam are
> tested. The zero-runtime-dependency property is **scoped, not dropped**: `contracts`, `core`,
> `application`, the adapters and `shells/cli` still ship nothing in `dependencies`;
> `shells/api` ships `fastify` and `@fastify/sensible`. Nothing that computes a verdict, a
> score or a revision imports outside the standard library, so the oracle, the anchor and every
> gate stay reproducible with no registry involved.

**Entry condition:** Phases 3 and 4.

**Scope.** The shared presentation package first, then `pipeline-ui`, then `toolkit-ui`. Per ADR-0006 the Shells never import each other; reuse goes through the shared package, which is what makes per-Shell rollback real.

**Exit gate:** cross-shell parity — the same input through `cli` and through `pipeline-ui` produces identical `GateResult`s. Note that parity is a *drift* check and cannot see a shared defect; the oracle remains the correctness check.

### Phase 7 — Release truth

**Entry condition:** a git remote exists. **Met 23 August 2026** — `origin` is `github.com:hynix666/nexusprompt`, private. `ci.configured` reads `true` because `check:plan` derives it from the presence of a `.github` directory.

That derivation is narrower than it sounds, and the distinction is worth keeping even now that it has stopped biting: **configured and executed are different states, and only the first is checkable from inside this repository.** The workflow has in fact run many times — it gated every pull request from #17 to #28, and it caught a broken `npm ci` that no local command could see, because `npm install` repairs quietly and a checkout never runs `npm ci`. But nothing in this repository can verify that sentence; it is a claim about GitHub, made here in prose, and it will go stale the same way its predecessor did. Treat it as a report, not as a check.

**Scope.** CI pipeline in the documented stage order; the `CAPABILITY_MATRIX.md` generator; the trace viewer; build-hash stamping and the reproducibility check.

**Status — 29 August 2026: three of four exit-gate clauses met; the phase is NOT complete.**

| Exit-gate clause | |
|---|---|
| the matrix is generated rather than hand-written | ✅ `docs:matrix` / `check:matrix`, deriving coverage from the validators the conformance suite exercises |
| an orphaned contract or unproven claim fails the build | ✅ `check:matrix`, `check:counts` (44 occurrences of 39 pins), `check:truth` (9 boundaries) |
| an independent build produces an identical artifact hash | ✅ `build:hash` / `check:hash` — 75 artifact files, one hash |
| the three reproducibility claims are reported separately and never merged | ✅ the `three-reproducibility-claims` entry in the truth boundary |
| **the trace viewer** | ❌ **not built.** `trace:view` remains in `planned_commands` |

The artifact hash needs its scope stated rather than assumed. It normalises content to LF
before hashing, because `core.autocrlf` is `true` here and only `sources/**` is pinned to LF —
so raw bytes differ between a Windows and a Linux checkout of the same commit. Hashing bytes
would have produced a platform check wearing a reproducibility check's name: green locally,
red on its first CI run. The test proves the property against git's object store, which holds
exactly the bytes the other platform receives.

And the claim is deliberately narrow: **nothing is compiled.** There is no bundle and no emit;
`tsc --noEmit` typechecks and produces nothing, `tsx` transpiles at run time. "Same source,
same hash" is true and is not "reproducible builds". The truth boundary keeps the three claims
apart for exactly that reason — collapsing them lets the weakest borrow the strongest's
credibility.

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
| R2 | A gate port deliberately improves on the source, disagrees forever, and the oracle gets deleted | High once Phase 2 starts | Severe — loses R1's mitigation | Divergence allowlist with a mandatory reason | **Mitigated, 18 Aug 2026.** `scripts/divergence-allowlist.json`, enforced by the oracle; the allowlist holds 4 entries, each pinning both verdicts and naming an ADR. Drilled through 11 states including a stale entry and an entry too narrow for a systematic divergence — both refuse. The candidate this row named is not one: the source shares that false positive |
| R3 | Cross-language arithmetic divergence in the three numeric gates | Medium | Medium — wrong verdicts, silently | Explicit `floor(x*100+0.5)/100`; no ambient tokenizer | Open — mitigation is documented, not yet exercised |
| R4 | Documentation drifts from the code again | High — it has, repeatedly | High — it is the project's recurring defect | Machine-checked status block; `npm run check:plan` in `verify`; README status table | **Mitigated for numbers.** Prose remains unchecked |
| R5 | ~~No CI, so every guard depends on someone running `npm run verify`~~ | — | — | `.github/workflows/verify.yml` runs `npm run verify` on every push and PR; first execution 23 August 2026 was green on a clean Ubuntu checkout | **Closed 23 August 2026.** |
| R6 | `storage-db` revision persistence is treated as a port when it is new design | Medium | Medium — a migration written under time pressure | Named as new work; schema lands as a reviewed migration first | Open, flagged |
| R7 | Stage templates are taken from the stale nine-stage copy on disk | Medium — the stale copy is the one in the repo | High — two stages silently missing | Phase 3 begins by extracting and freezing the eleven-stage component | Open, flagged |
| R8 | ~~No git remote; work exists only on this machine~~ | — | — | `origin` = `github.com:hynix666/nexusprompt` (private), `master` pushed and tracking | **Closed 23 August 2026.** Was the highest unaddressed operational risk; closing it also unblocked R5 and Phase 7. |
| R9 | A guard's *scope* is quietly narrower than its name, so it passes without checking what everyone assumes it checks | High — happened three times | High — false confidence is worse than a known gap | Probe coverage, not just correctness: plant a defect in each place the guard is believed to cover and confirm it fires there | Open as a practice. Instances so far: the purity harness never blocked the filesystem; `typecheck` covered a third of the code; the cross-shell rule missed relative imports. All three passed continuously while incomplete |
| R10 | Catalog records are wrong in ways no internal check can see — a citation whose fields agree with each other but not with the source | Measured: **8 wrong titles in 159**, a 5% error rate | Medium — the catalog's authority rests on its citations | An external oracle. `check:citations` proves internal consistency and is structurally blind to this, exactly as parity is blind to a shared defect ([ADR-0007](./0007-permanent-differential-oracle.md)) | **Closed for arXiv.** All eight corrected at import with evidence; `check:catalog` keeps the emitted data honest. 12 non-arXiv citations remain unverified — no index resolved them |

---

## What this plan does not cover

- **Effort estimates.** Solo execution with no fixed schedule; a date here would be invention, and invented numbers are what this repository is recovering from.
- **The nineteen target properties.** There are fifteen in `ARCHITECTURE.md` and twenty-one in `SYNTHESIS_STRATEGY.md`, tracked there rather than duplicated here. Duplicating them is how the counts diverged in the first place.
- **Prose accuracy.** `check:plan` verifies numbers and command names. It cannot tell you a phase description has quietly stopped matching the work.
- **Prose in the phase descriptions.** Closed for the checkers themselves — `test/checkers.test.ts` now gives all three planted-defect pairs against fixture trees — but nothing checks that a phase's *description* still matches the work.
- **Anything past Phase 7.** Multi-tenancy, hosted deployment, and the technique-authoring workflow appear in the documentation set as target state and have no phase here, because their dependencies are not yet real enough to sequence.
