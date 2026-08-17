# Capability Matrix

> # ⚠️ Illustrative target-state matrix — not a capability assertion
>
> **Nothing on this page is evidence that a capability exists or passes tests.** The generator (`npm run docs:matrix`) does not exist yet; it is **Phase 7 — Release truth** in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md), which is blocked on there being a git remote. Until the generator exists, this file shows the *expected shape* of the generated output and must not be cited as a feature reference, a release artifact, or proof of implementation status.
>
> *(Earlier revisions called this "Phase 5 work", from a numbering that predated the plan. The plan owns phase numbers now.)*
>
> Once the generator exists, this file becomes generated output — do not hand-edit it.

## Expected shape once generated

Rows are produced from `CapabilityRegistration` records (see `CONTRACTS.md`) plus contract-test evidence. `Producers` are the components that create values of a contract; `Adapters` are swappable implementations of a port; `Consumers` are the Shells and packages that read it. Conflating these was a defect in the earlier draft of this file, which listed pure Core modules such as `core/gates` under a heading of "Implementing Adapters" while the CI rule it described required an adapter per contract.

`Status` is never asserted by hand. It is derived from the referenced `test_evidence_ref`: a row can only read `verified` when a contract-test run for that implementation passed in CI.

| Contract | Producers | Adapters | Consumers | Status |
|---|---|---|---|---|
| `GateResult` | `core/gates` (16 gates) | — | `application`, all Shells, exports | *(derived)* |
| `TechniqueRecord` | `core/catalog` (172 records) | — | `toolkit-ui` (Catalog module) | *(derived)* |
| `GenerationRequest` / `GenerationResult` | `core/stages`, `application` | `provider-local-proxy`, `provider-hosted-server` | `application` | *(derived)* |
| `ProviderFailure` / `ProviderHealth` | `provider-local-proxy`, `provider-hosted-server` | — | `application`, observability | *(derived)* |
| `PipelineCommand` / `PipelineOutcome` | Shells / `application` | — | `application`, all Shells | *(derived)* |
| `RevisionEntry` | `application` | `storage-local`, `storage-db` | `pipeline-ui`, `toolkit-ui` (Vault module), exports | *(derived)* |
| `ObservabilityEvent` | all layers via the event port | stdout/JSON-lines sink, OpenTelemetry exporter | trace viewer | *(derived)* |
| `CapabilityRegistration` | every registered implementation | — | this generator | *(derived)* |

## CI enforcement

Once it exists, the generator fails the build if:
- a contract has no registered producer, or a port contract has no implementing adapter,
- an implementation is registered against a contract it doesn't actually implement (checked via the contract test suite passing),
- a consumer reads a contract it isn't registered against, or
- a registration references test evidence that does not exist or did not pass.

## Why this exists

Every one of the four source artifacts had a README or spec doc describing capabilities (e.g., v5's claimed "10 of 89 techniques verifiable" catalog coverage) that drifted out of sync with what the code actually did. This file exists specifically to make that drift a build failure instead of a documentation bug someone eventually notices.
