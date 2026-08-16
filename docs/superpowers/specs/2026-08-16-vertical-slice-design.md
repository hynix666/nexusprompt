# Vertical Slice — Design

**Date:** 16 August 2026
**Status:** Approved for implementation
**Depends on:** `2026-08-16-source-freeze-design.md` — the slice reads from `sources/`, which that work establishes.

## Purpose

Prove the architecture end to end before porting the bulk of it.

The documentation specifies a pure Core that decides, an Application layer that performs effects, and a demo-mode fallback that refuses to fabricate output. None of this has ever run. The risk is not that these ideas are wrong — it is that porting 16 gates, 11 stages, two provider adapters, and three shells against an unproven boundary means discovering the boundary is wrong 16 times.

This slice runs one gate and one stage through every layer. If it works, the remaining work is repetition against a proven shape. If it does not, the correction costs one gate instead of sixteen.

## Goals

1. One prompt lints end to end, with `GateResult`s that match the source linter's behavior.
2. One stage completes a full decide → invoke → reduce cycle with a live provider.
3. With the provider unreachable, that same stage produces labeled demo output rather than fabricated content.
4. Core purity is proven mechanically, not asserted.

## Non-goals

The other 15 gates, the catalog import, `toolkit-ui`, `pipeline-ui`, `storage-db`, the hosted provider adapter, and the 10 stages other than `compile`. Each is repetition of a pattern this slice establishes, and each is cheaper once the pattern is proven.

`TechniqueRecord` and `TenantContext` contracts are also deferred — nothing in the slice touches the catalog or multi-tenancy.

## Repository

`git init` in place. `Documentation/` moves to `docs/`. The source archives are gitignored; `sources/` is committed per the freeze design.

pnpm workspace, TypeScript, vitest, ajv for schema validation, fast-check for property tests.

```
contracts/                    # JSON Schemas + generated TS types
core/                         # pure
  gates/secret-leak-scan.ts
  stages/compile.ts
application/                  # all effects
adapters/
  provider-local-proxy/
  storage-local/
shells/cli/
sources/                      # frozen inputs (see freeze design)
```

## Contracts

Nine schemas — the subset the slice actually crosses a boundary with:

`GateResult`, `GenerationRequest`, `GenerationResult`, `ProviderFailure`, `ProviderHealth`, `PipelineCommand`, `PipelineOutcome`, `RevisionEntry`, `ObservabilityEvent`.

Each ships with at least one example fixture that must validate against its schema, and one counter-example that must fail. A schema no test can fail is not a constraint.

TypeScript types are generated from the schemas, never hand-written alongside them. The generation step runs in CI; a drift between schema and type is a build failure.

## Core

Core imports nothing outside `contracts/` and pure utilities. No network, filesystem, clock, or randomness. No function accepts a callback that performs I/O.

### `core/gates/secret-leak-scan.ts`

Ported from `sources/v5/prompt_lint.py`. The gate scans compiled prompt text for seven bounded patterns: five credential shapes (`sk-ant-`, generic `sk-`, `AKIA`, `ghp_`, `xox[baprs]-`) and two PII heuristics (email, international phone).

**It emits `WARN`, not `FAIL`.** The source is explicit that a hit means "look here", not proof. `GATES_REFERENCE.md` documented this as "FAIL on any match", which is one of five verdict-column errors found while writing this spec.

Every quantifier in the source patterns is bounded at both ends, with a comment recording why: an open-ended quantifier against a long non-matching run made the scan quadratic, and a 500 KB prompt took minutes. **The port preserves the bounds.** A property test asserts the gate completes within a fixed time budget on a large adversarial input — this is the invariant that regression would silently destroy.

### `core/stages/compile.ts`

Two pure functions, which is the shape ADR-0005 requires:

- `decide(input, context) → GenerationRequest | DemoAction` — what should happen next.
- `reduce(input, outcome) → { output, gateResults, demoMode }` where `outcome` is an already-classified `GenerationResult` or `ProviderFailure`.

Neither function invokes anything. `reduce` maps a classified failure to a `⟦WORKFLOW DEMO — no model⟧` placeholder deterministically: same classified failure in, same placeholder out. This is what makes demo mode testable without a provider.

The stage's prompt template ports from `sources/pipeline/SystemPromptBuilderPipeline.tsx` (`DEFAULT_STAGES`, `s3`).

## Application

Owns every effect. Validates the `PipelineCommand` against its schema, calls `decide`, invokes the provider adapter, classifies the outcome, calls `reduce`, persists the `RevisionEntry`, emits the `ObservabilityEvent`, returns a validated `PipelineOutcome`.

Retry policy: retry only when `ProviderFailure.retriable` is true, honoring `retry_after_ms`, to a fixed attempt cap. Timeout per request. On exhaustion, the classified failure goes to `reduce` and the run degrades rather than failing.

Classification is the Application's job precisely because it is where transport reality meets typed values. A timeout becomes `TIMEOUT`; a 401 becomes `AUTH`; a connection refused becomes `UNAVAILABLE`.

## Adapters

### `provider-local-proxy`

A native TypeScript `ProviderTransport`, rewritten from `sources/v5/promptnexus-v5/standalone/serve.py` rather than wrapping it. The security invariants port explicitly: fixed upstream host allowlist, path-tail validation on provider-specific URL segments, `Content-Length` pre-check before proxying, loopback-only bind by default.

**The 27-assertion security baseline is rewritten, not ported** — the source suite is Python driving a live server. This is the slice's largest risk, because a rewritten security test can pass while testing something weaker than the original.

The mitigation is one-to-one traceability. Each vitest case names the assertion it replaces:

```ts
// port of test_server.py:125 — "tail rejected: <escape>"
```

A test asserts that all 27 mappings are present and unique. A rewritten baseline is acceptable; an unmappable one is not.

### `storage-local`

Implements `RevisionStore` over the local filesystem. Retains **run bundles** — all entries sharing a `run_id`, kept or evicted whole, bounded at eight bundles. The source's entry-based cap of 8 could not hold a 9-stage run and the pipeline is now 11; bundle-based retention is immune to stage count.

## Shell

`shells/cli` exposes two commands and calls only the Application protocol:

```
promptnexus lint <file>
promptnexus run --stage compile <file>
```

## Data flow

```
cli → PipelineCommand → [validate] → core.decide
                                        ↓ GenerationRequest
                              application → provider adapter
                                        ↓ GenerationResult | ProviderFailure
                                     [classify] → core.reduce
                                        ↓ next state + GateResults
                          persist RevisionEntry → emit ObservabilityEvent
                                        ↓
                                  PipelineOutcome → cli
```

## Error handling

No exception crosses a layer boundary. Adapters return typed `ProviderFailure`. Schema validation failures return a typed validation error naming the failing path. The CLI renders `safe_message` and `reason_code`; raw provider errors are never surfaced, because they can echo request content.

## Testing

| Layer | Approach |
|---|---|
| `core/gates` | Fixture parity against the relevant cases in `sources/v5/fixtures.json` (40 cases total, each with `name`, `text`, `options`, `expect`), plus property tests including the bounded-runtime invariant |
| `core/stages` | Unit tests passing values — never a provider, never a fake `generate()` |
| `core` (all) | **Purity instrumentation**: the harness stubs network, filesystem, clock, and randomness, and fails the suite if any is touched during a Core test |
| `application` | Orchestration tests with fake adapters: retry, timeout, each failure category, demo fallback |
| `adapters/provider-local-proxy` | The 27 mapped security assertions |
| `adapters/storage-local` | Run-bundle retention, including that an 11-entry run survives intact and that eviction removes whole bundles |
| integration | The demo-mode acceptance test below |

Purity instrumentation is in the slice rather than deferred because it is the only mechanical proof that ADR-0005 holds. Without it, "Core is pure" is again a claim in a document — the exact failure this project exists to correct.

## Acceptance criteria

1. `promptnexus lint <file>` returns `GateResult[]` validating against the schema, with `SECRET_LEAK_SCAN` emitting `WARN` on a planted key.
2. Gate verdicts match `fixtures.json` expectations for every case exercising `SECRET_LEAK_SCAN`.
3. `promptnexus run --stage compile <file>` completes against a live provider and persists a `RevisionEntry` with `status: SUCCEEDED`.
4. **With the proxy stopped**, the same command produces `⟦WORKFLOW DEMO — no model⟧`, `demo_mode: true`, `status: DEMO`, and `CLAIM_DISCIPLINE` passes on that output.
5. The Core test suite passes with purity instrumentation active.
6. Introducing a `fetch` call into any Core module fails the Core suite.
7. All 27 security assertions pass and each maps to a distinct source assertion.
8. A run bundle containing 11 stage revisions persists and reloads intact.
9. `pnpm run lint:boundaries` fails on an added `core/ → adapters/` import.

Criteria 6 and 9 test that the safeguards can fail. A guard that has never been observed failing is not known to work.

## Risks

| Risk | Response |
|---|---|
| Rewritten security suite is weaker than the original | One-to-one assertion mapping, enforced by a test |
| Regex port loses the bounded quantifiers, reintroducing quadratic scan | Property test with a fixed time budget on large input |
| `decide`/`reduce` split proves awkward in practice | This is what the slice exists to discover. If the shape is wrong, it is wrong once — the reason for one gate rather than sixteen |
| Purity instrumentation has gaps | Criterion 6 requires demonstrating it catches a real violation |
