# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this directory actually is

**The product is NexusPrompt.** The `promptnexus` name survives in contract `$id` hosts and under `sources/` on purpose — see ADR-0009. Do not "fix" it with a global replace: `sources/` is frozen and `verify:sources` will fail, and renaming a `$id` is a major version bump per schema.

Mostly documentation, plus **one vertical slice that really runs**. It holds:

- `Documentation/` — 34 Markdown files describing the *target* architecture of the platform, plus three review documents assessing it. This is still the bulk of the repository, and it still describes a system far larger than what exists.
- `sources/` — 420 files extracted from five archives, frozen and SHA-256-verified against `sources/MANIFEST.json`. Read from these; never write into them.
- A working slice: `contracts/`, `core/` (16 of 16 gates, 11 pipeline stages), `application/`, `adapters/provider-local-proxy`, `adapters/storage-local`, `adapters/evidence-local`, `shells/cli`, `scripts/`, `test/`.
- `LLM/` — an 811 MB int4 ONNX model and tokenizer, gitignored. **Not wired to anything, and not wire-able as dropped**: it is an ONNX Runtime GenAI export missing `genai_config.json`, so the architecture parameters needed to drive generation are absent. Do not guess them — a wrong value produces fluent garbage, which is the one failure demo mode exists to make impossible.
- Four source archives (still zipped) and `SystemPromptBuilderPipeline.tsx`, loose on disk. **That copy is stale** (nine stages); the current one is inside `~/Downloads/Compressed/files_3.zip` and has eleven.

`npm install && npm run verify` works and takes about ten seconds. **Use `npm`, not `pnpm`** — pnpm is not installed and the workspace is defined with npm workspaces, though much of the documentation still says `pnpm`.

**Read `Documentation/GATES_REFERENCE.md`'s status block before assuming a gate exists.** The documentation was written target-state, in the present tense, before any code existed. Where a document says the system "implements" something, check.

## The archives (the actual source material)

The documentation's "source lineage" table maps to these files. Read from them; do not write into them.

| Archive | Prior artifact | What's inside that matters |
|---|---|---|
| `Prompt-Nexus.zip` | v5 spec/linter | `promptnexus-v5/prompt_lint.py`, `framework_v5_7_0_core.md`, `fixtures.json`, `differential.mjs`, `REVIEW-promptnexus-v6.md` |
| `systempromptbuilder.zip` | GitHub multi-user product | `server/hostedProviders.ts` + its tests, `drizzle/schema.ts`, `server/storage.ts`, `server/referenceContext.ts`; includes a `.git/` directory |
| `System-Prompt-Builder-final-*.zip` | final-package pipeline UI | `client/`, `server/`, and a `docs/` tree that is the **direct ancestor of `Documentation/`** — compare when tracing why a doc says what it says |
| `PromptNexus-6.2.zip` | v6.2 hardened spec + statistical validation | `promptnexus_v6_hardened_specification.md`, `STATISTICAL_VALIDATION_REPORT.md`, `check_gonogo.py`, `ledger.yaml`, `ci.yml`. **Targets a different deployment** — Kafka topics, a Rust orchestrator, DAPH stage schemas — so most of it does not apply here. Two parts do: its MDE table lists **9,812** items for a two-point effect and **4,802** at its own MDE, which are the figures `check:sizing` prints, reached independently from an unpaired two-group framing. Its Blocker 2 fix — never report `DECORATIVE_CONFIRMED`, only `DECORATIVE_BELOW_DETECTION` — is the same distinction the comparator's attainability refusal makes. |
| `filesZ.zip` | filesZ toolkit + catalog | `catalog.js`, `PromptNexus.jsx`, `test_app_scope.py`, plus two nested tarballs: `promptnexus-v5.tar.gz` and `promptnexus-catalog-v1.20.0-ci-complete.tar.gz` (the 172-record catalog and its CI tooling) |

**The newest copy of each artifact is outside this directory.** `~/Downloads/Compressed/files_4.zip` holds the latest `prompt_lint.py` (16 gates), `fixtures.json`, and `PromptNexus.jsx`. `~/Downloads/Compressed/files_3.zip` holds the latest pipeline component — **eleven** stages, adding `Cost Estimate` and `Tone Check` — plus a `System-Prompt-Builder-updated.zip` whose `docs/` never mention either new stage. Check mtimes and compare drops before trusting any count.

`Documentation/SOURCE_VERIFICATION.md` records every claim this doc set makes about these artifacts, checked against them. Ten were wrong — including the gate count, the security-assertion count, the `TechniqueRecord` shape, and the database engine. **Read it before trusting a count in any other document**, and verify against the archive before adding a new one.

## Architecture: the parts that require reading several files

The layer stack, in dependency order. Effect ownership is the load-bearing idea:

```
Shells (pipeline-ui, toolkit-ui, cli)  →  call the Application protocol only
Application / Orchestration            →  owns ALL live effects
Contracts (versioned JSON Schemas)     →  the sole cross-boundary interface
Core (gates, catalog, stages, diff)    →  pure; no I/O, clock, or randomness
Adapters (provider ×2, storage ×2)     →  impure, swappable per deployment
Composition Root                       →  wiring only, no logic
```

**The single most important invariant, and the one most easily broken:** Core never performs or receives an effect. It does not take a `generate()` callback. A pipeline stage in Core *returns* a `GenerationRequest`; the Application layer executes it, classifies the outcome into a `GenerationResult` or a typed `ProviderFailure`, then calls Core again to *reduce* that classified outcome into the next state. Decide → invoke → reduce. If a proposed Core function needs a callback to finish its job, it belongs in the Application layer. See `Documentation/0005-application-orchestration-boundary.md`.

Consequences worth knowing before proposing changes:

- **Demo mode is a two-part mechanism.** The Application classifies a provider failure; Core deterministically maps the classified failure to a `⟦WORKFLOW DEMO — no model⟧` placeholder. This is a structural honesty guarantee — output is never fabricated when a provider is unreachable — and the `CLAIM_DISCIPLINE` gate enforces that demo output never presents itself as live.
- **Shells never import each other.** `toolkit-ui` reuses the pipeline experience through a shared presentation package, not by importing `pipeline-ui`. This is what makes per-Shell rollback true. See `0006-shell-composition-and-shared-ui.md`.
- **Local storage retains run bundles, not entries.** Eight complete runs, kept or evicted whole. The source's entry-based cap of 8 could not hold a nine-stage run, and the pipeline has since grown to eleven — any entry-based bound is a hostage to stage count.
- **`freshness` and `status` on a `RevisionEntry` are independent.** A revision can be `SUCCEEDED` and `STALE` simultaneously.
- **Observability carries keyed hashes only.** No prompt bodies, ever — the sink rejects rather than truncates. Fingerprints are keyed because bare digests of short prompts are correlatable.
- **`resolution.detectable_delta` is score granularity — `1/n` — not statistical resolution.** These are different floors and both are enforced. Granularity is declared on the suite and pinned by `check:sizing`; the statistical floor is *derived* by the comparator and never declared, because a declared one is exactly the number that drifted. The schema conflated them until `eval-suite` 2.0.1.
- **Six discordant units is a hard floor, not a heuristic.** Under McNemar the statistic is binomial(d, 0.5), so `2·0.5^d` is the smallest two-sided p any arrangement can produce; five units bottom out at 0.0625. A suite below the floor gets `refused`, not `inconclusive` — "we could not have seen anything" and "we looked and saw nothing" must not collapse into one verdict. Multiplicity correction raises the floor, and can raise it past the suite's size.
- **Two suite kinds, two runners, and neither may run the other's.** A pipeline case carries a `brief` and per-stage `stubs`; a single-stage case carries one `stub`. `isPipelineCase` is the one predicate both runners use, because a gap between two answers is where a suite gets silently accepted by the wrong one — `eval --suite eval/pipeline-smoke.json` used to report **5/5 and 5 provider calls** for five cases that each describe an eleven-stage run, with the per-stage stubs ignored and every `demo_mode`-conditional detector passing vacuously.
- **`runSuite` takes an optional `provider`, and the default is the stub.** That default is load-bearing: an `EvalRun` is recomputable from stored artifacts only while nothing in it reached the network. `provenance.provider` records which transport answered (`pinned-stub` vs `local-proxy`), which is the only thing distinguishing a run that is evidence about a model from one that is evidence about the accounting. `npm run eval -- --live` composes the real adapter; it refuses up front when `ANTHROPIC_API_KEY` is unset rather than degrading every case.
- **The usage recorder sits INSIDE the cache, not outside it.** `CachingProvider` returns a hit without touching what it wraps, so a hit must not count as a provider call — outside, `provider_calls` would measure the suite's size rather than what it cost, and that is the number the budget is enforced against.
- **The anchor's ground truth is derived, never authored.** `variant_stubs` is how the smoke suites express a second configuration, which means their outcomes are chosen by whoever wrote the fixture — fine at fourteen cases, fatal at anchor size. `core/src/eval/anchor.ts` instead injects a fragment and keeps the case only when **exactly one** previously-silent gate starts firing; that gate is the label. Do not "simplify" this by labelling fragments by hand: context decides, and this corpus contains a citation that silences both citation gates and a secret that stops being a finding inside a fence.
- **The anchor compares two sets that PARTITION the registry, not a set against a subset of itself.** A subset can never catch more than its superset, so a nested comparison tests a null that is known false before any case is scored.
- **Sizing an anchor takes three arguments, not one.** `requiredAnchorSize` (deprecated, kept because three documents cite its ≈3,400) pins a one-sided z, 50% power, and a 50% discordance rate, and states none of them; the honest figure at 80% power is ≈9,800. Use `requiredPairedSize(delta, {alpha, power, discordanceRate})`.
- **Promotion is a label repoint, so rollback is one too.** Same record, `kind: "rollback"`, carrying the pointers of the promotion it reverses. Rollback re-evaluates no conditions on purpose: a bad promotion must be undoable without first producing the evidence that would have prevented it.
- **The evidence plane has no `update`, and that is load-bearing.** It is why `Baseline.supersedes` points *forward* from the new record (1.0.0's backward `superseded_by` could never be written), and why "what is current?" is a query over the promotion list rather than a stored pointer.

## Documentation conventions

- **Contract-first is a rule, not an aspiration.** A schema change lands as its own reviewed PR with a version bump and changelog entry, before any code implementing it.
- **ADRs are amended, not rewritten.** `0005` amends `0001`; `0006` amends `0004`. The original text stays; the Status line points forward. Where an ADR and `ARCHITECTURE.md` disagree about current shape, **`ARCHITECTURE.md` is authoritative**.
- **`CAPABILITY_MATRIX.md` is generated — do not hand-edit it.** `npm run docs:matrix` writes it and `npm run check:matrix` fails the build when the committed file is not what the repository produces. It derives coverage by reading which validators `test/contract-conformance.test.ts` actually exercises, so it cannot claim more than the suite provides. It has no `Producers`/`Consumers` columns on purpose: nothing writes a registration record, and the hand-written version got exactly those wrong.
- Start from `Documentation/README.md` — it carries the reading order, the ADR index, and the current open items.

## Known-unresolved items

Treat these as open questions, not as things to quietly fix or invent answers for:

1. **The port is complete: all sixteen gates are ported and compared.** ADR-0007's divergence allowlist exists as of 18 August 2026 — `scripts/divergence-allowlist.json`, enforced by `scripts/differential.ts`. A port that deliberately fixes a source defect declares the difference with a reason and an ADR instead of choosing between reproducing the bug and deleting the oracle.

   It holds **three entries as of 25 August 2026**, all from the SPB defect-parity audit. Two are ADR-0010 (the runtime manifest was a span to end-of-file, so a *use* declared itself and the gate returned PASS on undeclared keys — the same defect `extractSourceLedgerIds` already carries a fix for); one is ADR-0011 (`QUTM_CEILING` divided a compiled prompt by the one-line brief it came from, so no compliant artifact could clear it). Do **not** add the `CLAIM_DISCIPLINE` / `guarantee-free` case ADR-0007 names as a candidate: the source shares that false positive, so there is no divergence, and the entry would fail the stale rule immediately.

   Entries carry their demonstration inline (fixtures are frozen and cannot take new cases; generated case ids move with `--n`), and pin **both** verdicts, so a change in the shape of a divergence is a new decision. `also_matches` broadens one entry across a systematic difference; `only_when_options` **narrows** it to cases whose options satisfy a constraint. Reach for the second whenever a divergence is option-shaped rather than input-shaped — a blanket `also_matches: ".*"` on QUTM would have excused the `qutm-ceiling-crossing` boundary case, which is the only shape in which half-up rounding is observable at all.

   ~~Still open and larger than it looks: **there is no git remote.**~~ **Closed 23 August 2026** — `origin` is `git@github.com:hynix666/nexusprompt.git` (private), and `.github/workflows/verify.yml` ran green on its first push. Phase 7 is unblocked.
2. **The "nineteen target properties" are fifteen.** Searched for across every archive including the v5 framework document; no enumeration of nineteen exists. The count is corrected in `ARCHITECTURE.md`. Do not invent four to make the arithmetic work.
3. **`storage-db` revision persistence is new work, not a port.** The inherited Drizzle schema (MySQL) has `users` and `promptAssets` and no revisions table. The revision schema needs designing and should land as a reviewed migration before either storage adapter is built.
4. **Neither scaffolding generator exists.** `scripts/new-gate.ts` and `scripts/new-technique.py` were never written. Build them or write gate/technique files by hand — but don't tell contributors to use them.

## Commands

**These run:**

| Command | What it does |
|---|---|
| `npm run verify` | boundaries → typecheck → source freeze → tests → differential oracle. The whole check, ~10s. |
| `npm run lint:boundaries` | Import-boundary rule (`scripts/check-boundaries.mjs`). |
| `npm run verify:sources` | Re-hashes all 420 frozen files against `MANIFEST.json`. |
| `npm test` | Vitest: projects `core`, `application`, `adapters`, `shells`, `contracts`. |
| `npm run check:corpus` | Re-hashes all 661 PDFs under `PDF/` against `scripts/corpus-manifest.json` and prints the deduplicated count. ~1.4s. |
| `npm run check:counts` | Re-derives every pinned number in the docs from the repo. Caught 15 wrong counts across 6 files on its first run. |
| `npm run build:anchor` | Regenerates `eval/gate-recall-anchor.json` — 4,906 cases from seed 1. |
| `npm run check:anchor` | Fails when the committed anchor is not what the generator produces. |
| `npm run eval:anchor` | Runs the anchor through `compare()`. ~3 s. |
| `npm run eval:pipeline` | Runs the eleven-stage pipeline against `eval/pipeline-smoke.json`. The single-stage `eval` runner **refuses** a pipeline suite — it used to run one and report 5/5. |
| `npm run check:sizing` | What each suite can actually resolve. Fails when a suite's `detectable_delta` drifts from `1/n`, when an `anchor` cannot attain significance, or when a suite below the exact floor is not acknowledged. Prints the anchor-sizing decomposition. |
| `npm run docs:matrix` | Regenerates `Documentation/CAPABILITY_MATRIX.md` from the tree. |
| `npm run check:matrix` | Fails when the committed matrix is not what the repository produces. |
| `npm run check:fingerprint` | Watches for the provider swapping the model under you. Reports "not armed" until a run reaches a provider. |
| `npm run differential` | The oracle — ported gates vs. the frozen Python linter. Needs Python. |
| `npm run cli` | `promptnexus lint\|run\|gates`. |

**These are target state and do not exist:** `npm run verify:gates`, `npm run adversarial`, `npm run trace:view`, `verify:hash`, `scaffold:gate`, `scaffold:technique`. Treat them as unbuilt, not as scripts to restore.

**`check:corpus` is green and deliberately outside `verify`.** All 661 files are at `PDF/`, re-hashed against `scripts/corpus-manifest.json` in about two seconds. It sits outside `verify` because `PDF/` is gitignored — 2 GB of third-party papers whose canonical home is arXiv — so a clean checkout has never had it, and folding the check into `verify` would make the headline command fail for every adopter. If it ever reports missing files, do **not** regenerate the manifest with `--write`: that silently accepts the disappearance of the evidence base. Find the corpus instead.

**CI runs `npm run verify` on every push and pull request** (`.github/workflows/verify.yml`), first executed 23 August 2026 and green. The stage order is meaningful and `verify` follows it: boundaries and schema validation first, then Core tests, then Application, adapters, cross-shell parity, adversarial corpus, reproducibility last. **`check:corpus` is deliberately outside `verify`** — it re-hashes 2 GB of gitignored PDFs, so it can never pass on a clean checkout; it is a local-asset check with its own command. Older documents saying "there is no CI" predate this.

## Two guards, and what each one actually covers

Core purity is enforced by two mechanisms, and conflating them is how the codebase spent a while believing it was checking something it was not:

- **`scripts/check-boundaries.mjs`** — the filesystem/network guard. `core/src/**` may not import `node:fs` or any other effectful builtin at all. Reads every file, so it does not depend on test coverage.
- **`core/test/purity.setup.ts`** — traps `fetch`, `Math.random`, `Date.now`, and `new Date()`. **It does not block the filesystem**, and cannot: Node snapshots a builtin's ESM exports when the module is first evaluated, so patching `node:fs` afterwards changes an object nothing reads. Only `require("fs")` is interceptable, and no Core module uses it.

Do not "fix" the harness to block fs. It was tried, measured, and documented in the file's header.
