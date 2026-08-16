# Glossary

**Adapter** — an impure module implementing a Contract, swappable per deployment (e.g., `provider-local-proxy` vs. `provider-hosted-server`).

**Application / Orchestration** — the layer between Shells and Core that owns every live effect: it validates commands, invokes adapters, classifies failures, drives retries and the fallback ladder, persists revisions, and emits events. Core decides *what* should happen; the Application makes it happen (ADR-0005).

**Composition Root** — the single place where concrete adapters, sinks, and configuration are assembled into a running deployment. Contains no business logic.

**Contract** — a versioned JSON Schema defining the shape of data passed between layers. The only data definition Shells depend on.

**Core** — pure, dependency-free modules (gates, catalog, stages, diff, scorer) with no I/O, no clock, no randomness, and no framework imports. Core never receives a `generate()` function.

**Demo mode** (`demo_mode: true`) — a `PipelineStage` result produced without a live provider call, labeled `⟦WORKFLOW DEMO — no model⟧` rather than fabricated. A structural honesty mechanism, not a UI toggle.

**Gate** — one of the 17 pure functions in `core/gates/` that evaluates a prompt against a specific rule and returns a `GateResult`.

**Layer** — one of the architectural tiers: Shells, Application/Orchestration, Contracts, Core, Adapters, Composition Root, with Observability cutting across all of them.

**Run bundle** — every `RevisionEntry` sharing one `run_id`, retained or evicted as a unit. The local store's bound is eight run bundles, so a complete run is never half-retained regardless of stage count.

**Run ID (`run_id`)** — a unique identifier generated once per pipeline run and threaded through every stage decision, provider call, revision entry, and event, enabling full traceability.

**Shared presentation package** — UI code reused by more than one Shell, depending only on the Application protocol and contract types. How `toolkit-ui` reuses the pipeline experience without importing `pipeline-ui` (ADR-0006).

**Shell** — a replaceable, presentation-layer consumer of the Application protocol: `pipeline-ui`, `toolkit-ui`, or `cli`. There are exactly three.

**Stale (revision)** — a `RevisionEntry` with `freshness: STALE`, meaning an upstream output it derives from has changed since it was produced. Independent of `status`: a revision can have succeeded and still be stale. Excluded from exports by default until rerun.

**Technique record** — one entry in the 172-item catalog, carrying a provenance/source-verification flag.

**Contract test suite** — a single test file run against every implementation of an interface (e.g., both provider adapters) to assert behavioral parity.

**ADR (Architecture Decision Record)** — a document in `docs/adr/` recording a decision that constrains future work at a layer boundary, with its rationale, so it doesn't need rediscovering later.
