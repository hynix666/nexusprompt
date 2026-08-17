# PromptNexus Unified Platform — Documentation

This is the documentation set for the merged system: one pure Core (16-gate linter, 172-technique catalog, 11-stage pipeline decision logic) behind an Application/Orchestration layer that owns every live effect, served by two provider adapters, two storage adapters, and three Shells (pipeline UI, toolkit UI, CLI). Contracts are versioned JSON Schemas and are the sole cross-boundary interface.

Every count and file name above has been checked against the source artifacts — see [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md) for the evidence and for the ten claims that did not survive that check.

## Reading order

**New contributors**, in order:
1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the layer model, effect ownership, and why it exists
2. [`CONTRACTS.md`](./CONTRACTS.md) — the schemas everything else depends on
3. [`DEVELOPMENT_AND_TESTING.md`](./DEVELOPMENT_AND_TESTING.md) — local setup, test strategy
4. [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how a change gets from idea to merged

**Operators / deployers**, in order:
1. [`PROVIDERS.md`](./PROVIDERS.md) — choosing local-proxy vs. hosted-server
2. [`PRIVACY_AND_SECURITY.md`](./PRIVACY_AND_SECURITY.md)
3. [`RELEASE_OPERATIONS.md`](./RELEASE_OPERATIONS.md) — build, stamp, ship, rollback

**End users:**
1. [`USER_GUIDE.md`](./USER_GUIDE.md)
2. [`REVISIONS_AND_EXPORTS.md`](./REVISIONS_AND_EXPORTS.md)

**Reference:**
- [`GATES_REFERENCE.md`](./GATES_REFERENCE.md) — all 16 lint gates, each named with verdict semantics
- [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md) — every claim about the prior artifacts, checked against them
- [`LITERATURE_CORPUS.md`](./LITERATURE_CORPUS.md) — a 44-paper prompt-engineering corpus read against the project: what was verified, what was filed by title only, and what it does not establish
- [`CATALOG.md`](./CATALOG.md) — the technique catalog
- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — tracing and the event spine
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — phases, entry conditions, exit gates, risk register. Its numbers are verified by `npm run check:plan`
- [`CAPABILITY_MATRIX.md`](./CAPABILITY_MATRIX.md) — **illustrative only**; the generator is Phase 7 work and does not exist yet
- [`GLOSSARY.md`](./GLOSSARY.md)

## Architecture decision records

| ADR | Decision | Status |
|---|---|---|
| [0001](./0001-five-layer-architecture.md) | Layered architecture, CI-enforced dependency rule | Accepted — amended by 0005 |
| [0002](./0002-contract-first-design.md) | Contract-first, schema-before-implementation | Accepted |
| [0003](./0003-dual-provider-adapters.md) | Dual provider adapters (local-proxy, hosted-server) | Accepted |
| [0004](./0004-dual-shell-strategy.md) | Dual Shell strategy (pipeline-ui, toolkit-ui, cli) | Accepted — amended by 0006 |
| [0005](./0005-application-orchestration-boundary.md) | Application/Orchestration boundary and Composition Root; pure Core | Accepted — amends 0001 |
| [0006](./0006-shell-composition-and-shared-ui.md) | Shared presentation packages; `CI-bot` removed from the Shell inventory | Accepted — amends 0004 |
| [0007](./0007-permanent-differential-oracle.md) | The differential oracle is permanent, not migration scaffolding | Accepted |

An amended ADR stays in force except where its amendment supersedes it; the amendment states which parts. Where an ADR and `ARCHITECTURE.md` disagree on current shape, `ARCHITECTURE.md` is authoritative.

## Source lineage

This documentation set describes the target state of a system merged from four prior artifacts. Where a mechanism is inherited from one of them, the doc says so explicitly rather than presenting it as invented fresh — this matters for anyone auditing why a given design choice was made.

| Prior artifact | What it contributed |
|---|---|
| v5 spec/linter | The lint engine (15 gates, 16 in its latest revision), the adversarial corpus and scorer, the stdlib proxy and its 27-assertion security suite, the `⟦WORKFLOW DEMO⟧` honesty convention, and `check_versions.py` build-hash stamping |
| GitHub multi-user product | Server-side provider key custody, typed provider health/error handling, MySQL migration and multi-user setup |
| Final-package pipeline UI | 11-stage pipeline UX with full stage templates, exports, revision audit, stale-invalidation |
| filesZ toolkit + catalog | 172-technique catalog with XSD, four export formats, byte-reproducible PDF rendering, and the `promptnexus_hygiene` CI toolchain |

**The sources are still moving.** The latest linter, `fixtures.json`, and `PromptNexus.jsx` are in `files_4.zip`; the latest pipeline component (eleven stages) is in `files_3.zip`. Neither is in this directory, and the newest copy of each lineage is what should be ported. Two attributions in earlier drafts were also wrong: the demo-mode convention and the proxy security model both originate in v5, not filesZ.

## Status

This documentation describes the **target architecture**. Nothing in this set should be read as "already shipped."

### What is actually built

A vertical slice — one stage end to end — plus the machinery that checks it. This section exists because the doc set is written in the present tense and code now exists to contradict it; an audit found `GATES_REFERENCE.md` asserting sixteen implemented gates against a repository holding two.

| Area | Built | Target |
|---|---|---|
| Lint gates | 2 (`SECRET_LEAK_SCAN`, `CLAIM_DISCIPLINE`) | 16 |
| Pipeline stages | 1 (`compile`) | 11 |
| Contracts | 5 schemas, each validated against a real produced value | full inventory in `CONTRACTS.md` |
| Provider adapters | `local-proxy` | + `hosted-server` |
| Storage adapters | `storage-local` (run bundles) | + `storage-db` |
| Shells | `cli` | + `pipeline-ui`, `toolkit-ui` |
| Technique catalog | none | 172 records |
| CI | none — `npm run verify` runs locally | full pipeline |

Verified by: `npm run verify` (boundaries → typecheck → source freeze → 111 tests → differential oracle against the frozen linter).

Two caveats matter when reading it:

- **`IMPLEMENTATION_PLAN.md` now exists**, and phase numbers in this set refer to it. Documents written against the old numbering cited "Phase 5" for the capability-matrix generator; that work is **Phase 7 — Release truth**, and the citations have been updated. Two review documents keep the old numbering deliberately, because they are records of an assessment made at a point in time.
- **`CAPABILITY_MATRIX.md` asserts nothing.** Its generator is Phase 7 work. The file shows the expected shape of generated output and is explicitly not a capability claim.
- **Ten claims about the source artifacts were wrong** and have been corrected against the archives. The gate count, the security-assertion count, the `TechniqueRecord` shape, the database engine, and both scaffolding generators were all inaccurate; `storage-db`'s revision persistence turns out to be new work rather than a port. [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md) is the evidence, and it is worth reading before trusting any remaining count in this set.
- **The nineteen target properties are fifteen.** Searched for and not found in any archive; the count has been corrected rather than padded.

The documentation set was reconciled following an architecture review that raised fourteen findings, the three most serious being that Core could not be pure while invoking an injected `generate()`, that Shells could not depend only on Contracts while calling Core and embedding one another, and that the contract inventory was incomplete and partly TypeScript-specific. Those are closed in the current text — by ADR-0005, ADR-0006, and the expanded schema inventory in `CONTRACTS.md` respectively. The remaining open items are the two above, both of which are work, not wording.
