# Revisions & Exports

## Revision model

Every pipeline run produces a sequence of `RevisionEntry` records (see `CONTRACTS.md`), one per stage execution, persisted by the Application layer via whichever `RevisionStore` adapter is configured (`storage-local` or `storage-db`).

A `RevisionEntry` carries more than a snapshot of output. The fields that make the behavior on this page implementable are:

| Field | What it enables |
|---|---|
| `revision_id`, `parent_revision_ids` | Lineage — which downstream revisions a given edit invalidates |
| `freshness` (`FRESH` \| `STALE`) | Export eligibility, separately from whether the stage succeeded |
| `status` (`SUCCEEDED` \| `DEMO` \| `FAILED` \| `CANCELLED`) | Execution result, including whether output came from demo mode |
| `stage_attempt` | Which of several reruns is the current one |
| `execution_provenance` | `core_build_hash`, contract versions, provider/model fingerprint, config fingerprint |
| `input_ref`, `output_ref` | Pointers to retained content, so events and lineage never embed bodies |
| `retention_scope` | `LOCAL_BUNDLE` \| `DB` \| `EXPORT` — what the retention bound means for this entry |

### Retention

- **`storage-local`**: bounded history of the **eight most recent completed run bundles**. A run bundle is every `RevisionEntry` belonging to one `run_id`, retained or evicted as a unit. Typed-DELETE confirmation before clearing.
- **`storage-db`**: unbounded, multi-user, queryable by `run_id`, user, or date. **This is new work, not a port.** The GitHub product's Drizzle schema (MySQL, not Postgres) defines two tables — `users` and `promptAssets` — and has no runs or revisions table. What it contributes is the migration setup, connection handling, and multi-user patterns; the revision schema itself has to be designed, and it should land as a reviewed migration before either storage adapter is built.

The local bound is deliberately counted in **run bundles, not individual entries**. An earlier revision of this document specified eight entries per prompt lineage, inherited from the final package's design — but a fresh run produces one entry per stage before any rerun or edit, so that bound made a complete run impossible to persist. The pipeline was nine stages when the conflict was found and is now eleven, which is the point: **any entry-based cap is a hostage to stage count.** Bounding by bundle preserves the intent — a small, predictable local history — while guaranteeing that a retained run is retained intact however many stages it has.

## Stale-result invalidation

If a stage's output is edited or rerun, every downstream stage's `RevisionEntry` has its `freshness` set to `STALE` rather than being silently left inconsistent. Staleness cascades along `parent_revision_ids`, so it is derived from recorded lineage rather than from stage ordering assumptions. A stale entry is visually distinct in `pipeline-ui` and excluded from exports unless explicitly included with a warning.

Note that `freshness` and `status` are independent: a revision can be `SUCCEEDED` *and* `STALE` (it ran fine, but its input has since changed), and that distinction is what lets exports exclude the second condition without discarding the first.

## Export formats

| Format | Use case |
|---|---|
| TXT | Plain compiled prompt, no metadata |
| JSON | Full `RevisionEntry` set, machine-readable, includes `run_id` and all `GateResult`s |
| MD + YAML | Human-readable prompt body with a YAML frontmatter block of metadata |
| Comparison JSON/MD/HTML | Side-by-side diff between two revisions or two full runs |
| Print/PDF | Formatted for offline reading, byte-reproducible export path (see `RELEASE_OPERATIONS.md`) |

## What an export's provenance does and does not guarantee

Every export includes the `run_id` and the `execution_provenance` block of each included revision — Core build hash (gate set + catalog version), contract versions, provider/model fingerprint, and config fingerprint. This makes an exported artifact traceable back to exactly what verified it.

Three distinct guarantees are involved, and they are not interchangeable:

| Claim | What backs it | Holds? |
|---|---|---|
| **Build reproducibility** | Core source + pinned toolchain → identical artifact hash | Yes — verified in CI (`RELEASE_OPERATIONS.md`) |
| **Deterministic export reproducibility** | Canonical data order + renderer configuration → identical bytes | Yes — for catalog and PDF exports |
| **Deterministic gate results** | Normalized input + gate version → identical `GateResult` | Yes — Core is pure, no clock or randomness |
| **Model-output provenance** | Provider/model/version identity, settings, input fingerprints, retained response reference | Yes, under the applicable retention policy |
| **Model-output replay** | Re-running the request reproduces the same content | **No** — not from a Core hash |

A Core version hash identifies the gate set and catalog that *evaluated* an output. It does not reproduce that output: provider and model versions, sampling, generation settings, input normalization, and retries all affect what a model returns. Re-running an export's request may produce different content while every gate verdict stays reproducible, and that is the expected behavior, not a defect. Where genuine replay is required, it depends on the retained response referenced by `output_ref` and on a stated retention policy — never on the hash alone.

## Diffing

`core/diff/` (pure, dependency-free) computes the comparison used by both the comparison export and the in-UI revision viewer — one implementation, not one per Shell.
