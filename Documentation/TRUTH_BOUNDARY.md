# The truth boundary

**Generated from `spec/truth-boundary.json`. Do not edit.**
`npm run docs:truth` writes it; `npm run check:truth` re-derives every pinned number
from the repository and fails when one has moved. It runs inside `npm run verify`.

Every other check in this repository asks whether a number is right. This one asks what
it is right *about*. A correct figure attached to an overreaching claim is the more
dangerous of the two, because a checker has already blessed it.

8 entries · spec version 1.0.0.

Each entry states a scope in two halves and pins the numbers that bound it. The
**Crossed when** line names the event that should make someone rewrite the claim —
that event is a failing build, not a note in a backlog.

---

## Nothing here has ever talked to a model

`no-model-has-answered` · probe `providerReach`

**Establishes.** The provider path runs end to end and degrades honestly. One eleven-stage run is persisted in this tree, and all eleven of its revision entries recorded a null model fingerprint: the pipeline executed, the provider was unreachable, and Core mapped the classified failure to a labelled demo placeholder rather than to text. The live path also refuses before it spends anything — a key of the wrong shape is rejected up front instead of being discovered case by case.

**Does not establish.** Any claim whatsoever about how a language model behaves. Every evaluation figure this repository reports — the anchor's 4,906 cases, each smoke suite, every gate recall number — was produced by the pinned stub. They are evidence about this system's accounting, not about a model's output. No prompt-engineering advice in the documentation set has been measured here, and the fingerprint watch is empty because there has been nothing to watch.

**Pinned:**

```json
{
  "any_fingerprint_observed": false,
  "fingerprints_pinned": 0,
  "run_bundles_are_gitignored": true,
  "placeholder_key_refused": true,
  "real_shaped_key_accepted": true
}
```

**Crossed when.** The first provider answers. `any_fingerprint_observed` goes true, and from that moment the repository holds evidence about a model — which means every sentence in the documentation that currently says 'stubbed' or 'never executed' needs re-reading, and the first fingerprint needs pinning deliberately rather than appending a string.

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

**Does not establish.** Anything, in the case of the three smoke suites. `pipeline-smoke` holds five cases and is below the exact floor outright: no arrangement of its results could reach significance. The other two clear six only in the sense that their SIZE does — the floor is on discordant units, of which a suite's size is merely an upper bound, so eleven or fourteen cases still resolve nothing in practice. These suites exist to prove the wiring runs and the accounting adds up. A green run is not evidence that a configuration is better.

**Pinned:**

```json
{
  "exact_floor_discordant_units": 6,
  "anchor_cases": 4906,
  "anchor_detectable_delta": 0.000204,
  "smoke_suite_sizes": {
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

**Establishes.** `RUNTIME_KEY_UNDECLARED` reads a runtime manifest according to 83 cases that are simultaneously the test, the generated document, and the thing ADR-0010 points at. Seventy-two are specified behaviour. Eleven are known limits recorded as what the gate actually does today, each with the verdict it should return, so the row is honest and the suite is green at the same time — and a limit that starts returning its wanted verdict fails as stale rather than lingering.

**Does not establish.** That the reader is correct, or that any other gate is specified at all. It is a heuristic over Markdown, and ten of its eleven known limits err toward rejecting a manifest an author intended — a visible FAIL somebody clears. Exactly one errs the other way, toward a silent PASS nobody sees, and that is the direction that ships defects. The count rose from five to eleven when a fifth adversarial sweep recorded six shapes it found rather than leaving them to be rediscovered; the unsafe count did not move, which is the number that matters. The other fifteen gates have tests but no specification: their behaviour is described in prose, which is the condition this artifact exists to escape from and has escaped for one gate only.

**Pinned:**

```json
{
  "cases": 83,
  "specified": 72,
  "known_limits": 11,
  "unsafe_limits": 1,
  "gate": "RUNTIME_KEY_UNDECLARED"
}
```

**Crossed when.** A second unsafe limit appears, or a limit is fixed without its row being retired. The first widens the silent-PASS surface; the second is the stale-entry failure the suite already checks for.

**Evidence:** `spec/manifest-shapes.json` · `core/test/manifest-spec.test.ts` · `Documentation/MANIFEST_SHAPES.md` · `Documentation/0010-runtime-manifest-extraction.md`

## The documentation describes a platform; the repository runs a slice

`documented-far-exceeds-built` · probe `builtSurface`

**Establishes.** A vertical slice that genuinely works: sixteen gates, eleven stages, three adapters, and a CLI that drives a full pipeline run. It cuts through every layer along the riskiest path in the design — a provider failure reaching a Core reduction and coming back out labelled — and `npm run verify` proves it in about ten seconds.

**Does not establish.** That the system in the 36 documentation files exists. Those were written target-state and in the present tense before any code existed, so a sentence saying the platform 'implements' something is a specification, not a report. Two adapters of five are absent, and of the two shell directories present one is `shells/api` — it does not compile, has no tests, depends on four uninstalled packages, and is excluded from typecheck. Counting it as a shell would read as two-of-three progress toward something nobody owns.

**Pinned:**

```json
{
  "documentation_markdown_files": 36,
  "gates_built": 16,
  "stages_built": 11,
  "adapters_built": [
    "evidence-local",
    "provider-local-proxy",
    "storage-local"
  ],
  "adapters_target": 5,
  "shells_present": [
    "api",
    "cli"
  ],
  "shells_target": 3,
  "shells_excluded_from_typecheck": true
}
```

**Crossed when.** An adapter or shell lands, or `shells/api` is either fixed or deleted. Each moves the built surface, and each should move the documents that describe it in the same commit rather than a later one.

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
