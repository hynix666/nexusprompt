# Providers

Two `ProviderTransport` adapters ship, chosen by deployment shape, not by feature availability — both implement the same contract and pass the same contract test suite.

## `adapters/provider-local-proxy`

Ported from filesZ's stdlib-only `serve.py`. Use for local/offline/single-user deployments.

- Fixed allowlist of upstream hosts — no arbitrary URL passthrough.
- Path-tail validation on provider-specific URL segments (e.g., Gemini's model-name path component) to prevent path-traversal-style abuse.
- API keys live server-side (in the proxy process's environment), never sent to or readable from the browser.
- Loopback-only bind by default; binding to a non-loopback address requires an explicit flag and is logged as a security-relevant event.
- `Content-Length` pre-check before proxying, to reject oversized requests early.
- No dependencies beyond the language standard library — this is deliberate, not incidental, and is what makes this adapter trivially portable (see `ARCHITECTURE.md` → Portability).
- Ships with a **27-assertion** security test suite (`tests/test_server.py`), ported as the contract test baseline for *both* provider adapters. It covers path-tail escapes, traversal blocking including sibling-prefix cases, oversized-body rejection, unknown-provider handling that echoes the name back safely, and assertions that a missing key returns 401 naming the environment variable rather than the key.

## `adapters/provider-hosted-server`

Ported from the GitHub product's `hostedProviders.ts`. Use for multi-user/team deployments.

- Server-side key custody via environment/secrets manager — never touches the browser.
- Per-model allowlist and per-user/org rate limiting.
- DB-backed usage tracking (pairs with `adapters/storage-db`).
- Retry/backoff and health-check behavior identical in shape to the local-proxy adapter, built on the source's existing `HostedProviderHealth`, `HostedProviderError`, `callWithTimeout`, and `probeModel` surface. (Earlier drafts cited a `localRetry`/`localModelStatus` pattern; no such symbols exist in the source.)

## Choosing between them

| | local-proxy | hosted-server |
|---|---|---|
| Users | single user / local dev | team / multi-tenant |
| Infra required | none beyond the proxy process | DB, secrets manager, auth |
| Key custody | proxy process env | server env / secrets manager |
| Usage tracking | none | DB-backed, per-user |

Both are valid production configurations. Neither is "the real one" — this is a deployment-shape decision recorded in ADR-0003, not a maturity ranking.

## Transport protocol

Adapters do not throw untyped errors. Every `generate()` call resolves to either a `GenerationResult` or a `ProviderFailure` (see `CONTRACTS.md`), and `healthCheck()` resolves to a `ProviderHealth`. This is what makes the ladder below testable rather than descriptive — a shared contract test can drive an adapter through each failure category and assert the classification.

| Concern | Owner | Mechanism |
|---|---|---|
| Failure classification | Adapter | Returns a typed `ProviderFailure` with `category`, `retriable`, `reason_code`, `attempt` |
| Retry and backoff | **Application layer** | Decided from `retriable` and `retry_after_ms`; adapters do not silently retry on their own |
| Timeout | Application layer | Per-request deadline; expiry produces a `TIMEOUT` failure |
| Cancellation | Application layer | Config change or user abort cancels in flight; produces `CANCELLED` |
| Idempotency | Caller | `idempotency_key` on `GenerationRequest`, so a retried request is not double-billed or double-applied |
| Model selection | Caller | `model_policy` (`preferred_models`, `allow_fallback`) on the request |

Failure categories are `TIMEOUT`, `RATE_LIMIT`, `AUTH`, `UNAVAILABLE`, `INVALID_REQUEST`, `CONTENT_FILTER`, `INTERNAL`, and `CANCELLED`. Only the `safe_message` and `reason_code` are ever surfaced or logged — raw provider errors can echo request content and are not propagated.

## Fallback ladder

If the configured `ProviderTransport` reports an unhealthy `degradation_state` or a `generate()` call exhausts the Application's retry budget:

1. The **Application layer** records the typed `ProviderFailure` — classification is an effect, so it does not happen in Core (see [ADR-0005](./0005-application-orchestration-boundary.md)).
2. The Application passes the already-classified failure to Core, which **deterministically** maps it to a `demo_mode: true` outcome carrying a `⟦WORKFLOW DEMO — no model⟧` labeled placeholder rather than fabricated output. Same classified failure in, same placeholder out — which is why this step is testable without a provider.
3. The Application emits a `DEGRADE` event to the observability spine with the failure code, attempt count, and provider identity.
4. The Application persists the revision with `status: DEMO`.
5. The Shell is required to render `demo_mode` output visibly differently from live output — this is a `CLAIM_DISCIPLINE` gate check, not just a UI convention.

An earlier revision of this document placed steps 1–4 inside the `PipelineStage` itself. That put network classification, event emission, and persistence in Core and is superseded by ADR-0005; the honesty guarantee is unchanged, only its owner moved.

## Adding a third provider adapter

Implement `ProviderTransport` (see `CONTRACTS.md`), run it against `adapters/_contract-tests/provider-transport.spec.ts`, and register it in the (generated) `CAPABILITY_MATRIX.md` — CI fails if an adapter is added without a passing contract-test run.
