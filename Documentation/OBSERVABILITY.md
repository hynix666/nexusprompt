# Observability

The observability spine is built before any Adapter exists — specifically so instrumentation is never retrofitted onto a system that already has effects to instrument.

## Event schema

The authoritative definition is the `ObservabilityEvent` schema in [`CONTRACTS.md`](./CONTRACTS.md) (`observability-event/1.0.0`). Its shape:

| Field | Purpose |
|---|---|
| `event_id` | Unique identity for this event |
| `event_type` | One of `PIPELINE_COMMAND_RECEIVED`, `STAGE_DECISION`, `PROVIDER_CALL_STARTED`, `PROVIDER_CALL_SUCCEEDED`, `PROVIDER_CALL_FAILED`, `DEGRADE`, `RECOVER`, `REVISION_PERSISTED`, `EXPORT_GENERATED`, `HEALTH_CHECK` |
| `run_id` | The run this event belongs to |
| `parent_event_id` | Causal parent — what makes ordered replay reconstructable rather than inferred from timestamps |
| `timestamp` | ISO 8601 |
| `layer` / `component` | `shell` \| `application` \| `core` \| `adapter`, plus the emitting component |
| `duration_ms` / `attempt` | Timing and retry number, for degrade/recover and retry analysis |
| `input_hash` / `output_hash` | Fingerprints only — never bodies |
| `provider_id` / `model_id` | Which provider and model an operation used |
| `failure_code` / `verdict` | Safe failure classification; gate verdict where applicable |
| `schema_version` | Which event contract version this payload conforms to |

An earlier revision of this document specified a seven-field event carrying only `run_id`, `contract_id`, hashes, `verdict`, `timestamp`, and `layer`. That shape could not express the degrade/recover events, retry history, or causal ordering this same document claims — the fields above exist specifically to close that gap.

No field carries prompt body content — only hashes. This is enforced in `observability/sink.ts` itself (a redaction check runs before any event is written), not left as a convention for call sites to honor. The sink rejects, rather than truncates, any payload containing a body.

## Fingerprint and retention policy

Hashes are not automatically privacy-safe. A short or templated prompt has low entropy, so an unkeyed digest of it is correlatable across runs and vulnerable to dictionary matching by anyone holding the event stream.

- `input_hash` and `output_hash` are **keyed** digests (HMAC-style, deployment-scoped key), so fingerprints cannot be matched against a precomputed table or correlated across deployments.
- The key is held by the Application layer's event port, rotated per the deployment's secret-rotation policy, and never emitted.
- Fingerprints are still equality-comparable *within* a deployment, which is all the trace viewer and stale-detection need.
- Event retention and access scope are set per deployment and stated in `PRIVACY_AND_SECURITY.md`. Events are not user content and are not exported with revisions.

## `run_id` propagation

A `run_id` is generated once, at the point a Shell initiates a pipeline run, and threaded through the `PipelineCommand`, every Core stage decision, every `ProviderTransport` call the Application makes, the resulting `RevisionEntry`, and every event above. Combined with `parent_event_id`, this is what makes a run fully traceable: given an exported artifact's `run_id`, every gate verdict, retry, and provider call that produced it can be replayed in causal order from the event log.

Note that the Application layer, not Core, emits provider-call and persistence events — Core has no event-sink access (see [ADR-0005](./0005-application-orchestration-boundary.md)). Core's contribution to the stream is the `STAGE_DECISION` event the Application emits on its behalf, carrying the deterministic decision Core returned.

## Sink architecture

`observability/sink.ts` defines a pluggable interface. Two implementations ship:
- **stdout/JSON-lines** — default for local/dev and the local-proxy deployment shape.
- **hosted exporter** (OpenTelemetry-compatible interface, implementation pluggable) — for the hosted-server deployment shape, so events can flow into whatever the deploying team already uses.

Swapping sinks changes nothing about event shape or call sites — only `sink.ts` differs (see `ARCHITECTURE.md` → dependency rule; the spine is called from every layer via a thin wrapper, never embedded).

## Health checks

Both `ProviderTransport` adapters implement `healthCheck()`, returning a `ProviderHealth` with a `degradation_state` of `NONE`, `DEGRADED`, or `UNAVAILABLE`. The Application layer polls this on a configurable interval and emits `HEALTH_CHECK`, `DEGRADE`, and `RECOVER` events. The polling and the resulting fallback decision belong to the Application, not to the spine and not to Core — the spine records the transition, it does not drive it (see `PROVIDERS.md` for the ladder itself).

## Local trace inspection

```
npm run trace:view -- --run-id <id>
```
Replays a run's full event stream from whichever sink is configured, in causal order — following `parent_event_id` links rather than sorting by timestamp — for local debugging without needing a hosted observability backend. Because events carry `event_type`, `attempt`, and `failure_code`, a replay shows *why* a run degraded, not just that it did.

## What this spine does *not* do

It is not a metrics/alerting system and does not replace a hosted APM tool — it is the structured, redacted event stream that a hosted exporter can feed into one. Alerting policy is an operational decision made per deployment, documented in `RELEASE_OPERATIONS.md`, not something Core or the spine itself prescribes.
