# Providers

Three `ProviderTransport` adapters ship, chosen by deployment shape, not by feature availability — all three implement the same contract and pass the same contract conformance suite (`test/contract-conformance.test.ts`).

A fourth adapter, `adapters/provider-hosted-judge`, is not one of the three: it implements a different contract, `JudgeTransport` (`grade(req): Promise<JudgeVerdict>`), used to score output rather than generate it. `JudgeTransport.grade()` has no failure union of its own — a real transport signals failure by throwing — so it is not comparable to the three below and is out of scope for the rest of this document.

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

## `adapters/provider-ollama`

New work, not a port — built for [ADR-0015](./0015-local-inference-tier.md)'s local-inference tier. Talks to an Ollama daemon on this machine over `/api/chat`; the only adapter here that has ever actually reached a real model (six local models have answered, with real fingerprints pinned so `check:fingerprint` is armed — though every evaluation figure this repository *reports* still comes from the pinned stub, not a local run).

- **Loopback only, by literal spelling.** The host must match `127.0.0.1`, `localhost`, `[::1]`, or `::1` exactly — not a DNS lookup, which would invite a rebinding race between the check and the request. A caller-supplied host that resolved to "local" would make this adapter a server-side-request-forgery primitive wearing a helpful name.
- **No default model.** `OLLAMA_MODEL` or an explicit option, never a hardcoded name — naming one this machine hasn't pulled produces a 404 that reads like an outage; naming one it has pulled bakes a local accident into a shared adapter.
- **Zero runtime dependencies**, deliberately (ADR-0012's scoped property): no `ollama` client package, just the global `fetch` for a JSON POST.
- **`MALFORMED_RESPONSE` is what makes this adapter necessary to test at all.** A local model can answer with a non-JSON body, an envelope missing `message.content`, or an empty completion — the call *succeeded* in all three, so the demo-mode placeholder ("no output was produced") would misdescribe what happened. See [ADR-0014](./0014-malformed-response-is-not-demo-mode.md).
- **Deliberately does not repair JSON.** No stage in the pipeline asks a model for JSON — every stage consumes prose — so there is nothing here for `jsonrepair` to fix, and adding it would end the zero-dependency property for no benefit.
- 120-second default timeout, configurable — a large local model on CPU exceeding it is a real configuration, not a fault, and the failure message says how long it waited rather than blaming the daemon.
- `healthCheck()` actually reaches `/api/tags` rather than reporting from configuration alone, because "a daemon is configured" and "a daemon is running" are different claims and the second is the one that predicts whether a run can proceed.

## Choosing between them

| | local-proxy | hosted-server | ollama |
|---|---|---|---|
| Users | single user / local dev | team / multi-tenant | single user / local dev, offline |
| Infra required | none beyond the proxy process | DB, secrets manager, auth | an Ollama daemon on this machine |
| Key custody | proxy process env | server env / secrets manager | none — no credential exists |
| Usage tracking | none | DB-backed, per-user | none |

All three are valid configurations; none is "the real one." local-proxy and hosted-server are the deployment-shape decision recorded in [ADR-0003](./0003-dual-provider-adapters.md); ollama is a third, added later by [ADR-0015](./0015-local-inference-tier.md) for offline/zero-cost use, not a maturity ranking against either.

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

Failure categories are `TIMEOUT`, `RATE_LIMIT`, `AUTH`, `UNAVAILABLE`, `INVALID_REQUEST`, `CONTENT_FILTER`, `INTERNAL`, `CANCELLED`, and `MALFORMED_RESPONSE`. Every value except `MALFORMED_RESPONSE` means no response arrived; `MALFORMED_RESPONSE` means one did and could not be used, a distinction [ADR-0014](./0014-malformed-response-is-not-demo-mode.md) requires the category to carry rather than leaving downstream to infer. Only the `safe_message` and `reason_code` are ever surfaced or logged — raw provider errors can echo request content and are not propagated.

## Fallback ladder

If the configured `ProviderTransport` reports an unhealthy `degradation_state` or a `generate()` call exhausts the Application's retry budget:

1. The **Application layer** records the typed `ProviderFailure` — classification is an effect, so it does not happen in Core (see [ADR-0005](./0005-application-orchestration-boundary.md)).
2. The Application passes the already-classified failure to Core, which **deterministically** maps it to a `demo_mode: true` outcome carrying a `⟦WORKFLOW DEMO — no model⟧` labeled placeholder rather than fabricated output. Same classified failure in, same placeholder out — which is why this step is testable without a provider.
3. The Application emits a `DEGRADE` event to the observability spine with the failure code, attempt count, and provider identity.
4. The Application persists the revision with `status: DEMO`.
5. The Shell is required to render `demo_mode` output visibly differently from live output — this is a `CLAIM_DISCIPLINE` gate check, not just a UI convention.

An earlier revision of this document placed steps 1–4 inside the `PipelineStage` itself. That put network classification, event emission, and persistence in Core and is superseded by ADR-0005; the honesty guarantee is unchanged, only its owner moved.

## Adding another provider adapter

Implement `ProviderTransport` (see `CONTRACTS.md`), run it against `test/contract-conformance.test.ts` (the actual conformance suite — an earlier draft of this line named `adapters/_contract-tests/provider-transport.spec.ts`, which exists in no source), and register it in the (generated) `CAPABILITY_MATRIX.md` — CI fails if an adapter is added without a passing contract-test run.
