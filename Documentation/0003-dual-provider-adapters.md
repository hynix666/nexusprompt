# ADR-0003: Dual Provider Adapters (Local-Proxy and Hosted-Server)

## Status
Accepted

## Context
Two of the four source artifacts solved provider-key-custody independently and differently: filesZ built a stdlib-only Python proxy (fixed allowlist, loopback-default, zero extra infrastructure); the GitHub product built a DB-backed server adapter (multi-tenant, rate-limited, usage-tracked). Both solve the same threat (never let the browser hold a hosted-provider key) for different deployment targets. The final package's approach — keys in browser state — was explicitly self-documented as a risk, not a third valid option.

## Decision
Ship both the local-proxy and hosted-server approaches as adapters implementing the same `ProviderTransport` contract (ADR-0002), tested against a shared contract test suite including the v5 standalone proxy's 27-assertion security baseline (`tests/test_server.py`; earlier drafts cited 29 and credited filesZ). Neither is designated the "default" or "correct" one — the choice is a deployment-shape decision (single-user/local vs. team/hosted), documented per-deployment.

## Consequences
- No forced choice between "simple, no infra" and "multi-tenant, full-featured" — both ship, both are maintained, both are tested identically.
- A third provider adapter, if ever needed, has a clear bar to clear: implement `ProviderTransport`, pass the shared contract test suite, register in `CAPABILITY_MATRIX.md`.
- Slightly more adapter code to maintain than a single-approach system, accepted as the cost of supporting genuinely different deployment needs without compromising either on security or on operational simplicity.

## Alternatives considered
- **Hosted-server only**: rejected — forces DB/auth infrastructure on single-user/local deployments that don't need it, losing the final package's "runs fully local" value.
- **Local-proxy only**: rejected — no multi-tenant usage tracking or per-org rate limiting, losing the GitHub product's team-deployment capability.
- **Browser-held keys (final package's original approach)**: rejected outright — self-documented as a risk in its own source docs, not a genuine architectural option.
