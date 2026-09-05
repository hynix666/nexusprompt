# The truth boundary

**Generated from `spec/truth-boundary.json`. Do not edit.**
`npm run docs:truth` writes it; `npm run check:truth` re-derives every pinned number
from the repository and fails when one has moved. It runs inside `npm run verify`.

Every other check in this repository asks whether a number is right. This one asks what
it is right *about*. A correct figure attached to an overreaching claim is the more
dangerous of the two, because a checker has already blessed it.

10 entries · spec version 1.0.0.

Each entry states a scope in two halves and pins the numbers that bound it. The
**Crossed when** line names the event that should make someone rewrite the claim —
that event is a failing build, not a note in a backlog.

---

## Local models have answered; nothing this repository REPORTS came from one

`no-model-has-answered` · probe `providerReach`

**Establishes.** The provider path runs end to end against a real model, and degrades honestly when it cannot. Crossed on 31 August 2026: `nexusprompt pipeline --model <name>` reaches an Ollama daemon on loopback, and 6 distinct local models have answered and are pinned. Five completed six-stage LOW-stakes runs with every revision carrying a real `provider_model_fingerprint` rather than a null; the sixth, a 27B model, was pinned from the first stage of a run still in progress, because a fingerprint is what a watch needs and a completed run is not. Those fingerprints are pinned, so `check:fingerprint` is armed and a model changing underneath this repository is now a build failure rather than an unnoticed one. The degraded path is unchanged and still verified: with no `--model` and no key the run completes, labels every stage, and exits 3. The live path still refuses before it spends anything, in four independent places, each verified by hand on 29 August 2026: no key at all, a key whose shape says placeholder, a well-shaped key with no declared budget, and a budget flag that is not a positive integer. Every one exits 2 having made no provider call. The budget refusal is the load-bearing one — `admitRun` admits everything when no budget is declared, so without it the FIRST hosted run would have been the unbounded one.

**Does not establish.** Any claim about how a language model behaves, and in particular nothing about the figures this repository reports. EVERY evaluation number here still comes from the pinned stub — the anchor's 4,906 cases, each smoke suite, every gate recall figure — and they remain evidence about this system's accounting rather than about a model's output. What crossing the boundary bought is narrower than it sounds: 6 models compiling ONE brief at LOW stakes, with no expected output, no scoring, and no comparison. Every gate returned PASS on all of them, which says the compiled prompts satisfy static checks, not that any model is good or that two models differ. Those runs are also not reproducible — models are stochastic, temperature is not pinned, and the bundles are gitignored, so nothing in this tree re-derives them and CI has never seen one. No hosted model has answered: the `--live` path has still never executed. No prompt-engineering advice in the documentation set has been measured against a model.

**Pinned:**

```json
{
  "any_fingerprint_pinned": true,
  "fingerprints_pinned": 1,
  "run_bundles_are_gitignored": true,
  "placeholder_key_refused": true,
  "real_shaped_key_accepted": true,
  "live_requires_declared_budget": true
}
```

**Crossed when.** Already crossed for the local transport, on 31 August 2026. What remains uncrossed, and would each be a separate event: a HOSTED model answering, which is the one that costs money and sends briefs off this machine — watch `live_requires_declared_budget`, whose going false would mean a run can spend without a declared cap; and any evaluation figure in this repository being produced by a model rather than the stub, which is the change that would make the reported numbers evidence about model behaviour. `fingerprints_pinned` dropping to 0 would mean the watch was emptied while models are still being run, which is the same silence this entry existed to prevent. Note that this entry is pinned on `any_fingerprint_pinned`, read from the committed watch file, and NOT on `any_fingerprint_observed`, which reads run bundles: those are gitignored, so declaring the observed flag pins a boundary to whichever machine happens to run the check. Declared false it failed the moment anyone ran `pipeline --model`; declared true it failed in CI, which has no bundles. Both were observed in that order on 31 August 2026. The observed flag is still derived and rendered, because a repository that has accepted a fingerprint but cannot see one locally is a fact worth reading.

**Evidence:** `scripts/check-fingerprint.mjs` · `scripts/model-fingerprints.json` · `application/src/eval.ts` · `scripts/run-eval.ts`

## The differential oracle proves agreement, not correctness

`oracle-proves-agreement-not-correctness` · probe `oracleScope`

**Establishes.** All sixteen ported gates are compared verdict-for-verdict against the frozen Python linter they were ported from, and the linter is SHA-256 pinned in the source freeze so it cannot be edited into agreement. Where the port deliberately differs, the difference is declared with a reason and an ADR rather than reconciled or hidden — four such divergences, from two ADRs.

**Does not establish.** That either implementation is right. They are two expressions of one author's opinion about what makes a prompt bad, and an oracle can only tell you they still agree. Where they agree and are both wrong, this check is silent — the `CLAIM_DISCIPLINE` false positive is exactly that shape, which is why it is not in the allowlist: there is no divergence to declare. The gates also have no external validity here; no experiment in this repository connects a gate firing to any outcome a user would care about.

**Pinned:**

```json
{
  "gates_in_registry": 16,
  "gates_in_source_linter": 16,
  "gates_compared": 16,
  "declared_divergences": 4,
  "divergence_adrs": [
    "ADR-0010",
    "ADR-0011"
  ],
  "oracle_is_frozen": true
}
```

**Crossed when.** A divergence is added or retired, or a gate stops being compared. Each is a decision about how far the port may drift from its oracle, and each should arrive with the ADR that justifies it.

**Evidence:** `scripts/differential.ts` · `scripts/divergence-allowlist.json` · `scripts/ported-gates.json` · `sources/v5/prompt_lint.py` · `Documentation/0007-permanent-differential-oracle.md`

## The anchor measures gate recall over generated text

`anchor-measures-its-own-registry` · probe `anchorLabels`

**Establishes.** A 4,906-case paired comparison whose ground truth is derived rather than authored: a fragment is injected and the case is kept only when exactly one previously-silent gate starts firing, so that gate is the label and no human chose it. The two arms partition the registry — eight gates each, zero overlap, union equal to the whole — so the null is not known false before scoring, which a nested comparison would have made it. The whole suite regenerates from seed 1, so it is reproducible by anyone.

**Does not establish.** That the gates are useful, or that anything in it resembles a prompt a person would write. Every case is machine-generated; none was reviewed. Because labels come from gate behaviour, a gate that is systematically wrong is systematically wrong in its own ground truth too — the anchor cannot see a blind spot shared by the injector and the gate. It is a recall instrument for a registry, and its 4,906 cases say nothing about prompt quality, model behaviour, or the catalog's 195 techniques.

**Pinned:**

```json
{
  "cases": 4906,
  "seed": 1,
  "label_source": "core/src/eval/anchor.ts",
  "arms_overlap": 0,
  "arms_cover_registry": true,
  "baseline_gates": 8,
  "candidate_gates": 8,
  "cases_stored_inline": 0,
  "case_ids_stored": 4906
}
```

**Crossed when.** The arms stop partitioning the registry, a case is labelled by hand, or the generator changes. Any of the three turns the anchor into a different instrument measuring a different thing under the same name.

**Evidence:** `core/src/eval/anchor.ts` · `eval/gate-recall-anchor.json` · `scripts/build-anchor.ts` · `scripts/run-anchor.ts`

## A green smoke suite is not a measurement

`smoke-suites-are-wiring-checks` · probe `suiteResolution`

**Establishes.** What each suite can resolve, derived rather than declared. Under McNemar the statistic is binomial(d, 0.5), so the smallest two-sided p any arrangement of d discordant units can produce is 2·0.5^d — which clears α = 0.05 only from six upward. The anchor is sized against that floor and resolves 0.000204. The comparator enforces the floor itself, and refuses rather than returning `inconclusive` below it, because 'we could not have seen anything' and 'we looked and saw nothing' are different findings.

**Does not establish.** Anything, in the case of the three original smoke suites. `pipeline-smoke` holds five cases and is below the exact floor outright: no arrangement of its results could reach significance. `compile-adversarial` and `compile-smoke` clear six only in the sense that their SIZE does — the floor is on discordant units, of which a suite's size is merely an upper bound, so eleven or fourteen cases still resolve nothing in practice. `brief-pilot` has one hundred cases, which is above the floor, but a 100/100 stub run is not a model comparison: it verifies internal consistency (each stub satisfies the case's own expectation and trips no gate FAIL) and that the wiring runs. A model comparison on brief-pilot requires two models and is what the sweep measurement produces. A green smoke run is not evidence that one configuration outperforms another.

**Pinned:**

```json
{
  "exact_floor_discordant_units": 6,
  "anchor_cases": 4906,
  "anchor_detectable_delta": 0.000204,
  "smoke_suite_sizes": {
    "brief-pilot": 100,
    "compile-adversarial": 11,
    "compile-smoke": 14,
    "pipeline-smoke": 5
  },
  "smoke_suites_below_exact_floor": 1
}
```

**Crossed when.** A smoke suite grows toward a size at which someone might read its result as a finding, or the anchor's granularity drifts from 1/n. `check:sizing` fails on the second; this entry is the reminder for the first.

**Evidence:** `core/src/eval/sizing.ts` · `core/src/eval/compare.ts` · `scripts/check-sizing.ts` · `scripts/suite-sizing-acknowledgments.json`

## One gate's reading of one shape is specified; the rest is described

`manifest-reading-is-specified` · probe `manifestSpec`

**Establishes.** `RUNTIME_KEY_UNDECLARED` reads a runtime manifest according to 161 cases that are simultaneously the test, the generated document, and the thing ADR-0010 points at. One hundred and forty-eight are specified behaviour. Thirteen are known limits recorded as what the gate actually does today, each with the verdict it should return, so the row is honest and the suite is green at the same time — and a limit that starts returning its wanted verdict fails as stale rather than lingering.

**Does not establish.** That the reader is correct, or that any other gate is specified at all. It is a heuristic over Markdown, and twelve of its thirteen known limits err toward rejecting a manifest an author intended — a visible FAIL somebody clears. Exactly one errs the other way, toward a silent PASS nobody sees, and that is the direction that ships defects. The total rose from five to twelve across the fifth and sixth sweeps, which recorded what they found rather than leaving it to be rediscovered; **the unsafe count has not moved across three sweeps**, which is the number that matters. The seventh sweep added twenty-six specified cases and no new limit — it found a regression rather than a gap, in delimiter code a previous sweep had just changed. The eighth turned to the USE side and the key token, where coverage was thinnest, and found no false clean at all: twenty-five specified cases and one inherited limit, a double-backtick code span the frozen linter mishandles identically. Nor is one gate one reader: the USE side is `stripDocumentationSpans`, a separate port with a different fence rule, and the two are reconciled by argument rather than by code — see ADR-0010. The other fifteen gates have tests but no specification: their behaviour is described in prose, which is the condition this artifact exists to escape from and has escaped for one gate only.

**Pinned:**

```json
{
  "cases": 161,
  "specified": 148,
  "known_limits": 13,
  "unsafe_limits": 1,
  "gate": "RUNTIME_KEY_UNDECLARED"
}
```

**Crossed when.** A second unsafe limit appears, or a limit is fixed without its row being retired. The first widens the silent-PASS surface; the second is the stale-entry failure the suite already checks for.

**Evidence:** `spec/manifest-shapes.json` · `core/test/manifest-spec.test.ts` · `Documentation/MANIFEST_SHAPES.md` · `Documentation/0010-runtime-manifest-extraction.md`

## The documentation describes a platform; the repository runs a slice

`documented-far-exceeds-built` · probe `builtSurface`

**Establishes.** A vertical slice that genuinely works: sixteen gates, eleven stages, six adapters, and a CLI that drives a full pipeline run. One of those adapters can reach a model without a credential or a budget — `provider-ollama` talks to a daemon on loopback — so the slice now includes a transport capable of producing evidence rather than only of degrading honestly. It cuts through every layer along the riskiest path in the design — a provider failure reaching a Core reduction and coming back out labelled — and `npm run verify` proves it in about ten seconds.

**Does not establish.** That the system in the 54 documentation files exists. Those were written target-state and in the present tense before any code existed, so a sentence saying the platform 'implements' something is a specification, not a report. The count moved from 44 to 53 on 2 September 2026, and the direction is the finding: all nine additions are further target-state planning documents for adapters, shells and type hardening that remain unbuilt, so the ratio this entry bounds got worse while no code moved. The count moved again from 53 to 54 on 3 September 2026 with ADR-0016 (mutation-derived judge calibration), which documents a deliberate divergence from the production guidance's expectation of human-labeled calibration data. Documentation growth here is not progress and must not be read as any. Two adapters of the five the documentation specifies are absent — `provider-hosted-server` and `storage-db` — and note that the built set and the target set are NOT the same set: `content-local`, `provider-ollama`, and `provider-hosted-judge` were built here and are in neither documented five, so six built against a target of five does not mean the target is met. `provider-hosted-judge` is not from this plan's phases at all — it is the first real transport for the separate brief-fidelity-judge sub-project — which is exactly the kind of addition this sentence exists to keep visible rather than let flatter the ratio. Reading those two numbers as a fraction is the mistake this sentence exists to prevent. Two Shells of four — `pipeline-ui` and `toolkit-ui` — have no code at all. `shells/api` counts as built as of 29 August 2026 (ADR-0012): it compiles, is typechecked with everything else, and its routes and socket seam are tested. It is also the newest and least exercised thing here, and it is the only part of the repository with runtime dependencies. What the two built Shells lack is presentation, not capability — both drive the full pipeline through the Application protocol — which is why the gap is stated as scope rather than as a shortfall.

**Pinned:**

```json
{
  "documentation_markdown_files": 54,
  "gates_built": 16,
  "stages_built": 11,
  "adapters_built": [
    "content-local",
    "evidence-local",
    "provider-hosted-judge",
    "provider-local-proxy",
    "provider-ollama",
    "storage-db",
    "storage-local"
  ],
  "adapters_target": 5,
  "shells_present": [
    "api",
    "cli"
  ],
  "shells_target": 3,
  "shells_excluded_from_typecheck": false
}
```

**Crossed when.** An adapter or shell lands, or a Shell stops being typechecked. `shells_excluded_from_typecheck` going true again would mean a Shell had been quarantined rather than owned, which is the state ADR-0012 ended — it lasted a week and took CI down with it.

**Evidence:** `Documentation/IMPLEMENTATION_PLAN.md` · `Documentation/GATES_REFERENCE.md` · `Documentation/SOURCE_VERIFICATION.md` · `tsconfig.json`

## The literature warrant has never been checked by anything but this machine

`corpus-is-a-local-assertion` · probe `corpusWarrant`

**Establishes.** 661 PDF files hashing to 599 unique documents — 62 are byte-identical duplicates — re-verified against a manifest in about two seconds by `npm run check:corpus`. The file count and the document count are both stated, which is how the earlier '673-paper corpus' was found to be neither.

**Does not establish.** That any reader can confirm it. `PDF/` is 2 GB of third-party papers whose canonical home is arXiv, so it is gitignored: no clean checkout has ever held it, CI has never run the check, and `check:corpus` is deliberately outside `npm run verify` because folding it in would make the headline command fail for every adopter. The corpus is the stated warrant for the measured results the evaluation ADR opens with, and that warrant is currently a local assertion. If the check ever reports missing files, the manifest must not be regenerated — that would silently accept the disappearance of the evidence base.

**Pinned:**

```json
{
  "files": 661,
  "unique_documents": 599,
  "byte_identical_duplicates": 62,
  "in_verify": false,
  "gitignored": true,
  "checkable_on_clean_checkout": false
}
```

**Crossed when.** The corpus becomes fetchable by a third party — a manifest of arXiv identifiers, a mirror, anything that lets someone else reproduce the hash. At that point the warrant stops being local and `in_verify` becomes a real question.

**Evidence:** `scripts/check-corpus.mjs` · `scripts/corpus-manifest.json` · `Documentation/LITERATURE_CORPUS.md` · `Documentation/0008-evaluation-first-environment.md`

## Core purity is enforced by two mechanisms, and neither covers the other

`core-purity-has-two-guards` · probe `purityGuards`

**Establishes.** The static boundary checker reads every file under `core/src` — whether or not a test exercises it — and forbids twenty effectful builtins outright. The runtime harness traps four ambient globals inside Core tests: `fetch`, `Math.random`, `Date.now`, and the argument-free `Date` constructor. Together they cover both the capability and the effect that arrives some other way.

**Does not establish.** That the runtime harness blocks the filesystem. It does not, and it cannot: Node copies a builtin's CJS exports into the ESM facade when the module is first evaluated, which happens while the test file's import graph loads — before any setup hook runs. Only `require("fs")` looks the property up per call, and no Core module uses it. Three separate places claimed this coverage, including that harness's own header, while `readFileSync` ran green inside a Core gate. Do not try to fix the harness; it was measured. The static check is also a regex over import specifiers — it does not resolve re-exports transitively and cannot see an effect passed in as a value at runtime, which is what ADR-0005 is for.

**Pinned:**

```json
{
  "runtime_traps": [
    "fetch()",
    "Math.random()",
    "Date.now()",
    "new Date()"
  ],
  "runtime_blocks_filesystem": false,
  "static_forbidden_builtins": 20,
  "static_reads_every_core_file": true,
  "guards": 2
}
```

**Crossed when.** A trap is added or removed, or the forbidden-builtin list changes. Either alters what 'Core is pure' is taken to mean, and the last time that drifted nobody noticed for months.

**Evidence:** `scripts/check-boundaries.mjs` · `core/test/purity.setup.ts` · `Documentation/0005-application-orchestration-boundary.md`

## Three reproducibility claims, of three different strengths

`three-reproducibility-claims` · probe `reproducibility`

**Establishes.** Three things reproduce here, and they are reported separately because they are not equally strong. (1) SAME INPUT, SAME VERDICTS: the gates are pure, denied every effectful builtin by a static check that reads every file under core/src, and 2,784 oracle verdicts agree with a SHA-256-pinned second implementation. (2) SAME SEED, SAME SUITE: the 4,906-case anchor regenerates from seed 1 and check:anchor fails if the committed file is not what the generator produces. (3) SAME SOURCE, SAME HASH: 90 artifact files digest to one hash, and content is normalised to LF first because core.autocrlf is true here — so the hash a Windows checkout computes is the hash a Linux checkout computes, which is the only version of the claim worth making. The count moved 84→86 across two commits that each added one runtime file — `core/src/eval/brief-fidelity.ts`, then `adapters/provider-hosted-judge/src/index.ts` — and sat wrong at 85 in between: the first addition should have moved it to 85 and did not, caught by neither that commit's implementer nor its reviewer, so the second inherited an already-stale base and landed on 85 instead of the true 86. A third commit, adding `core/src/eval/judge-calibration.ts`, repeated the identical mechanism rather than a new one: `npm run build:hash` was run before `git add`, so `git ls-files` still reported the pre-commit tree and the stale 86 was committed alongside a file that made the true count 87 — caught by review rather than by that commit's own author, and corrected in the commit after it. A fourth commit, adding `application/src/judge-bundle.ts`, staged the new file before hashing and moved the count cleanly to the true 88. A fifth commit, adding `core/src/eval/compare-graded.ts` (sub-project 4's paired-bootstrap comparator), staged the new file before hashing and moved the count cleanly to the true 89. A sixth commit, adding `application/src/judge-pilot.ts`, did the same and moved it to the true 90. The count drifted the same way three separate times before that, always because the hash was computed before the new file was staged, which is itself evidence that re-deriving the count is doing real work here rather than merely confirming what was already believed.

**Does not establish.** That this project has reproducible builds in the sense that phrase usually carries. NOTHING IS COMPILED. There is no bundle, no lockstep toolchain pin, no hermetic sandbox; tsx transpiles at run time, and the hash covers source text plus dependency pins rather than a produced binary. The three claims also have genuinely different strengths and must never be merged into one sentence: the first is enforced by a second implementation and a purity guard, the second by a regeneration check, the third only by a digest of files somebody could edit together. Collapsing them lets the weakest borrow the strongest's credibility, which is the specific move this document exists to prevent.

**Pinned:**

```json
{
  "artifact_files": 91,
  "hash_is_lf_normalised": true,
  "hash_excludes_tests_and_tooling": true,
  "hash_excludes_itself": true,
  "anchor_regenerates_from_seed": 1,
  "oracle_verdicts_agree": true,
  "build_is_compiled": false
}
```

**Crossed when.** A build step appears — a bundler, a compile, a published package. At that moment the third claim can become a real reproducible-build claim and should be restated as one, rather than continuing to mean 'the source files digest the same'. `build_is_compiled` going true is the signal, and it is the only one of the three whose meaning changes rather than whose number does.

**Evidence:** `scripts/build-hash.mjs` · `build-hash.json` · `scripts/check-boundaries.mjs` · `scripts/build-anchor.ts` · `scripts/differential.ts`

## No suite here can separate two models

`model-comparisons-are-unresolvable-here` · probe `noiseFloor`

**Establishes.** That the question has been asked precisely, and answered with a measurement. `check:noise` refuses a written claim of a difference smaller than the instrument can resolve, and `compare:models` reports refusals using the comparator's own exact clustered sign test rather than a second implementation. Both read committed files only, so they run in CI without a GPU. Armed on 1 September 2026 from a sweep of four local models, three trials each, on the twelve cases compile-smoke can honestly score under a real transport.

**Does not establish.** That any two of those models have been shown to differ, or to be the same. All six pairwise comparisons came back REFUSED: the largest discordance was 5 clusters of 12 against a Bonferroni-corrected floor of 8, so no arrangement of the signs could have reached significance. At the measured discordance rate of 0.2778, twelve cases resolve 42.6 percentage points; the largest gap between any two model means was 8.3. A refusal is not a null result — it says the instrument could not have seen a difference, not that there is none. Within-model spread reached 25.0 points on gpt-oss:20b, three times the gap between the best and worst model, so a single run cannot even establish what one model does. Seven of the twelve cases were constant across every model and cannot separate any pair. The measurement is also not reproducible: temperature is unpinned, the models are stochastic, and CI has no GPU. The brief-pilot suite (eval/brief-pilot.json, 100 cases, seed 1) was designed to reduce that constant fraction by using only model-sensitive case types, and was measured on 3 September 2026 against phi4-mini:latest and lfm2.5-thinking:latest (three trials each, pre-warmed to ensure thinking-mode activation). The result is inconclusive: Δ = 0.4 pp, p = 0.5716, 28 discordant clusters of 100. The pilot does not pay — by both criteria in the design spec: 72 of 100 generated cases are still constant across the two models (72 %, above the 58.3 % threshold), and the implied size for the observed Δ at the measured discordance rate of 0.28 is 137,356 cases, far above the 341-case baseline. The conclusion is that phi4-mini and lfm2.5-thinking (warm) score equivalently on this suite (69.3 % vs 69.7 %, spread 2–3 pp for each), and that concentrating cases on the four dimensions sub-project 1 found discriminating did not open a measurable gap for this pair. Sub-project 2 (provider-facing anchor) is not being built from this pilot's result.

**Pinned:**

```json
{
  "floor_measured": true,
  "models_measured": 4,
  "cases_scored": 12
}
```

**Crossed when.** Any of the three pinned values moves. `models_measured` changing means the floor now speaks for a different set of models and every claim checked against it needs re-reading; `cases_scored` changing means the suite itself changed and the floor is no longer comparable to the one it replaced. `floor_measured` going false would mean the artifact was deleted while claims pinned in scripts/noise-claims.json still stand — the gate silently disarming, which is the state it exists to make impossible.

**Evidence:** `scripts/check-noise.ts` · `scripts/noise-claims.json` · `scripts/compare-models.ts` · `scripts/noise-floor.ts` · `docs/superpowers/specs/2026-09-01-noise-floor-design.md` · `docs/superpowers/plans/2026-09-03-brief-pilot-findings.md`
