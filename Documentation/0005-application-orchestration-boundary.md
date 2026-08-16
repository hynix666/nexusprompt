# ADR-0005: Application/Orchestration Boundary (amends ADR-0001)

## Status
Accepted — amends ADR-0001, which remains in force except where this ADR supersedes it.

## Context

ADR-0001 established a five-layer architecture in which Core is "pure functions, no I/O, no framework." The request lifecycle documented alongside it did not hold to that invariant. A Shell called a Core `PipelineStage` directly; that stage received an injected asynchronous `generate()` function and invoked it; and the stage itself was described as owning the decision to degrade to `⟦WORKFLOW DEMO — no model⟧` after a provider failure.

Dependency injection removes the *import* dependency, but not the *effect*. An injected `generate()` performs network I/O, has temporal behavior, can time out, and can return different values for identical inputs. A Core that calls it is not pure, and every claim resting on that purity — determinism, property-testability, portability, cross-shell parity, the adversarial corpus baseline — is correspondingly weaker than stated.

This was raised as findings F-01 and F-02 in the Cross-Document Architecture Review and confirmed in the Reconciled Assessment. Both recommended keeping the pure-Core goal and moving the effects, rather than relaxing the definition of Core.

## Decision

Introduce an explicit **Application/Orchestration** layer between Shells and Core, and a **Composition Root** that performs deployment wiring. Both are logical boundaries — packages within the monorepo, not separate services or network hops.

Effect ownership moves as follows:

- **Core** becomes genuinely pure. It receives validated input and, where model work is needed, *returns* a deterministic `GenerationRequest` or demo action plan. It never receives a `generate()` function and never invokes one. It has no network, filesystem, clock, randomness, event sink, or persistence access.
- **Application/Orchestration** validates every `PipelineCommand` against its schema, calls Core decision logic, invokes the configured `ProviderTransport` adapter, classifies the outcome into a `GenerationResult` or a typed `ProviderFailure`, calls Core again to *reduce* that classified outcome into the next pipeline state, persists a `RevisionEntry` via the configured `RevisionStore`, and emits a redacted `ObservabilityEvent`. It owns retries, backoff, timeouts, cancellation, and the fallback ladder.
- **Shells** call the Application protocol. They do not call Core or adapters.
- **Composition Root** is the only place concrete adapters, sinks, and configuration are assembled. It contains no business logic and performs no protocol transformation.

Fallback to demo mode is therefore a two-part operation: the Application *classifies* the failure, and Core *deterministically maps* the already-classified failure to a labeled, non-fabricated placeholder. The honesty guarantee is preserved without the purity violation, because Core sees a value, not a failure event.

## Consequences

- The pure-Core claim becomes demonstrable rather than aspirational: static import checks plus test instrumentation can prove no effect occurs inside Core. `generate()` not appearing in any Core signature is the mechanical test.
- Determinism, property tests, the adversarial corpus, and cross-shell `GateResult` parity regain the foundation they were documented as having.
- Retry, backoff, and fallback policy live in exactly one place instead of being reimplemented per stage — the same "one home per capability" principle ADR-0001 applied to gates.
- Cost: one additional layer to traverse, and a two-call shape (decide → invoke → reduce) where the previous design had a single stage call. This is accepted as the price of an invariant the rest of the architecture depends on.
- ADR-0001's layer count is now nominal. The enforced structure is Shells → Application → Core, with Contracts as the cross-boundary interface, Adapters below, a Composition Root wiring them, and Observability cutting across. `ARCHITECTURE.md` is the authority on the current shape; where it and ADR-0001's diagram disagree, `ARCHITECTURE.md` wins.

## Alternatives considered

- **Redefine Core as an "effect-parameterized application core."** Rejected. This is the cheaper edit — it changes the wording rather than the code — but it silently downgrades determinism, testability, portability, and reproducibility, all of which the documentation set presents as load-bearing. Renaming the problem does not close it.
- **Keep effects in Core but forbid them in gates/catalog/diff only.** Rejected as a partial fix that leaves `core/stages/` impure while the layer is still labeled pure, which reproduces the original ambiguity at smaller scale.
- **Make the Application layer a separate deployed service.** Rejected as premature, for the same reason ADR-0001 rejected microservices: neither deployment shape requires a network hop, and adding one would complicate the local-proxy shape's "no infrastructure" value without benefit.

## Enforcement

The dependency table in `ARCHITECTURE.md` is enforced by ESLint `no-restricted-imports` (and equivalents for non-TypeScript packages), failing CI on violation. Specifically:

- `core/*` may not import `adapters/*`, `shells/*`, or `application/*`.
- No Core function signature may accept a callable that performs I/O; the boundary test asserts `generate` is absent from Core's public surface.
- `shells/*` may not import `core/*` or `adapters/*`.
