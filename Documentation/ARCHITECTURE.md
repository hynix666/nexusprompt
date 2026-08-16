# Architecture

## Overview

The PromptNexus Unified Platform is organized as a strict layered system with an explicit Application/Orchestration boundary. The design preserves the original goals of drift elimination, dual deployment shapes, dual Shells, contract-first universality, and model-output honesty, while making runtime effects, dependency rules, and protocol ownership unambiguous.

## Layered model

```
┌─────────────────────────────────────────────────────────────┐
│  SHELLS / shared presentation packages / CLI / CI integration │
│  pipeline-ui · toolkit-ui · cli                               │
│  Depend only on the Application protocol + shared UI packages │
├─────────────────────────────────────────────────────────────┤
│  APPLICATION / ORCHESTRATION                                  │
│  Validates commands · composes pure Core logic                │
│  Invokes adapters · classifies failures · drives fallback     │
│  Emits safe events · persists revisions · owns all live effects│
├─────────────────────────────────────────────────────────────┤
│  CONTRACTS (versioned JSON Schemas — the sole cross-boundary  │
│  interface)                                                   │
│  GateResult · TechniqueRecord · GenerationRequest/Result      │
│  ProviderFailure/Health · PipelineCommand/Outcome             │
│  RevisionEntry · RevisionStore · ObservabilityEvent           │
│  CapabilityRegistration                                       │
├─────────────────────────────────────────────────────────────┤
│  CORE (pure, deterministic, no I/O, no clock, no randomness)  │
│  gates/ · catalog/ · stages/ (decision & reduction logic)     │
│  diff/ · scorer/                                              │
│  Produces action plans, GateResults, and deterministic outcomes│
├─────────────────────────────────────────────────────────────┤
│  ADAPTERS (impure, swappable per deployment)                  │
│  provider: {local-proxy | hosted-server}                      │
│  storage:  {local | db}                                       │
│  observability sinks: {stdout/json-lines | OpenTelemetry}     │
├─────────────────────────────────────────────────────────────┤
│  COMPOSITION ROOT (deployment wiring only)                    │
│  The single place where concrete adapters, sinks, and config  │
│  are assembled. Contains no business logic.                   │
└─────────────────────────────────────────────────────────────┘
```

Observability remains a cross-cutting concern. Every layer may emit events through a thin, non-blocking port supplied by the Application layer; the sink itself is an adapter. Prompt bodies never appear in events—only hashes and approved metadata.

## Dependency rules (CI-enforced)

Dependencies point strictly downward or through declared ports. The rules are enforced by ESLint `no-restricted-imports` (and equivalent checks for non-TypeScript packages) and fail CI on violation.

| Boundary                  | May depend on                                      | Must not depend on                                      |
|---------------------------|----------------------------------------------------|---------------------------------------------------------|
| Shell                     | Application protocol, shared presentation packages, contract-generated types | Core internals, adapter implementations, other Shell internals |
| Application/Orchestration | Core, contract schemas, abstract adapter ports     | Concrete adapter implementation details (except at the composition root) |
| Core                      | Contract value types and pure deterministic utilities only | Network, filesystem, clock, randomness, event sinks, provider APIs, adapters, Shells |
| Adapter                   | Contract schemas, external libraries required for its transport or storage | Shell internals; ownership of Core business rules       |
| Composition Root          | All packages (for dependency injection only)       | Business logic or protocol transformation               |

A Shell never imports another Shell’s internals. UI reuse between `toolkit-ui` and `pipeline-ui` occurs exclusively through a shared presentation package.

## Why this shape

Four prior artifacts produced overlapping implementations of lint gates, pipeline logic, and provider handling. The layered model with an explicit Application boundary gives every capability exactly one home while keeping live effects (network, persistence, retries, event emission) outside pure Core. Dual provider adapters and dual Shells remain first-class; neither is designated the “real” implementation.

## Request lifecycle (single pipeline run)

1. A Shell issues a versioned `PipelineCommand` to the Application protocol.
2. The Application validates the command against the corresponding JSON Schema, obtains any required context, and calls pure Core stage decision logic.
3. If the stage requires model generation, Core returns a deterministic `GenerationRequest` (or a demo-mode action plan). The Application, not Core, invokes the configured `ProviderTransport` adapter.
4. The Application classifies the provider outcome (`GenerationResult` or `ProviderFailure`). It then calls Core again to reduce the classified outcome into a new pipeline state, a set of `GateResult`s, and an updated `demo_mode` flag.
5. The Application persists a fully populated `RevisionEntry` via the configured `RevisionStore` adapter and emits a redacted `ObservabilityEvent` through the configured sink.
6. The Application returns a validated `PipelineOutcome` to the Shell. The Shell renders the outcome; it never calls Core or adapters directly.

Fallback to `⟦WORKFLOW DEMO — no model⟧` is decided by the Application after classifying a provider failure; Core merely maps an already-classified failure into a labeled, non-fabricated placeholder. This preserves Core purity while retaining the honesty guarantee.

## Fallback behavior

When a provider adapter is unreachable or exhausts retries:

1. The Application records a typed `ProviderFailure`.
2. Core produces a deterministic demo-mode outcome from the classified failure.
3. A degrade event is emitted to the observability spine.
4. The Shell is required to render `demo_mode: true` output distinctly; the `CLAIM_DISCIPLINE` gate enforces that demo-mode content never presents itself as live.

## Storage and revision integrity

- `storage-local` retains complete **run bundles** (all stage revisions belonging to one `run_id`), not individual entries. The bound is eight most recent completed run bundles, ensuring a full eleven-stage run can be persisted intact regardless of how many stages the pipeline grows to.
- `storage-db` provides unbounded, multi-tenant storage with query by `run_id`, user, or date.
- Upstream edits mark downstream revisions stale via explicit lineage fields on `RevisionEntry`. Stale material is excluded from exports by default.

## Capability registration and the matrix

`CAPABILITY_MATRIX.md` is generated from a machine-readable `CapabilityRegistration` registry plus evidence that the corresponding contract tests passed. The matrix is not hand-maintained. Until the generator exists, any checked-in copy must be explicitly labeled illustrative and non-authoritative.

## Where the target properties are enforced

Fifteen properties are named below. Earlier drafts referred to "nineteen target properties"; a search of the v5 framework documentation and every supplied archive found no enumeration of nineteen, and the four unaccounted-for properties are not recoverable from the sources (see [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md)). The count is corrected to what is actually specified rather than padded to match a remembered total.

Structural properties (scaffolding, modularity, portability, universality, completeness) are enforced by the layer and protocol boundaries.  
Quality properties (correctness, determinism, consistency, reliability, resilience) are enforced by the purity rules on Core and the typed failure/result contracts.  
Verification properties (testability, auditability, traceability, reproducibility, observability) are enforced by the CI stages described in `DEVELOPMENT_AND_TESTING.md` and the release attestations in `RELEASE_OPERATIONS.md`.

Reproducibility claims are separated:

- **Build reproducibility** — Core source + toolchain → identical artifact hash.
- **Deterministic export reproducibility** — canonical data + renderer configuration → identical bytes.
- **Model-output provenance** — provider/model/version identity, settings, input fingerprints, and retained response reference under the applicable retention policy.

A Core version hash alone never claims to reproduce live model output.

## Relationship to ADRs

- [ADR-0001](./0001-five-layer-architecture.md) established the layered model and the CI-enforced dependency rule. **Amended by [ADR-0005](./0005-application-orchestration-boundary.md)**, which introduces the Application/Orchestration boundary and the Composition Root so the pure-Core invariant holds at runtime. Where the two disagree on layer shape or effect ownership, ADR-0005 governs and this document reflects it.
- [ADR-0002](./0002-contract-first-design.md) records the contract-first rule; the expanded, schema-first contract inventory and versioning policy live in `CONTRACTS.md`.
- [ADR-0003](./0003-dual-provider-adapters.md) remains in force unchanged for dual providers.
- [ADR-0004](./0004-dual-shell-strategy.md) remains in force for dual Shells. **Amended by [ADR-0006](./0006-shell-composition-and-shared-ui.md)**, which requires UI reuse through a shared presentation package rather than Shell-to-Shell delegation, and removes `CI-bot` from the Shell inventory — CI integration is the `cli` Shell invoked from a CI job.
