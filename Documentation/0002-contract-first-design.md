# ADR-0002: Contract-First Design

## Status
Accepted

## Context
Given the five-layer architecture (ADR-0001), Shells and Adapters need a stable interface to depend on that isn't a specific language's type system — the source artifacts included a Python CLI, embedded JS, and multiple TypeScript implementations, none of which could share a single "interface" if that interface were TS-only.

## Decision
Define the five cross-layer data shapes (`GateResult`, `TechniqueRecord`, `ProviderTransport`, `PipelineStage`, `RevisionEntry`) as versioned JSON Schemas in `contracts/`, before writing the Core or Adapter code that implements them. No Core module or Adapter is written until its contract is merged and reviewed. Contract changes are versioned (semver) with mandatory changelog entries; breaking changes require a major version bump.

## Consequences
- Non-JS clients (a future Python or Rust Shell, or the `cli` tool) validate against the same schema files without importing TypeScript — this is what makes the "universality" property concrete rather than aspirational.
- A contract change is a reviewable, isolated PR, separate from the implementation change it enables — this slows down fast-moving prototyping but prevents contract drift, which was the single biggest source of inconsistency across the four source artifacts.
- CAPABILITY_MATRIX.md can be generated automatically from contracts + registrations (see ADR-0001 and `RELEASE_OPERATIONS.md`), closing the "docs describe a state the code no longer matches" failure seen in the v5 README.

## Alternatives considered
- **TypeScript interfaces as the sole contract**: rejected — ties every consumer to the TS toolchain, undermining the `cli` tool and any future non-JS Shell.
- **No formal contracts, integration-test-driven consistency**: rejected — this is closer to what the source artifacts already had (implicit shape agreement, verified only by accident when someone ran both implementations side by side) and is exactly the gap this decision closes.
