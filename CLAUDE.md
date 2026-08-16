# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this directory actually is

Mostly documentation, plus **one vertical slice that really runs**. It holds:

- `Documentation/` — 26 Markdown files describing the *target* architecture of the PromptNexus Unified Platform, plus three review documents assessing it. This is still the bulk of the repository, and it still describes a system far larger than what exists.
- `sources/` — 420 files extracted from five archives, frozen and SHA-256-verified against `sources/MANIFEST.json`. Read from these; never write into them.
- A working slice: `contracts/`, `core/` (2 of 16 gates, one pipeline stage), `application/`, `adapters/provider-local-proxy`, `adapters/storage-local`, `shells/cli`, `scripts/`, `test/`.
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

## Documentation conventions

- **Contract-first is a rule, not an aspiration.** A schema change lands as its own reviewed PR with a version bump and changelog entry, before any code implementing it.
- **ADRs are amended, not rewritten.** `0005` amends `0001`; `0006` amends `0004`. The original text stays; the Status line points forward. Where an ADR and `ARCHITECTURE.md` disagree about current shape, **`ARCHITECTURE.md` is authoritative**.
- **`CAPABILITY_MATRIX.md` asserts nothing.** Its generator is unbuilt. The file is explicitly labeled illustrative; never cite it as evidence a capability exists.
- Start from `Documentation/README.md` — it carries the reading order, the ADR index, and the current open items.

## Known-unresolved items

Treat these as open questions, not as things to quietly fix or invent answers for:

1. **`IMPLEMENTATION_PLAN.md` does not exist.** Roughly six documents were written against it. Direct citations have been made self-contained, but the plan itself — phases, exit gates, risk register — is unwritten. It was being designed when this file was created: solo execution, phases derived fresh from the dependency graph, port-and-verify rather than greenfield.
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
| `npm test` | Vitest: projects `core`, `application`, `adapters`, `contracts`. |
| `npm run differential` | The oracle — ported gates vs. the frozen Python linter. Needs Python. |
| `npm run cli` | `promptnexus lint\|run\|gates`. |

**These are target state and do not exist:** `npm run verify:gates`, `npm run adversarial`, `npm run trace:view`, `docs:matrix`, `verify:hash`, `scaffold:gate`, `scaffold:technique`. Treat them as unbuilt, not as scripts to restore.

**There is no CI service** — no `.github/`, no pipeline. Documents describing "CI stages" describe intent. The intended order is meaningful and `npm run verify` follows it: boundaries and schema validation first, then Core tests, then Application, adapters, cross-shell parity, adversarial corpus, build-hash reproducibility last.

## Two guards, and what each one actually covers

Core purity is enforced by two mechanisms, and conflating them is how the codebase spent a while believing it was checking something it was not:

- **`scripts/check-boundaries.mjs`** — the filesystem/network guard. `core/src/**` may not import `node:fs` or any other effectful builtin at all. Reads every file, so it does not depend on test coverage.
- **`core/test/purity.setup.ts`** — traps `fetch`, `Math.random`, `Date.now`, and `new Date()`. **It does not block the filesystem**, and cannot: Node snapshots a builtin's ESM exports when the module is first evaluated, so patching `node:fs` afterwards changes an object nothing reads. Only `require("fs")` is interceptable, and no Core module uses it.

Do not "fix" the harness to block fs. It was tried, measured, and documented in the file's header.
