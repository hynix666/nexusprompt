"""Normalization passes.

Every pass is a pure function ``(Catalog, ...) -> (Catalog, list[Change])``.
Nothing mutates in place, nothing writes to disk, nothing reads the clock. The
caller composes the passes and owns I/O, which keeps each transform testable in
isolation and makes the whole pipeline reproducible: same input plus same
policy always yields the same bytes and the same ledger.

Passes run in a fixed order because they are not commutative -- merging must
precede reference rewriting so that references to an absorbed entry are
redirected, and metadata is synchronised last so it reflects the final state.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final, Iterable, Sequence

from . import additions, claim_corrections, content_corrections, policy, schema
from .model import Catalog, ParseNotes, SourceAudit, Technique

__all__ = ["Change", "NormalizationResult", "normalize"]


@dataclass(frozen=True, slots=True)
class Change:
    """One auditable edit. ``kind`` groups changes in the report."""

    kind: str
    technique_id: str
    field: str
    before: str
    after: str
    rationale: str

    def as_dict(self) -> dict[str, str]:
        return {
            "kind": self.kind,
            "technique_id": self.technique_id,
            "field": self.field,
            "before": self.before,
            "after": self.after,
            "rationale": self.rationale,
        }


@dataclass(frozen=True, slots=True)
class NormalizationResult:
    catalog: Catalog
    changes: tuple[Change, ...]
    manual_actions: tuple[str, ...]

    def changes_by_kind(self) -> dict[str, list[Change]]:
        grouped: dict[str, list[Change]] = {}
        for change in self.changes:
            grouped.setdefault(change.kind, []).append(change)
        return grouped


def _dedupe(values: Iterable[str]) -> tuple[str, ...]:
    """Order-preserving de-duplication; empty strings dropped."""
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return tuple(result)


# --------------------------------------------------------------------------
# Pass 1 - merge duplicate entries
# --------------------------------------------------------------------------


def _merge_pair(survivor: Technique, absorbed: Technique) -> Technique:
    """Union list fields; survivor wins every scalar; absorbed id kept as alias."""
    templates = list(survivor.usage_templates)
    known_template_ids = {t.template_id for t in templates}
    for template in absorbed.usage_templates:
        if template.template_id not in known_template_ids:
            templates.append(template)
            known_template_ids.add(template.template_id)

    secondary = list(survivor.secondary_sources)
    for source in absorbed.secondary_sources:
        if source not in secondary:
            secondary.append(source)

    return replace(
        survivor,
        aliases=_dedupe(
            [*survivor.aliases, *absorbed.aliases, absorbed.id, absorbed.name]
        ),
        when_to_use=_dedupe([*survivor.when_to_use, *absorbed.when_to_use]),
        when_not_to_use=_dedupe([*survivor.when_not_to_use, *absorbed.when_not_to_use]),
        known_pitfalls=_dedupe([*survivor.known_pitfalls, *absorbed.known_pitfalls]),
        related_techniques=_dedupe(
            [*survivor.related_techniques, *absorbed.related_techniques]
        ),
        tags=_dedupe([*survivor.tags, *absorbed.tags]),
        corpus_file=survivor.corpus_file or absorbed.corpus_file,
        secondary_sources=tuple(secondary),
        usage_templates=tuple(templates),
    )


def merge_duplicates(
    catalog: Catalog, rules: Sequence[policy.MergeRule]
) -> tuple[Catalog, list[Change], dict[str, str]]:
    """Apply merge rules. Returns the catalog, the ledger, and absorbed->survivor."""
    changes: list[Change] = []
    redirects: dict[str, str] = {}
    techniques = {t.id: t for t in catalog.techniques}
    order = [t.id for t in catalog.techniques]

    for rule in rules:
        survivor = techniques.get(rule.survivor)
        absorbed = techniques.get(rule.absorbed)
        if survivor is None or absorbed is None:
            # A rule whose targets are already gone is a no-op, not an error:
            # normalization must be idempotent.
            continue
        techniques[rule.survivor] = _merge_pair(survivor, absorbed)
        del techniques[rule.absorbed]
        order.remove(rule.absorbed)
        redirects[rule.absorbed] = rule.survivor
        changes.append(
            Change(
                kind="merge",
                technique_id=rule.survivor,
                field="<entry>",
                before=rule.absorbed,
                after=rule.survivor,
                rationale=rule.rationale,
            )
        )

    merged = replace(catalog, techniques=tuple(techniques[i] for i in order))
    return merged, changes, redirects


# --------------------------------------------------------------------------
# Pass 2 - cross-reference repair
# --------------------------------------------------------------------------


def rewrite_references(
    catalog: Catalog,
    redirects: dict[str, str],
    rewrites: dict[str, policy.Decision],
    drops: dict[str, policy.Decision] | None = None,
    *,
    strip_dangling: bool = False,
) -> tuple[Catalog, list[Change]]:
    """Redirect merged ids, apply explicit rewrites and drops, remove self- and
    duplicate refs."""
    drops = drops or {}
    changes: list[Change] = []
    valid_ids = catalog.ids()
    updated: list[Technique] = []

    for technique in catalog.techniques:
        resolved: list[str] = []
        for reference in technique.related_techniques:
            target = reference
            if target in drops:
                changes.append(
                    Change(
                        kind="reference-dropped",
                        technique_id=technique.id,
                        field="related_techniques",
                        before=reference,
                        after="",
                        rationale=drops[target].rationale,
                    )
                )
                continue
            if target in redirects:
                target = redirects[target]
                changes.append(
                    Change(
                        kind="reference-redirect",
                        technique_id=technique.id,
                        field="related_techniques",
                        before=reference,
                        after=target,
                        rationale="Target was merged into the surviving entry.",
                    )
                )
            elif target in rewrites and target not in valid_ids:
                # A rewrite repairs a reference that resolves to nothing. Once
                # the target exists as a real record, the reference is correct
                # and rewriting it would silently repoint a valid citation.
                decision = rewrites[target]
                target = decision.to
                changes.append(
                    Change(
                        kind="reference-rewrite",
                        technique_id=technique.id,
                        field="related_techniques",
                        before=reference,
                        after=target,
                        rationale=decision.rationale,
                    )
                )
            if target == technique.id:
                changes.append(
                    Change(
                        kind="reference-self-removed",
                        technique_id=technique.id,
                        field="related_techniques",
                        before=reference,
                        after="",
                        rationale="Merging produced a self-reference.",
                    )
                )
                continue
            if strip_dangling and target not in valid_ids:
                changes.append(
                    Change(
                        kind="reference-dangling-removed",
                        technique_id=technique.id,
                        field="related_techniques",
                        before=reference,
                        after="",
                        rationale="--strip-dangling: no entry with this id exists.",
                    )
                )
                continue
            resolved.append(target)

        deduped = _dedupe(resolved)
        if len(deduped) != len(resolved):
            changes.append(
                Change(
                    kind="reference-deduplicated",
                    technique_id=technique.id,
                    field="related_techniques",
                    before=", ".join(resolved),
                    after=", ".join(deduped),
                    rationale="Merging produced duplicate references.",
                )
            )
        updated.append(replace(technique, related_techniques=deduped))

    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 3 - vocabulary remapping
# --------------------------------------------------------------------------


def _remap_field(
    catalog: Catalog,
    field_name: str,
    mapping: dict[str, policy.Decision],
    kind: str,
) -> tuple[Catalog, list[Change]]:
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        current = getattr(technique, field_name)
        decision = mapping.get(current)
        if decision is None:
            updated.append(technique)
            continue
        changes.append(
            Change(
                kind=kind,
                technique_id=technique.id,
                field=field_name,
                before=current,
                after=decision.to,
                rationale=decision.rationale,
            )
        )
        updated.append(replace(technique, **{field_name: decision.to}))
    return replace(catalog, techniques=tuple(updated)), changes


def remap_determinism(
    catalog: Catalog, mapping: dict[str, policy.Decision]
) -> tuple[Catalog, list[Change]]:
    """``determinism`` lives on templates, so it needs its own walk."""
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        templates = []
        for template in technique.usage_templates:
            decision = mapping.get(template.determinism)
            if decision is None:
                templates.append(template)
                continue
            changes.append(
                Change(
                    kind="vocabulary-determinism",
                    technique_id=technique.id,
                    field=f"usage_templates[{template.template_id}].determinism",
                    before=template.determinism,
                    after=decision.to,
                    rationale=decision.rationale,
                )
            )
            templates.append(replace(template, determinism=decision.to))
        updated.append(replace(technique, usage_templates=tuple(templates)))
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 4 - per-entry schema stamp
# --------------------------------------------------------------------------


def stamp_schema_version(
    catalog: Catalog, schema_version: str
) -> tuple[Catalog, list[Change]]:
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        if technique.schema_version == schema_version:
            updated.append(technique)
            continue
        changes.append(
            Change(
                kind="schema-stamp",
                technique_id=technique.id,
                field="schema_version",
                before=technique.schema_version,
                after=schema_version,
                rationale="Per-entry stamp must match the catalog schema version.",
            )
        )
        updated.append(replace(technique, schema_version=schema_version))
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 5 - metadata synchronisation
# --------------------------------------------------------------------------


def sync_metadata(
    catalog: Catalog, *, catalog_version: str | None, generated_at: str | None
) -> tuple[Catalog, list[Change]]:
    """Make ``<catalog_metadata>`` agree with the root attributes and reality.

    The root attributes are treated as authoritative for version and timestamp
    (they carry the newer values), unless the caller overrides them. Entry count
    and the category register are derived from the techniques themselves, so
    they cannot drift again.
    """
    changes: list[Change] = []
    metadata = catalog.metadata

    resolved_version = catalog_version or catalog.catalog_version or metadata.catalog_version
    resolved_generated = generated_at or catalog.generated_at or metadata.generated_at
    # The metadata block carries a date, the root attribute a dateTime; the
    # published XSD types them that way, so the sync preserves the distinction
    # instead of copying the timestamp across.
    resolved_generated_date = resolved_generated[:10]
    resolved_count = str(len(catalog.techniques))
    resolved_note = policy.SOURCE_NOTE or metadata.source_note
    used_categories = tuple(sorted({t.category for t in catalog.techniques}))

    for label, before, after in (
        ("catalog_version", metadata.catalog_version, resolved_version),
        ("generated_at", metadata.generated_at, resolved_generated_date),
        ("entry_count", metadata.entry_count, resolved_count),
        ("schema_version", metadata.schema_version, schema.SCHEMA_VERSION),
        ("source_note", metadata.source_note, resolved_note),
    ):
        if before != after:
            changes.append(
                Change(
                    kind="metadata-sync",
                    technique_id="<catalog_metadata>",
                    field=label,
                    before=before,
                    after=after,
                    rationale="Metadata block disagreed with the authoritative value.",
                )
            )

    for added in sorted(set(used_categories) - set(metadata.categories)):
        decision = policy.CATEGORIES_TO_REGISTER.get(added)
        changes.append(
            Change(
                kind="category-register",
                technique_id="<catalog_metadata>",
                field="categories",
                before="",
                after=added,
                rationale=(
                    decision.rationale
                    if decision
                    else "Category is in use but was never declared."
                ),
            )
        )
    for removed in sorted(set(metadata.categories) - set(used_categories)):
        changes.append(
            Change(
                kind="category-deregister",
                technique_id="<catalog_metadata>",
                field="categories",
                before=removed,
                after="",
                rationale="Declared category has no members after remapping.",
            )
        )

    for label, before, after in (
        ("catalog_version", catalog.catalog_version, resolved_version),
        ("generated_at", catalog.generated_at, resolved_generated),
        ("entry_count", catalog.entry_count, resolved_count),
        ("schema_version", catalog.schema_version, schema.SCHEMA_VERSION),
    ):
        if before != after:
            changes.append(
                Change(
                    kind="metadata-sync",
                    technique_id="<root>",
                    field=label,
                    before=before,
                    after=after,
                    rationale="Root attribute did not match the derived value.",
                )
            )

    synced = replace(
        catalog,
        schema_version=schema.SCHEMA_VERSION,
        catalog_version=resolved_version,
        generated_at=resolved_generated,
        entry_count=resolved_count,
        metadata=replace(
            metadata,
            schema_version=schema.SCHEMA_VERSION,
            catalog_version=resolved_version,
            generated_at=resolved_generated_date,
            entry_count=resolved_count,
            categories=used_categories,
            source_note=resolved_note,
        ),
    )
    return synced, changes



# --------------------------------------------------------------------------
# Pass 0 - author the entries that unresolvable references point at
# --------------------------------------------------------------------------


def add_missing_entries(
    catalog: Catalog, entries: Sequence[Technique]
) -> tuple[Catalog, list[Change]]:
    """Append authored entries whose ids are not already present.

    Runs first so that later reference repair can resolve against them. Skipping
    an entry that already exists keeps the pass idempotent.
    """
    changes: list[Change] = []
    existing = set(catalog.ids())
    existing_arxiv = {
        t.primary_source.arxiv_id
        for t in catalog.techniques
        if t.primary_source and t.primary_source.arxiv_id
    }
    appended: list[Technique] = []
    for entry in entries:
        if entry.id in existing:
            continue
        # A catalog that already covers the paper under a different id does not
        # need a second record for it. Skipping by source, not just by id, is
        # what stops this pass from manufacturing the duplicates it exists to
        # avoid.
        arxiv = entry.primary_source.arxiv_id if entry.primary_source else ""
        if arxiv and arxiv in existing_arxiv:
            changes.append(
                Change(
                    kind="entry-skipped",
                    technique_id=entry.id,
                    field="<entry>",
                    before="<authored>",
                    after="<not added>",
                    rationale=(
                        f"arXiv {arxiv} is already covered by an existing "
                        "record; adding this would duplicate it."
                    ),
                )
            )
            continue
        appended.append(entry)
        existing.add(entry.id)
        changes.append(
            Change(
                kind="entry-added",
                technique_id=entry.id,
                field="<entry>",
                before="<absent>",
                after=entry.primary_source.title if entry.primary_source else entry.name,
                rationale=additions.ADDITION_RATIONALE,
            )
        )
    if not appended:
        return catalog, changes
    return replace(catalog, techniques=catalog.techniques + tuple(appended)), changes


# --------------------------------------------------------------------------
# Pass 6 - verified source-record corrections
# --------------------------------------------------------------------------


def apply_source_corrections(
    catalog: Catalog, corrections: dict[str, policy.SourceCorrection]
) -> tuple[Catalog, list[Change]]:
    """Replace wrong or placeholder ``primary_source`` fields with verified ones.

    Only the fields named in the correction are touched, and a change is
    recorded per field, so the ledger shows exactly what was overwritten.
    """
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        correction = corrections.get(technique.id)
        source = technique.primary_source
        if correction is None or source is None:
            updated.append(technique)
            continue
        edits: dict[str, str] = {}
        for field_name, new_value in correction.fields.items():
            current = getattr(source, field_name)
            if current == new_value:
                continue
            edits[field_name] = new_value
            changes.append(
                Change(
                    kind="source-correction",
                    technique_id=technique.id,
                    field=f"primary_source.{field_name}",
                    before=current or "<empty>",
                    after=new_value,
                    rationale=f"{correction.rationale} Verified via: {correction.verified_via}.",
                )
            )
        if not edits:
            updated.append(technique)
            continue
        updated.append(replace(technique, primary_source=replace(source, **edits)))
    return replace(catalog, techniques=tuple(updated)), changes



# --------------------------------------------------------------------------
# Pass 6b - arXiv-verified source records
# --------------------------------------------------------------------------

#: Written by ``verify_sources.py`` from the live arXiv API, with provenance.
#: Kept as data rather than as hand-written policy because it is machine-derived
#: and re-runnable: a reviewer re-runs the script rather than trusting the file.
VERIFIED_SOURCES_PATH: Final[Path] = (
    Path(__file__).resolve().parent / "verified_sources.json"
)


def load_verified_sources(path: Path | None = None) -> dict[str, dict[str, str]]:
    """Load the verified source table. Missing file means no corrections."""
    target = path or VERIFIED_SOURCES_PATH
    if not target.is_file():
        return {}
    payload = json.loads(target.read_text(encoding="utf-8"))
    return payload.get("records", {})


def apply_verified_sources(
    catalog: Catalog, verified: dict[str, dict[str, str]]
) -> tuple[Catalog, list[Change]]:
    """Replace source fields with values read from the publisher of record.

    Applies only to records the table names, and only to fields that actually
    differ, so the ledger shows exactly what the verification changed.
    """
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        entry = verified.get(technique.id)
        source = technique.primary_source
        if entry is None or source is None:
            updated.append(technique)
            continue
        edits: dict[str, str] = {}
        # year and venue are owned by policy.SOURCE_CORRECTIONS, not by arXiv.
        for field_name in ("authors", "title", "arxiv_id", "url"):
            if field_name not in entry:
                continue
            new_value = str(entry[field_name])
            if str(getattr(source, field_name)) == new_value:
                continue
            edits[field_name] = new_value
            changes.append(
                Change(
                    kind="source-verified",
                    technique_id=technique.id,
                    field=f"primary_source.{field_name}",
                    before=str(getattr(source, field_name)) or "<empty>",
                    after=new_value,
                    rationale="Value read from the live arXiv record for this paper.",
                )
            )
        updated.append(
            replace(technique, primary_source=replace(source, **edits))
            if edits
            else technique
        )
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 7 - template repairs
# --------------------------------------------------------------------------


def apply_template_variable_additions(
    catalog: Catalog, additions_by_template: dict[str, tuple]
) -> tuple[Catalog, list[Change]]:
    """Declare placeholders that a template body uses but never declared."""
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        templates = []
        for template in technique.usage_templates:
            extra = additions_by_template.get(template.template_id)
            if not extra:
                templates.append(template)
                continue
            declared = {v.name for v in template.variables}
            missing = tuple(v for v in extra if v.name not in declared)
            if not missing:
                templates.append(template)
                continue
            for variable in missing:
                changes.append(
                    Change(
                        kind="template-variable-declared",
                        technique_id=technique.id,
                        field=f"usage_templates[{template.template_id}].variables",
                        before="<undeclared>",
                        after=variable.name,
                        rationale=(
                            "Placeholder is used in the template body; its "
                            "meaning is unambiguous from context."
                        ),
                    )
                )
            templates.append(
                replace(template, variables=template.variables + missing)
            )
        updated.append(replace(technique, usage_templates=tuple(templates)))
    return replace(catalog, techniques=tuple(updated)), changes


def canonicalize_template_ids(catalog: Catalog) -> tuple[Catalog, list[Change]]:
    """Rewrite ``template_id`` to the ``<technique-id>--<slug>`` convention.

    Breaking change for anything that references a template by id, which is why
    every rename is recorded. The alternative -- leaving 15 ids that encode an
    abbreviation of their owner -- makes template ids unresolvable without a
    lookup table.
    """
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        prefix = technique.id + schema.TEMPLATE_ID_SEPARATOR
        templates = []
        for template in technique.usage_templates:
            if template.template_id.startswith(prefix):
                templates.append(template)
                continue
            _, separator, slug = template.template_id.partition(
                schema.TEMPLATE_ID_SEPARATOR
            )
            if not separator or not slug:
                slug = template.template_id
            new_id = prefix + slug
            changes.append(
                Change(
                    kind="template-id-canonicalized",
                    technique_id=technique.id,
                    field="usage_templates.template_id",
                    before=template.template_id,
                    after=new_id,
                    rationale=(
                        "template_id must be derivable from the technique id; "
                        "the old value encoded an abbreviation of it."
                    ),
                )
            )
            templates.append(replace(template, template_id=new_id))
        updated.append(replace(technique, usage_templates=tuple(templates)))
    return replace(catalog, techniques=tuple(updated)), changes




# --------------------------------------------------------------------------
# Pass 5d - replace prose that describes a different technique
# --------------------------------------------------------------------------


def apply_content_replacements(
    catalog: Catalog, replacements: dict[str, Technique]
) -> tuple[Catalog, list[Change]]:
    """Swap the body of a record whose prose described the wrong technique.

    The record's id, status, corpus_file and primary_source are kept -- the
    citation was already verified and nothing should have to re-resolve a
    cross-reference because prose changed. Replacement cross-references are
    filtered to ids this catalog has, so a rewrite cannot introduce a dangling
    link.
    """
    changes: list[Change] = []
    valid_ids = catalog.ids()
    updated: list[Technique] = []
    for technique in catalog.techniques:
        replacement = replacements.get(technique.id)
        if replacement is None or technique.description == replacement.description:
            updated.append(technique)
            continue
        related = tuple(
            r for r in replacement.related_techniques
            if r in valid_ids and r != technique.id
        )
        dropped = [r for r in replacement.related_techniques if r not in valid_ids]
        updated.append(
            replace(
                replacement,
                id=technique.id,
                status=technique.status,
                corpus_file=technique.corpus_file,
                primary_source=technique.primary_source,
                schema_version=technique.schema_version,
                related_techniques=related,
            )
        )
        note = content_corrections.REPLACEMENT_NOTES.get(technique.id, "")
        changes.append(
            Change(
                kind="content-replaced",
                technique_id=technique.id,
                field="<body>",
                before=f"subcategory={technique.subcategory}, "
                f"{len(technique.description)} char description",
                after=f"subcategory={replacement.subcategory}, "
                f"{len(replacement.description)} char description",
                rationale=note
                + (f" Replacement links dropped as absent here: {dropped}." if dropped else ""),
            )
        )
    return replace(catalog, techniques=tuple(updated)), changes



# --------------------------------------------------------------------------
# Pass 5e - remove claims the source does not support
# --------------------------------------------------------------------------


class ClaimEditNotApplicable(ValueError):
    """Raised when a claim edit's anchor text is not in the record.

    Deliberately fatal. A correction table that silently no-ops when a record
    drifts keeps reporting success while the unsupported claim stays in the
    catalog, which is worse than having no table at all.
    """


def apply_claim_corrections(
    catalog: Catalog, corrections: dict[str, tuple]
) -> tuple[Catalog, list[Change]]:
    """Delete or replace exact spans of prose that the paper does not support."""
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        edits = corrections.get(technique.id)
        if not edits:
            updated.append(technique)
            continue
        fields: dict[str, str] = {}
        for edit in edits:
            current = fields.get(edit.field, getattr(technique, edit.field))
            if edit.old not in current:
                # Already applied is fine; genuinely absent is not.
                if edit.new and edit.new in current:
                    continue
                raise ClaimEditNotApplicable(
                    f"{technique.id}.{edit.field}: anchor text not found. The "
                    f"record has changed since the audit -- re-check the claim "
                    f"against the source instead of adjusting the anchor."
                )
            fields[edit.field] = current.replace(edit.old, edit.new, 1)
            changes.append(
                Change(
                    kind="claim-corrected",
                    technique_id=technique.id,
                    field=edit.field,
                    before=edit.old,
                    after=edit.new or "<removed>",
                    rationale=edit.warrant,
                )
            )
        updated.append(replace(technique, **fields) if fields else technique)
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 5f - stamp what has been checked
# --------------------------------------------------------------------------


def stamp_source_audit(
    catalog: Catalog,
    description_audited: frozenset[str],
    pitfalls_audited: frozenset[str],
) -> tuple[Catalog, list[Change]]:
    """Record, per entry, which of its prose has been checked against the source.

    A label, not a quality judgement. `unverified` says nobody checked, which is
    different from saying the record is wrong -- the sampled pre-existing
    records were unverified and turned out clean. It exists so a reader deep in
    a record knows what the catalog is and is not vouching for, without having
    to remember a note at the top of the file.
    """
    changes: list[Change] = []
    updated: list[Technique] = []
    for technique in catalog.techniques:
        audit = SourceAudit(
            description=(
                "verified-against-abstract"
                if technique.id in description_audited
                else "unverified"
            ),
            pitfalls=(
                "verified-against-paper"
                if technique.id in pitfalls_audited
                else "unverified"
            ),
        )
        if audit != technique.source_audit:
            changes.append(
                Change(
                    kind="audit-stamped",
                    technique_id=technique.id,
                    field="source_audit",
                    before=f"{technique.source_audit.description} / {technique.source_audit.pitfalls}",
                    after=f"{audit.description} / {audit.pitfalls}",
                    rationale=(
                        "Per-record record of what was checked against the "
                        "cited source; see source_note for the method."
                    ),
                )
            )
        updated.append(replace(technique, source_audit=audit))
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 5c - connect isolated records
# --------------------------------------------------------------------------


def add_relationships(
    catalog: Catalog, mapping: dict[str, tuple[tuple[str, ...], str]]
) -> tuple[Catalog, list[Change]]:
    """Add reviewed cross-references to records that declare none.

    Targets that do not exist in this catalog are skipped rather than added, so
    the pass can never create the dangling references it is meant to prevent.
    """
    changes: list[Change] = []
    valid_ids = catalog.ids()
    updated: list[Technique] = []
    for technique in catalog.techniques:
        entry = mapping.get(technique.id)
        if entry is None or technique.related_techniques:
            updated.append(technique)
            continue
        targets, rationale = entry
        resolved = tuple(t for t in targets if t in valid_ids and t != technique.id)
        if not resolved:
            updated.append(technique)
            continue
        changes.append(
            Change(
                kind="relationship-added",
                technique_id=technique.id,
                field="related_techniques",
                before="<none>",
                after=", ".join(resolved),
                rationale=rationale,
            )
        )
        updated.append(replace(technique, related_techniques=resolved))
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Pass 5b - transplant authored content onto stub records
# --------------------------------------------------------------------------


def enrich_stub_records(
    catalog: Catalog, entries: Sequence[Technique]
) -> tuple[Catalog, list[Change]]:
    """Give a stub record the authored body for the same paper.

    Matched by arXiv id. The catalog's own id, name, category, status and
    corpus_file are preserved -- only the body is replaced -- so nothing that
    points at the record breaks. Authored cross-references are filtered to ids
    this catalog actually has, and the template id is re-derived from the
    catalog's id. A record already at least as rich as the authored one is left
    alone, which keeps the pass idempotent.
    """
    changes: list[Change] = []
    by_arxiv = {
        e.primary_source.arxiv_id: e
        for e in entries
        if e.primary_source and e.primary_source.arxiv_id
    }
    valid_ids = catalog.ids()
    updated: list[Technique] = []
    for technique in catalog.techniques:
        source = technique.primary_source
        authored = by_arxiv.get(source.arxiv_id) if source else None
        if authored is None or authored.id == technique.id and technique.description == authored.description:
            updated.append(technique)
            continue
        if len(technique.description) >= len(authored.description) and technique.related_techniques:
            updated.append(technique)
            continue

        related = tuple(
            r for r in authored.related_techniques if r in valid_ids and r != technique.id
        )
        dropped = [r for r in authored.related_techniques if r not in valid_ids]
        prefix = technique.id + schema.TEMPLATE_ID_SEPARATOR
        templates = tuple(
            replace(
                tpl,
                template_id=prefix
                + tpl.template_id.partition(schema.TEMPLATE_ID_SEPARATOR)[2],
            )
            for tpl in authored.usage_templates
        )
        updated.append(
            replace(
                technique,
                executive_summary=authored.executive_summary,
                description=authored.description,
                when_to_use=authored.when_to_use,
                when_not_to_use=authored.when_not_to_use,
                known_pitfalls=authored.known_pitfalls,
                related_techniques=_dedupe([*technique.related_techniques, *related]),
                tags=_dedupe([*technique.tags, *authored.tags]),
                aliases=_dedupe([*technique.aliases, *authored.aliases]),
                usage_templates=templates,
            )
        )
        changes.append(
            Change(
                kind="record-enriched",
                technique_id=technique.id,
                field="<body>",
                before=f"{len(technique.description)} char description, "
                f"{len(technique.related_techniques)} cross-reference(s)",
                after=f"{len(authored.description)} char description, "
                f"{len(related)} cross-reference(s)",
                rationale=policy.ENRICHMENT_RATIONALE
                + (f" Authored links dropped as absent here: {dropped}." if dropped else ""),
            )
        )
    return replace(catalog, techniques=tuple(updated)), changes


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------


def _serialization_changes(notes: ParseNotes) -> list[Change]:
    """Record repairs the model performs structurally rather than by transform."""
    changes: list[Change] = []
    for technique_id in sorted(notes.missing_id_element):
        changes.append(
            Change(
                kind="serialization",
                technique_id=technique_id,
                field="id",
                before="<absent>",
                after=technique_id,
                rationale="1.2.0 requires the <id> element as well as the @id attribute.",
            )
        )
    for technique_id in sorted(notes.empty_corpus_file):
        changes.append(
            Change(
                kind="serialization",
                technique_id=technique_id,
                field="corpus_file",
                before="<empty element>",
                after="<omitted>",
                rationale="Optional elements are omitted, never emitted empty.",
            )
        )
    for technique_id in sorted(notes.unmarked_empty_elements):
        changes.append(
            Change(
                kind="serialization",
                technique_id=technique_id,
                field="<empty elements>",
                before="unmarked",
                after='empty="true" / nil="true"',
                rationale="Emptiness markers distinguish deliberate from forgotten.",
            )
        )
    for technique_id in sorted(notes.unindented_entries):
        changes.append(
            Change(
                kind="serialization",
                technique_id=technique_id,
                field="<whitespace>",
                before="unindented single line",
                after="two-space canonical indent",
                rationale="Byte-stable formatting keeps catalog diffs reviewable.",
            )
        )
    return changes


def normalize(
    catalog: Catalog,
    notes: ParseNotes,
    *,
    status_policy: str = policy.StatusPolicy.REGISTER,
    strip_dangling: bool = False,
    add_entries: bool = True,
    canonicalize_template_id_slugs: bool = True,
    verify_sources: bool = True,
    replace_content: bool = True,
    correct_claims: bool = True,
    catalog_version: str | None = None,
    generated_at: str | None = None,
) -> NormalizationResult:
    """Run every pass in dependency order and return the result plus its ledger."""
    if status_policy not in policy.StatusPolicy.CHOICES:
        raise ValueError(
            f"status_policy must be one of {policy.StatusPolicy.CHOICES}, "
            f"got {status_policy!r}"
        )

    changes: list[Change] = list(_serialization_changes(notes))

    if add_entries:
        catalog, addition_changes = add_missing_entries(catalog, additions.NEW_ENTRIES)
        changes.extend(addition_changes)

    catalog, merge_changes, redirects = merge_duplicates(catalog, policy.MERGES)
    changes.extend(merge_changes)

    catalog, reference_changes = rewrite_references(
        catalog,
        redirects,
        policy.REFERENCE_REWRITES,
        policy.REFERENCE_DROPS,
        strip_dangling=strip_dangling,
    )
    changes.extend(reference_changes)

    catalog, source_changes = apply_source_corrections(
        catalog, policy.SOURCE_CORRECTIONS
    )
    changes.extend(source_changes)

    if verify_sources:
        catalog, verified_changes = apply_verified_sources(
            catalog, load_verified_sources()
        )
        changes.extend(verified_changes)

    if add_entries:
        catalog, enrich_changes = enrich_stub_records(catalog, additions.NEW_ENTRIES)
        changes.extend(enrich_changes)

    if replace_content:
        catalog, content_changes = apply_content_replacements(
            catalog, content_corrections.CONTENT_REPLACEMENTS
        )
        changes.extend(content_changes)

    if correct_claims:
        catalog, claim_changes = apply_claim_corrections(
            catalog, claim_corrections.CLAIM_CORRECTIONS
        )
        changes.extend(claim_changes)

    catalog, relationship_changes = add_relationships(
        catalog, policy.RELATIONSHIP_ADDITIONS
    )
    changes.extend(relationship_changes)

    catalog, template_var_changes = apply_template_variable_additions(
        catalog, policy.TEMPLATE_VARIABLE_ADDITIONS
    )
    changes.extend(template_var_changes)

    if canonicalize_template_id_slugs:
        catalog, template_id_changes = canonicalize_template_ids(catalog)
        changes.extend(template_id_changes)

    catalog, category_changes = _remap_field(
        catalog, "category", policy.CATEGORY_REMAP, "category-remap"
    )
    changes.extend(category_changes)

    catalog, verification_changes = _remap_field(
        catalog,
        "verification_status",
        policy.VERIFICATION_STATUS_REMAP,
        "vocabulary-verification-status",
    )
    changes.extend(verification_changes)

    if status_policy == policy.StatusPolicy.REMAP:
        catalog, status_changes = _remap_field(
            catalog, "status", policy.STATUS_REMAP, "vocabulary-status"
        )
        changes.extend(status_changes)

    catalog, determinism_changes = remap_determinism(catalog, policy.DETERMINISM_REMAP)
    changes.extend(determinism_changes)

    catalog, audit_changes = stamp_source_audit(
        catalog, policy.DESCRIPTION_AUDITED, policy.PITFALLS_AUDITED
    )
    changes.extend(audit_changes)

    catalog, stamp_changes = stamp_schema_version(catalog, schema.SCHEMA_VERSION)
    changes.extend(stamp_changes)

    catalog, metadata_changes = sync_metadata(
        catalog, catalog_version=catalog_version, generated_at=generated_at
    )
    changes.extend(metadata_changes)

    return NormalizationResult(
        catalog=catalog,
        changes=tuple(changes),
        manual_actions=policy.KNOWN_MANUAL_ACTIONS,
    )
