# Development & Testing

## Local setup

```
git clone <repo>
pnpm install
pnpm run verify        # lint + typecheck + schema-validate + Core test suite, no network
```

Monorepo layout: `core/`, `application/`, `contracts/`, `adapters/`, `shells/`, `packages/` (shared presentation), `observability/`, `docs/adr/`, `scripts/` (see `ARCHITECTURE.md`).

## Enforced boundaries

An ESLint `no-restricted-imports` rule fails any PR that violates the dependency table in `ARCHITECTURE.md`. This is checked in CI, not left to code review. The rules that catch the most mistakes:

- `core/*` may not import `adapters/*`, `shells/*`, or `application/*`
- `shells/<a>/*` may not import `shells/<b>/*` — cross-Shell reuse goes through a shared presentation package ([ADR-0006](./0006-shell-composition-and-shared-ui.md))
- `shells/*` may not import `core/*` or `adapters/*` — Shells call the Application protocol

If you find yourself needing an Adapter capability inside Core, **passing it in as a parameter is not the fix.** An injected `generate()` is still a live effect, which is why Core no longer accepts one ([ADR-0005](./0005-application-orchestration-boundary.md)). The fix is to split the work: Core returns a deterministic decision — a `GenerationRequest`, or an action plan — and the Application layer performs the effect and calls Core again to reduce the result. A boundary test asserts that no callable performing I/O appears in Core's public surface.

## Test strategy by layer

| Layer | Test type | Requirement |
|---|---|---|
| `core/gates/` | Fixture + property tests | Every gate needs ≥1 property test asserting an invariant, not just an example input/output pair |
| `core/catalog/` | Schema validation + provenance completeness (reported) | Runs on every PR touching catalog data |
| `core/stages/` | Unit tests, no network | Stage functions are pure: decision functions take validated input and return a `GenerationRequest` or action plan; reduction functions take an *already-classified* provider outcome and return the next state. Tests pass values, never a provider or a fake `generate()` |
| `core/scorer/` | Adversarial corpus run | `npm run adversarial`, also run weekly against `main` and archived |
| `application/*` | Orchestration tests with fake adapters | Retry, backoff, timeout, cancellation, failure classification, and the demo-mode fallback ladder are asserted here — this is the layer that owns them |
| `adapters/*` | Contract tests | One test file run against **every** implementation of an interface (e.g., both provider adapters), asserting behavioral parity where the contract requires it. Covers success, timeout, cancellation, auth failure, rate limit, transient failure, unavailable provider, and health transitions |
| `shells/*` | Integration + a cross-shell parity test | The same prompt run through `pipeline-ui` and through `cli` must produce identical `GateResult`s for the same input |
| `packages/*` (shared presentation) | Component tests | Depends only on the Application protocol and contract types; a test asserts no Core or adapter import |

## Scaffolding new capability

```
npm run scaffold:gate -- --id MY_NEW_GATE
npm run scaffold:technique -- --source "<citation>"
```

**Neither generator exists yet.** They appear in no source archive, despite earlier drafts of this document and `CONTRIBUTING.md` instructing contributors to use them rather than hand-write files. They are worth building — pre-wiring the contract shape and a stub test is exactly how the property-test requirement stops being a review-time argument — but until then, write the files by hand.

What CI does enforce today is the requirement itself: a gate without a property test fails the Core stage, whether or not a generator produced it.

## CI pipeline stages

1. Lint (including import-boundary rule) + typecheck + contract schema validation
2. Core unit + property tests (no network) + Core purity instrumentation — the test harness fails the stage if any network, filesystem, clock, or randomness call occurs during a Core test
3. Application orchestration tests against fake adapters
4. Adapter contract tests (against both implementations of each interface)
5. Shell integration tests + cross-shell parity check
6. Adversarial scorer run
7. Build-hash stamping + reproducibility check (see `RELEASE_OPERATIONS.md`)

Each stage must pass before the next runs; failures are attributed to the layer that owns them, not surfaced as a single opaque "CI failed."

## Debugging a run

Use `npm run trace:view -- --run-id <id>` (see `OBSERVABILITY.md`) to replay the event stream for any run without needing to reproduce it live.
