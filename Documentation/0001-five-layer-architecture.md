# ADR-0001: Five-Layer Architecture

## Status
Accepted — **amended by [ADR-0005](./0005-application-orchestration-boundary.md)**, which adds an Application/Orchestration boundary and a Composition Root so that the pure-Core invariant asserted below actually holds at runtime. Read ADR-0005 alongside this one; where the two disagree on layer shape or effect ownership, ADR-0005 governs.

## Context
Four prior artifacts (v5 spec/linter, GitHub multi-user product, final-package pipeline UI, filesZ toolkit) each implemented overlapping capability — most visibly, three separate lint-gate implementations of differing completeness — with no shared boundary preventing drift between them. Merging file-by-file would preserve this drift rather than fix it.

## Decision
Adopt a strict five-layer architecture: Shells → Contracts → Core → Adapters, with an Observability spine cutting across all four. Dependencies point downward only. Core has zero dependency on Adapters or Shells, enforced by an ESLint `no-restricted-imports` rule in CI, not by review discipline.

## Consequences
- New capability (a gate, a technique, a stage) has exactly one home, eliminating the "three linters" failure mode by construction.
- Adapters can be swapped per deployment (local-proxy vs. hosted-server; local storage vs. DB) without touching Core or Shells.
- Any layer-boundary violation is a CI failure, not a code-review catch that can be missed.
- Cost: contributors must think in terms of "which layer" before writing code, which is friction on day one that pays off as the codebase grows (see `CONTRIBUTING.md`).

## Alternatives considered
- **Feature-folder monolith** (each feature owns its full stack top to bottom): rejected — this is exactly the shape that produced the three-linter drift in the source artifacts.
- **Microservices per capability**: rejected as premature — the deployment shapes needed (single-user local, multi-user hosted) don't require network-separated services; adapter-level swapping achieves the same flexibility with far less operational overhead.
