# Contracts

Contracts are the sole cross-boundary interface. Most values that cross a layer boundary are defined by a versioned JSON Schema living under `contracts/` as a standalone `<name>.schema.json` file (18 exist today). Each schema carries a stable `$id`, a semantic version, and a changelog. Language-specific interfaces (TypeScript, Python, Rust, etc.) are generated or hand-written bindings around these schemas; they are never the source of truth.

**Six documented below name no schema file, and they are not all the same kind of exception.**

Four exist as TypeScript interfaces in `contracts/index.ts` — `GenerationRequest`,
`GenerationResult`, `PipelineCommand` and `ProviderHealth` — so they are real, but a
non-TypeScript client has nothing to validate these payloads against.

Two exist **nowhere**: `TenantContext` and `CapabilityRegistration` have no schema file and no
TypeScript interface. They are described here as target state and nothing implements them.
This document said "four" and named only the first group until 6 September 2026, so the two
that do not exist read as though they did.

The `$id` and JSON shown for all six documents an interface; it is illustrative, not a file
that exists or is checked. Each is noted individually below, and all six are declared in the
list at the end of this document so `check:contracts` can tell "no schema file, deliberately"
from "schema file missing".

A contract change without a corresponding version bump and changelog entry fails CI. Shells and adapters pin major versions; an unsupported major version also fails CI.

## Design principles

- **Schema-first and language-neutral, for the 18 that have a standalone schema file.** A non-JavaScript client must be able to validate those payloads without importing any TypeScript. Six contracts described here do not meet this principle: four are TypeScript-only and two exist nowhere at all. All six are listed at the end of this document.
- **Explicit effect ownership.** Live effects (network, persistence, clock, randomness, event emission) never appear inside Core schemas. Core schemas describe pure values and deterministic decisions only.
- **Complete operational coverage.** Request, result, failure, health, revision lineage, freshness, and observability metadata required by the rest of the documentation are first-class contracts, not prose.

## Core data contracts

### GateResult

Output of a single lint-gate evaluation.

```json
{
  "$id": "https://promptnexus.dev/contracts/gate-result/1.3.0",
  "type": "object",
  "required": ["gate_id", "gate_version", "verdict", "message", "input_hash"],
  "properties": {
    "gate_id": { "type": "string" },
    "gate_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "verdict": { "enum": ["PASS", "FAIL", "WARN"] },
    "message": { "type": "string" },
    "message_code": { "type": "string" },
    "input_hash": { "type": "string" },
    "location": {
      "type": ["object", "null"],
      "properties": {
        "start": { "type": "integer", "minimum": 0 },
        "end": { "type": "integer", "minimum": 0 }
      }
    }
  }
}
```

### TechniqueRecord

One entry from the technique catalog.

This schema is **derived from the 172 records that exist**, not designed independently of them. An earlier draft specified `technique_id`, `provenance.checked_against_source`, and `applicable_stages` — none of which appear in the data. The contract follows the catalog; the catalog is not reshaped to fit the contract.

```json
{
  "$id": "https://promptnexus.dev/contracts/technique-record/2.0.0",
  "type": "object",
  "required": ["id", "name", "category", "schema_version", "description",
               "verification_status", "primary_source"],
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "category": { "type": "string" },
    "subcategory": { "type": "string" },
    "schema_version": { "const": "1.3.0" },
    "executive_summary": { "type": "string" },
    "description": { "type": "string" },
    "verification_status": {
      "enum": ["verifier-checkable", "judge-checkable", "unverifiable-by-text"]
    },
    "primary_source": {
      "type": "object",
      "required": ["title"],
      "properties": {
        "authors": { "type": "string" },
        "year": { "type": "integer" },
        "title": { "type": "string" },
        "venue": { "type": "string" },
        "url": { "type": "string" }
      }
    },
    "secondary_sources": { "type": "array", "items": { "type": "object" } },
    "source_audit": {
      "type": "object",
      "description": "Per-field verification state, e.g. {\"description\": \"unverified\"}",
      "additionalProperties": { "type": "string" }
    },
    "cost_profile": { "type": "string" },
    "when_to_use": { "type": "string" },
    "when_not_to_use": { "type": "string" },
    "known_pitfalls": { "type": "string" },
    "related_techniques": { "type": "array", "items": { "type": "string" } },
    "usage_templates": { "type": "array" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "aliases": { "type": "array", "items": { "type": "string" } },
    "status": { "type": "string" },
    "corpus_file": { "type": "string" }
  }
}
```

`verification_status` is a three-valued epistemic classification, not a boolean: it records whether a technique's effect **can be checked at all**, and by what means. Across the 172 records the split is 130 `verifier-checkable`, 34 `unverifiable-by-text`, 8 `judge-checkable`. Whether a specific field has actually been checked is separate, and lives in `source_audit`. Collapsing these two into one flag was the earlier draft's mistake — it conflated *is this checkable* with *has this been checked*.

The XSD at `schema/prompt_technique_catalog_1.3.0.xsd` ships with the catalog and validates the same records. Both must accept the data; where they disagree, the XSD is the incumbent and the JSON Schema is corrected to match.

## Provider protocol

### GenerationRequest

**TypeScript-only — no `generation-request.schema.json` exists.** The `$id` and JSON below document the `contracts/index.ts` interface; nothing validates a payload against them at runtime.

Issued by the Application layer to a provider adapter. Core may produce a `GenerationRequest` as part of a pure decision; it never executes it.

```json
{
  "$id": "https://promptnexus.dev/contracts/generation-request/1.0.0",
  "type": "object",
  "required": ["request_id", "messages", "model_policy"],
  "properties": {
    "request_id": { "type": "string" },
    "run_id": { "type": "string" },
    "messages": { "type": "array", "items": { "type": "object" } },
    "model_policy": {
      "type": "object",
      "properties": {
        "preferred_models": { "type": "array", "items": { "type": "string" } },
        "allow_fallback": { "type": "boolean" }
      }
    },
    "generation_options": { "type": "object" },
    "tenant_context_ref": { "type": ["string", "null"] },
    "idempotency_key": { "type": ["string", "null"] }
  }
}
```

### GenerationResult

**TypeScript-only — no `generation-result.schema.json` exists.** Same caveat as `GenerationRequest` above.

Successful provider response.

```json
{
  "$id": "https://promptnexus.dev/contracts/generation-result/1.0.0",
  "type": "object",
  "required": ["request_id", "content", "provider_id", "model_id"],
  "properties": {
    "request_id": { "type": "string" },
    "content": { "type": "string" },
    "structured_output": { "type": ["object", "null"] },
    "provider_id": { "type": "string" },
    "model_id": { "type": "string" },
    "model_version": { "type": ["string", "null"] },
    "usage": {
      "type": "object",
      "properties": {
        "prompt_tokens": { "type": "integer" },
        "completion_tokens": { "type": "integer" }
      }
    },
    "finish_reason": { "type": "string" },
    "timings_ms": {
      "type": "object",
      "properties": {
        "total": { "type": "integer" },
        "ttft": { "type": "integer" }
      }
    }
  }
}
```

### ProviderFailure

Typed failure returned by a provider adapter. Used by the Application to decide retries and demo-mode fallback.

```json
{
  "$id": "https://promptnexus.dev/contracts/provider-failure/1.1.1",
  "type": "object",
  "required": ["request_id", "category", "retriable", "reason_code"],
  "properties": {
    "request_id": { "type": "string" },
    "category": {
      "enum": ["TIMEOUT", "RATE_LIMIT", "AUTH", "UNAVAILABLE", "INVALID_REQUEST",
               "CONTENT_FILTER", "INTERNAL", "CANCELLED"]
    },
    "retriable": { "type": "boolean" },
    "reason_code": { "type": "string" },
    "safe_message": { "type": "string" },
    "retry_after_ms": { "type": ["integer", "null"] },
    "attempt": { "type": "integer", "minimum": 1 },
    "provider_id": { "type": "string" }
  }
}
```

### ProviderHealth

**TypeScript-only — no `provider-health.schema.json` exists.** Same caveat as `GenerationRequest` above.

Result of a health check.

```json
{
  "$id": "https://promptnexus.dev/contracts/provider-health/1.0.0",
  "type": "object",
  "required": ["ok", "checked_at", "latency_ms"],
  "properties": {
    "ok": { "type": "boolean" },
    "checked_at": { "type": "string", "format": "date-time" },
    "latency_ms": { "type": "integer", "minimum": 0 },
    "degradation_state": {
      "enum": ["NONE", "DEGRADED", "UNAVAILABLE"]
    },
    "failing_dependency": { "type": ["string", "null"] }
  }
}
```

### ProviderTransport (binding surface)

Adapters implement the following operations. The operations themselves are not JSON; their request and response payloads are the schemas above.

- `generate(GenerationRequest) → GenerationResult | ProviderFailure`
- `healthCheck() → ProviderHealth`
- `listModels() → ModelInfo[]` (ModelInfo is a simple value schema)

Both reference adapters are tested against the identical contract-test suite, including the **27-assertion** security baseline ported from `tests/test_server.py` (path-tail validation, traversal blocking, oversized-body rejection, and key-custody assertions). Earlier drafts said 29; the source contains 27.

## Pipeline protocol

### PipelineCommand

**TypeScript-only — no `pipeline-command.schema.json` exists.** Same caveat as `GenerationRequest` above.

Command issued by a Shell to the Application.

```json
{
  "$id": "https://promptnexus.dev/contracts/pipeline-command/1.0.0",
  "type": "object",
  "required": ["command_id", "run_id", "stage_id", "input"],
  "properties": {
    "command_id": { "type": "string" },
    "run_id": { "type": "string" },
    "stage_id": {
      "enum": ["deconstruct", "calibrate", "compile", "harden", "critique",
               "refine", "lint", "critic", "preview", "cost_estimate", "tone_check"]
    },
    "input": { "type": "object" },
    "context": { "type": "object" },
    "config_fingerprint": { "type": ["string", "null"] }
  }
}
```

### PipelineOutcome

Validated response returned to a Shell.

```json
{
  "$id": "https://promptnexus.dev/contracts/pipeline-outcome/1.0.0",
  "type": "object",
  "required": ["command_id", "run_id", "stage_id", "output", "gate_results", "demo_mode"],
  "properties": {
    "command_id": { "type": "string" },
    "run_id": { "type": "string" },
    "stage_id": { "type": "string" },
    "output": { "type": "object" },
    "gate_results": {
      "type": "array",
      "items": { "$ref": "https://promptnexus.dev/contracts/gate-result/1.3.0" }
    },
    "demo_mode": { "type": "boolean" },
    "revision_id": { "type": "string" },
    "execution_provenance": { "type": "object" }
  }
}
```

Core stage logic is pure: given validated input and a previously classified provider outcome (or a demo decision), it produces the next state and GateResults. It never receives a live `generate` function.

## Revision and storage protocol

### RevisionEntry

One stage execution within a run. Expanded to support lineage, freshness, and provenance required by export and invalidation rules.

```json
{
  "$id": "https://promptnexus.dev/contracts/revision-entry/3.0.0",
  "type": "object",
  "required": [
    "revision_id", "run_id", "stage_id", "timestamp",
    "input_hash", "output_hash", "gate_results", "freshness", "status"
  ],
  "properties": {
    "revision_id": { "type": "string" },
    "run_id": { "type": "string" },
    "stage_id": { "type": "string" },
    "parent_revision_ids": {
      "type": "array",
      "items": { "type": "string" }
    },
    "timestamp": { "type": "string", "format": "date-time" },
    "stage_attempt": { "type": "integer", "minimum": 1 },
    "input_hash": { "type": "string" },
    "output_hash": { "type": "string" },
    "gate_results": {
      "type": "array",
      "items": { "$ref": "https://promptnexus.dev/contracts/gate-result/1.3.0" }
    },
    "freshness": { "enum": ["FRESH", "STALE"] },
    "status": { "enum": ["SUCCEEDED", "DEMO", "FAILED", "CANCELLED"] },
    "provider_used": { "type": ["string", "null"] },
    "execution_provenance": {
      "type": "object",
      "properties": {
        "core_build_hash": { "type": "string" },
        "contract_versions": { "type": "object" },
        "provider_model_fingerprint": { "type": ["string", "null"] },
        "config_fingerprint": { "type": ["string", "null"] }
      }
    },
    "input_ref": { "type": ["string", "null"] },
    "output_ref": { "type": ["string", "null"] },
    "retention_scope": { "enum": ["LOCAL_BUNDLE", "DB", "EXPORT"] }
  }
}
```

### RevisionStore (binding surface)

Storage adapters implement:

- `append(RevisionEntry) → void`
- `markStale(run_id, from_revision_id) → void` — inclusive; cascades along `parent_revision_ids`
- `getRun(run_id) → RevisionEntry[]`
- `listRecent(limit) → RunBundleSummary[]` (local adapter respects the eight-run-bundle bound)
- `delete(run_id, confirmation) → void`

Local storage retains complete run bundles so that a full eleven-stage pipeline never exceeds the retention bound by construction. Counting entries rather than bundles is what made this a problem: the source's eight-entry cap could not hold a nine-stage run, and the pipeline has since grown to eleven.

## Observability protocol

### ObservabilityEvent

Redacted, privacy-safe event. Prompt bodies are forbidden; the sink itself rejects any payload that contains them.

```json
{
  "$id": "https://promptnexus.dev/contracts/observability-event/1.3.0",
  "type": "object",
  "required": ["event_id", "event_type", "run_id", "timestamp", "layer"],
  "properties": {
    "event_id": { "type": "string" },
    "event_type": {
      "enum": [
        "PIPELINE_COMMAND_RECEIVED", "STAGE_DECISION", "PROVIDER_CALL_STARTED",
        "PROVIDER_CALL_SUCCEEDED", "PROVIDER_CALL_FAILED", "DEGRADE", "RECOVER",
        "REVISION_PERSISTED", "EXPORT_GENERATED", "HEALTH_CHECK"
      ]
    },
    "run_id": { "type": "string" },
    "parent_event_id": { "type": ["string", "null"] },
    "timestamp": { "type": "string", "format": "date-time" },
    "layer": { "enum": ["shell", "application", "core", "adapter"] },
    "component": { "type": "string" },
    "duration_ms": { "type": ["integer", "null"] },
    "attempt": { "type": ["integer", "null"] },
    "input_hash": { "type": ["string", "null"] },
    "output_hash": { "type": ["string", "null"] },
    "provider_id": { "type": ["string", "null"] },
    "model_id": { "type": ["string", "null"] },
    "failure_code": { "type": ["string", "null"] },
    "verdict": { "type": ["string", "null"] },
    "schema_version": { "type": "string" }
  }
}
```

Fingerprint algorithms, retention, and access policy for hashes are defined in `PRIVACY_AND_SECURITY.md` and enforced at the sink.

## Tenancy protocol

**Target state — not built.** Multi-tenancy has no phase in `IMPLEMENTATION_PLAN.md` and is undecided target-state work (see also `PRIVACY_AND_SECURITY.md`). Not one of the 18 schemas under `contracts/` is `tenant-context.schema.json`; `tenant_context_ref` is not a field on `GenerationRequest`; and "tenant" appears in no file under `application/src`, `core/src`, or `adapters/storage-db`. What follows is the design a hosted deployment would need to satisfy, not a contract that exists today.

### TenantContext

Resolved by the Application layer from the `tenant_context_ref` on a `GenerationRequest` or `PipelineCommand`. Required in the hosted deployment shape; null in the local-proxy shape, which has a single implicit tenant.

The reference, not the context, crosses the provider boundary — a provider adapter receives an opaque `tenant_context_ref` for rate-limiting and usage attribution and never sees identity fields.

```json
{
  "$id": "https://promptnexus.dev/contracts/tenant-context/1.0.0",
  "type": "object",
  "required": ["tenant_id", "subject_id", "scopes"],
  "properties": {
    "tenant_id": { "type": "string" },
    "subject_id": { "type": "string" },
    "scopes": {
      "type": "array",
      "items": {
        "enum": ["pipeline:run", "revision:read", "revision:write",
                 "revision:delete", "revision:read_others", "export:generate"]
      }
    },
    "quota_ref": { "type": ["string", "null"] },
    "retention_policy_id": { "type": ["string", "null"] }
  }
}
```

Once built: authorization denials would return as a `ProviderFailure` with `category: "AUTH"` and a safe reason code, or as a validation failure on `PipelineCommand`, never as a raw provider or database error which can echo request content. Every `RevisionStore` operation would be scoped by `tenant_id`, so that supplying another tenant's `run_id` directly yields a not-found result rather than a denial that would confirm the run exists. None of this is implemented today (see the note at the top of this section).

## Capability registration

**Target state — not built, and not the mechanism `check:matrix` actually uses.** `CapabilityRegistration` appears nowhere in real code except a comment in `scripts/generate-capability-matrix.mjs` itself, which says a registration record "that nothing writes" would be needed to derive coverage this way — and explains why the generator doesn't: it instead reads which validators `test/contract-conformance.test.ts` actually exercises (see `ARCHITECTURE.md`'s documentation conventions). No `capability-registration.schema.json` exists among the 18 real contracts.

### CapabilityRegistration

Machine-readable declaration used by the capability-matrix generator.

```json
{
  "$id": "https://promptnexus.dev/contracts/capability-registration/1.0.0",
  "type": "object",
  "required": ["contract_id", "contract_version", "role", "implementation_id"],
  "properties": {
    "contract_id": { "type": "string" },
    "contract_version": { "type": "string" },
    "role": { "enum": ["producer", "consumer", "adapter"] },
    "implementation_id": { "type": "string" },
    "compatibility_range": { "type": "string" },
    "test_evidence_ref": { "type": "string" }
  }
}
```

## Versioning policy

- **Schema version** is the single source of truth (`$id` and the version segment).
- Additive (backward-compatible) changes bump the minor version.
- Breaking changes bump the major version and require a migration note in the contract’s changelog.
- Implementation versions (gate_version, core_build_hash, adapter build) are distinct from schema versions and are recorded in provenance fields.
- Consumers pin major versions. CI rejects an unsupported major.

## Contract stability rules (summary)

- No Core module or Adapter is written against an unmerged contract change.
- Shared contract-test suites assert behavioral parity for every implementation of a given protocol.
- The generated capability matrix fails the build on orphaned contracts, missing implementations, or missing test evidence.

## Schema inventory

<!-- BEGIN GENERATED: schema-inventory -->
All 18 schema files under `contracts/`, with the version from each `$id`.
Generated by `npm run docs:contracts`; `check:contracts` fails when it is not current.
**Described below** says whether this document has prose for it — most do not, and that is
recorded rather than implied.

| schema | version | described below |
|---|---|---|
| `audit-report` | 1.0.0 | — |
| `baseline` | 2.0.0 | — |
| `comparison` | 2.3.0 | — |
| `configuration` | 1.3.0 | — |
| `eval-case` | 2.0.0 | — |
| `eval-run` | 2.0.0 | — |
| `eval-suite` | 2.0.1 | — |
| `gate-result` | 1.3.0 | yes |
| `judge-verdict` | 1.2.0 | — |
| `judgement` | 1.0.0 | — |
| `observability-event` | 1.3.0 | yes |
| `pipeline-outcome` | 1.0.0 | yes |
| `promotion` | 1.0.0 | — |
| `provider-failure` | 1.1.1 | yes |
| `revision-entry` | 3.0.0 | yes |
| `routing-policy` | 1.0.0 | — |
| `run-manifest` | 2.0.0 | — |
| `technique-record` | 2.0.0 | yes |
<!-- END GENERATED: schema-inventory -->

## Ids described here with no schema file

Declared, not inferred. Left to inference, "no schema file" is indistinguishable from "schema
file missing", so `check:contracts` requires that every id in the prose either match a real
schema's `$id` or appear below.

**TypeScript-only — real, but only in `contracts/index.ts`:**

<!-- BEGIN DECLARED: no-schema-file -->
- `generation-request` — `GenerationRequest` in `contracts/index.ts`
- `generation-result` — `GenerationResult` in `contracts/index.ts`
- `pipeline-command` — `PipelineCommand` in `contracts/index.ts`
- `provider-health` — `ProviderHealth` in `contracts/index.ts`
- `tenant-context` — target state. No schema file and no TypeScript interface.
- `capability-registration` — target state. No schema file and no TypeScript interface.
<!-- END DECLARED: no-schema-file -->

The last two are a different claim from the first four and the list does not let them hide
behind it: `TenantContext` and `CapabilityRegistration` are described in this document and
implemented nowhere. `CAPABILITY_MATRIX.md` has no `Producers`/`Consumers` columns for the
same reason — nothing writes a registration record.

## How this document is kept honest

Every other derived document here has a guard. This one had none until 6 September 2026, and
had drifted to describing 6 of 18 schemas with three of those at wrong versions.

- `npm run docs:contracts` regenerates the inventory table above.
- `npm run check:contracts` fails when the table is stale, when an inline
  `contracts/<name>/<version>` disagrees with that schema's `$id`, or when an id names no
  schema file and is not declared above.

The prose is **not** generated, deliberately. Most of this file is reasoning that no schema
contains — why effects never appear in Core schemas, what a binding surface is, why
`verification_status` is three-valued. Generating the file would delete the part worth having
in order to guard the part that drifts. A version lives in the schema's `$id` and nowhere
else; where this document and a schema disagree, this document is wrong.

## Relationship to other documents

- Runtime ownership of effects is defined in `ARCHITECTURE.md`.
- Security and tenancy constraints that affect hosted contracts are stated in `PRIVACY_AND_SECURITY.md`.
- Scaffolding generators and CI stages that enforce these contracts are described in `DEVELOPMENT_AND_TESTING.md` and `CONTRIBUTING.md`.
