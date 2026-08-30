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

No field carries prompt body content — only hashes.

**Corrected 29 August 2026 (sweep fourteen).** This paragraph named `observability/sink.ts` as the enforcement point. That module has never existed, no sink module has ever been tracked, and every sink in the repository is an inline lambda — so the property *was* the "convention for call sites to honor" the sentence disowned, and the convention was broken: `failStage` copied `err.message` into `DEGRADE.verdict`, so a provider adapter throwing a parse error that quotes its payload put the brief into four events. Measured, not inferred.

Two layers now, and the reason there are two is that the first is exactly the per-call-site discipline the old claim was wrong to assume:

1. **Call sites forward an error's TYPE, never its message.** A name is bounded and routes a failure as well as a message does; the message belongs in an operator's own log, not in the spine that promises hashes only.
2. **`application/src/redaction.ts` wraps the sink** and no `emit` can bypass it. It compares every string field against the bodies the run is holding — brief, spec, prompt, critique — and replaces any field sharing a 32-character verbatim run with a marker containing none of it.

**What that check can and cannot decide.** "Does this string contain a prompt body?" is not decidable in general, and a checker claiming otherwise would repeat the overreach this correction exists to fix. What is decidable is whether a field shares a long verbatim run with a body *this run holds*. So it catches a body copied, sliced or embedded — a truncated body is still a body, which is why the window sits below the 200-character slice `failStage` used. It does not catch a paraphrase, a body from another run, or a body shorter than the window, because lowering the threshold makes ordinary English collide.

**It substitutes rather than throws.** The earlier wording said the sink "rejects, rather than truncates". Rejecting the *payload* is right and still holds: no body reaches the sink. Rejecting by throwing was not — `failStage` emits from inside a catch, so a quoted brief turned a gracefully degrading run into an aborted one, losing the artifact to a logging concern. A privacy control should fail closed on the body, not on availability.

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
