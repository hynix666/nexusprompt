# Technique Catalog

`core/catalog/` holds 172 prompt-engineering technique records, imported as static, schema-validated data from filesZ's `promptnexus-catalog-v1.20.0` package (schema version 1.3.0).

## What's in a record

See `TechniqueRecord` in `CONTRACTS.md`. The catalog's core discipline is that a technique is never just described — its epistemic standing is recorded alongside it, so the catalog can be audited rather than trusted blindly. Three fields carry that:

- **`verification_status`** — whether the technique's effect is checkable at all, and how: `verifier-checkable` (130 records), `unverifiable-by-text` (34), or `judge-checkable` (8).
- **`source_audit`** — per-field verification state, e.g. `{"description": "unverified", "pitfalls": "unverified"}`. This is where "has anyone actually confirmed this" is recorded, separately from whether confirmation is possible.
- **`primary_source`** — a structured citation with authors, year, title, and venue, not a free-text string. `secondary_sources` holds the rest.

That the 34 `unverifiable-by-text` records are marked as such, rather than quietly omitted or asserted anyway, is the property worth preserving in the port.

## Formats

The catalog is validated and exportable in four formats, all generated from the same source-of-truth JSON:
- **JSON** — canonical, used by Core at build time
- **XML** — validated against the inherited XSD 1.3.0 schema
- **YAML** — for human review/diffing
- **PDF** — byte-reproducible export (ReportLab invariant mode), used for offline/print reference

## CI validation

`catalog/tools/` (ported unchanged from filesZ) runs on every PR touching catalog data:
- Schema validation (every record validates against `TechniqueRecord` and the XSD)
- Provenance completeness check on records past a staleness threshold. This **reports, it does not block** — a catalog-wide re-verification sweep would otherwise gate unrelated PRs, and `TECHNIQUE_PROVENANCE_UNVERIFIED` already surfaces the same condition to the user at lint time
- Byte-reproducibility check for the PDF export

## Adding a technique

A new record requires a `primary_source` at creation time — there is no path to add a technique without a citation — and its `source_audit` fields start at `unverified` until a reviewer confirms them against that source.

A `scripts/new-technique.py` generator to enforce this mechanically is **planned, not built**; it exists in no source archive. The existing `scripts/build_catalog.py` and the `promptnexus_hygiene` toolchain handle building and validating the catalog, not authoring new entries.

## Relationship to gates

**None.** The gate set and the technique catalog are independent in every source: no gate reads catalog data, and there is no `catalog/tools/gate-extensions/` directory. An earlier revision of this document described two catalog-linked gates checking technique markers and provenance; neither exists (see [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md)).

A gate that verifies a prompt claiming technique *X* actually exhibits *X*'s structural markers is a reasonable thing to want, and the catalog's `usage_templates` field would support it. It would be new work requiring its own ADR — and it would be the first place Core's gates and catalog modules interact, which is a boundary decision, not an implementation detail.
