# Release Operations

## Build-hash stamping

Every generated artifact — JS bundle, catalog exports (JSON/XML/YAML/PDF), compiled-prompt exports — carries a hash of the Core version (gate set + catalog) that produced it, generalized from filesZ's `check_versions.py`. CI fails on a stale-bundle mismatch: if the stamped hash in a built artifact doesn't match a fresh hash of the current `core/` source, the build is rejected.

## Reproducibility check

```
git clone <repo> --branch <tag>
pnpm run build:local     # or build:hosted
pnpm run verify:hash     # compares stamped hash against a fresh CI build of the same commit
```
A release is not cut until this passes for both deployment shapes.

### What the hash does and does not attest

Release attestations report these three separately. Collapsing them into one "reproducibility" claim promises users something the system cannot deliver.

| Attestation | Verified by | Reported as |
|---|---|---|
| **Build reproducibility** | Same source commit + pinned toolchain produces the same artifact hash | `verify:hash` result per deployment shape |
| **Deterministic export reproducibility** | Canonical data order + pinned renderer configuration produces identical bytes | Byte comparison of catalog/PDF exports from independent builds |
| **Model-output provenance** | Provider/model/version identity, settings, input fingerprints, attempt count, and a retained response reference | `execution_provenance` on each `RevisionEntry` |

Model output is **not** reproducible from a Core build hash, and no release note should imply otherwise. The hash identifies the gate set and catalog that evaluated an output; provider and model versions, sampling, generation settings, and retries all affect what the model returned. Replay depends on the retained response under the applicable retention policy — see `REVISIONS_AND_EXPORTS.md`.

## Deployment shapes

Two container images ship from CI:
- `Dockerfile.local` — the local-proxy adapter, no DB, loopback-only default. Smoke-tested in CI.
- `Dockerfile.hosted` — the hosted-server adapter, DB-backed, multi-user. Smoke-tested in CI.

Both are independently deployable and independently rollback-able: a regression traced to one adapter reverts without touching the other, Core, the Application layer, or Shells.

## `CAPABILITY_MATRIX.md` generation

Generated (not hand-maintained) from the contracts plus registrations. CI fails if:
- a contract exists with zero registered producers, or a port contract with zero implementing adapters,
- an implementation claims a capability not declared in a contract, or
- a registration cites test evidence that is missing or failing.

This is what prevents the failure mode seen in the source artifacts, where a README described a state the codebase no longer matched.

**The generator was Phase 7 work ([`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)) and is built.** `npm run docs:matrix` / `npm run check:matrix` keep the committed file honest, so it is no longer hand-labeled illustrative. Whether to publish it as the user-facing feature reference is still a Staged Rollout decision below, not a generator-readiness one.

## Staged rollout

1. **Internal dogfood** — local-proxy shape, `--offline` default. Exit criterion: zero P0/P1 bugs in Core over one week of real usage.
2. **Limited hosted pilot** — hosted-server shape, small user group. Exit criterion: provider adapter uptime, rate-limit correctness, zero key leakage in logs (checked against the observability spine's redaction rule).
3. **General availability** — both shapes documented and supported; `CAPABILITY_MATRIX.md` published as the user-facing feature reference.

## Rollback

Because Adapters and Shells depend only on Contracts (see `ARCHITECTURE.md`), a rollback is scoped to the smallest layer that regressed:
- Adapter regression → revert that adapter's image/version, Core and Shells untouched.
- Shell regression → revert that Shell's build, Core and Adapters untouched. This holds only because Shells no longer import each other; a shared presentation package is pinned and reverted like any other dependency ([ADR-0006](./0006-shell-composition-and-shared-ui.md)).
- Application-layer regression → revert the application package; Core, Adapters, and Shells are untouched provided the protocol version is unchanged.
- Core/contract regression → this is the expensive case; it requires a coordinated rollback across every dependent, which is exactly why contract changes get the strictest review (see ADR-0002).

## Post-release monitoring

- Adversarial/reliability eval reruns: weekly against `main`, archived per run.
- Dependency/security audit: monthly (see `PRIVACY_AND_SECURITY.md`).
- Contract version audits: on every PR touching `contracts/`, via automated schema-diff.
