# Privacy & Security

## Data handling rules (apply to every layer)

1. **No prompt bodies in logs, ever.** Enforced in two layers (see `OBSERVABILITY.md`): call sites forward an error's type rather than its message, and `application/src/redaction.ts` wraps every sink so no `emit` can bypass the check. Until sweep fourteen this claim named `observability/sink.ts`, a module that has never existed — the property was a per-call discipline after all, and it was broken on the error path. The guarantee is real now and bounded: it catches a body shared verbatim with the run being logged, not a paraphrase or a body from another run.
2. **No provider API keys reach the browser**, regardless of which provider adapter is configured. Both `provider-local-proxy` and `provider-hosted-server` hold keys server-side only.
3. **Storage adapters are the only place user prompt content persists.** `adapters/storage-local` (bounded to the 8 most recent complete run bundles; the typed-DELETE confirmation described in earlier drafts is **not built**) and `adapters/storage-db` both implement `RevisionStore` and neither leaks content to the observability spine beyond hashes. ~~The engine is MySQL because that is what the inherited Drizzle setup uses~~ — **corrected 5 September 2026**: `storage-db` is SQLite via `node:sqlite`, built fresh rather than porting the inherited MySQL/Drizzle schema (PR [#115](https://github.com/hynix666/nexusprompt/pull/115)); earlier drafts said Postgres, then MySQL, and both were wrong about the same thing for the same reason — describing the source instead of what got built.
4. **Fingerprints in events are keyed, not bare digests.** An unkeyed hash of a short or templated prompt is correlatable and dictionary-attackable by anyone holding the event stream. `input_hash`/`output_hash` use a deployment-scoped key held by the Application layer's event port (see `OBSERVABILITY.md`).

## Tenancy, identity, and retention

The hosted deployment shape makes multi-tenancy claims, so the constraints below are contractual, not operational convention — an adapter that cannot express them cannot implement the port.

| Requirement | Mechanism |
|---|---|
| Tenant scope on every request | `tenant_context_ref` on `GenerationRequest`; the Application resolves it and refuses an unscoped request in the hosted shape |
| Authorization outcome | Denials surface as a typed `ProviderFailure` with category `AUTH` and a safe reason code — never as raw provider or DB errors |
| Storage isolation | `storage-db` scopes every `RevisionStore` operation by tenant; `getRun` and `listRecent` cannot return another tenant's `run_id` even when one is supplied directly |
| Deletion | **Target state — not built.** `delete(run_id, confirmation)` exists in no port and no adapter: `RevisionStore` has `append`, `getRun`, `listRecent` and `markStale`, and `ContentStore` has no delete by design. What DOES exist is reclamation, which is a different thing — see below |
| Retention | Set per deployment and stated per entry via `retention_scope` (`LOCAL_BUNDLE`, `DB`, `EXPORT`). Event retention is configured separately from content retention |
| Audit access | Reading another user's revision content is an authorized operation that emits its own event; the trace viewer shows hashes only and needs no content access |

### What reclamation is, and what it is not — as of sweep thirteen

Bundle eviction reclaims orphaned content now. It did not before: `storage-local` retained
eight bundles and evicted the ninth whole while content lived on its own lifetime, so twelve
runs left **eight bundles and 20 of 60 content files orphaned** — bounded in bundles, unbounded
in bytes, which is the number that fills a disk.

`ContentStore.sweep(live)` reclaims everything no live ref names. It takes the live SET rather
than a ref to remove, and that shape is the guarantee: content is addressed by hash, so one file
can back many runs, and a `delete(ref)` primitive could not tell whether some other run still
cites those bytes. It would either corrupt that run or leak. Recomputing the live set from the
surviving bundles is sharing-safe without a reference count.

**Reclamation is not deletion, and must not be read as an erasure guarantee.** It removes what
nothing points at. It offers no way to erase content a surviving run still cites, which is what
a subject-erasure request actually asks for — and because content deduplicates by hash, two
users submitting identical text share one file, so erasure for one is not a file removal at all.

A real `delete(run_id, confirmation)` needs three things this repository does not have: a port
method, a decision about what erasure means for deduplicated content shared across runs, and an
authoritative enumeration of stored runs. `listRecent` is a *recent* listing with a limit, not
an enumeration — the reclaim above refuses to run rather than trust it when the just-completed
run is absent from what it reports, because a sweep over an incomplete live set deletes content
that is still cited.

In the local-proxy shape there is a single implicit tenant, and `tenant_context_ref` is null. The isolation rules above are still enforced by `storage-db` when it is configured, so switching deployment shape never silently relaxes them.

## Threat model summary

| Threat | Mitigation | Where |
|---|---|---|
| Provider key exfiltration via browser | Keys never sent to client in either provider adapter | `PROVIDERS.md` |
| Path traversal via provider URL construction | Path-tail validation (inherited from filesZ's proxy) | `adapters/provider-local-proxy` |
| Prompt-injection via retrieved/untrusted content | `RAG_SHIELD_GAP`, `DELIMITER_ENTROPY`, `QUTM_CEILING` gates | `GATES_REFERENCE.md` |
| Secret leakage in a compiled prompt | `SECRET_LEAK_SCAN` gate | `GATES_REFERENCE.md` |
| Log-based data exposure | Structural redaction at the sink, not per-call | `OBSERVABILITY.md` |
| Oversized-request abuse | `Content-Length` pre-check | `adapters/provider-local-proxy` |
| Unauthorized non-loopback exposure of local proxy | Explicit flag required, logged as security-relevant | `adapters/provider-local-proxy` |
| Multi-tenant data bleed | Tenant-scoped `RevisionStore` operations and per-user/org rate limiting, enforced at the contract level | Tenancy section above |
| Fingerprint correlation across runs or deployments | Keyed digests with a deployment-scoped key | `OBSERVABILITY.md` |

## Review cadence

- **Monthly**: dependency/security audit (`npm audit` / `pip-audit`) plus manual review of both provider adapters and the Application layer's key-custody, tenant-scoping, and redaction paths.
- **Every PR touching an adapter**: contract test suite must pass, including the 27-assertion security baseline inherited from the v5 standalone proxy.
- **Every release**: this document is checked against the merged system's actual data flows before sign-off (see `RELEASE_OPERATIONS.md`).

## Reporting

Security-relevant findings should be filed against `adapters/` or `application/` first — Core has no network, storage, or event-sink access and is not a meaningful attack surface by construction (see `ARCHITECTURE.md` → dependency rules and [ADR-0005](./0005-application-orchestration-boundary.md)). The Application layer is where key custody, tenant scoping, retry behavior, and redaction are actually exercised, so it is in scope for the same review cadence as the adapters.
