"""Build a reviewable patch from a baseline catalog to a target catalog.

The output is not a blind file replacement. A source-of-truth change that adds
38 records and touches 130 existing ones has to be reviewable record by record,
or the review degenerates into "the tests passed". So this emits three things:

* the new source-of-truth JSON, drop-in for ``data/prompt_technique_catalog.json``;
* a manifest listing every added, modified and removed record, with per-field
  before/after for the modifications;
* a backlog of what the patch deliberately does not resolve.

Records are compared on content, not on encoding, and the baseline is treated
as authoritative: any change to a baseline record must appear in the manifest
with a reason, or it is a bug in the pipeline that produced the target.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final, Iterable, Sequence

from .exports import COMPARED_FIELDS, _normalise, technique_to_record
from .model import Catalog

__all__ = ["FieldChange", "RecordChange", "CatalogPatch", "build_patch", "render_patch_markdown"]

#: Fields whose values are long prose; the manifest truncates them rather than
#: reproducing a paragraph twice per change.
_TRUNCATE_AT: Final[int] = 160


@dataclass(frozen=True, slots=True)
class FieldChange:
    field: str
    before: str
    after: str

    def as_dict(self) -> dict[str, str]:
        return {"field": self.field, "before": self.before, "after": self.after}


@dataclass(frozen=True, slots=True)
class RecordChange:
    record_id: str
    fields: tuple[FieldChange, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.record_id,
            "fields": [f.as_dict() for f in self.fields],
        }


#: Fields whose change is a schema migration rather than a content edit. They
#: move on every record at once, so listing them per record would bury the two
#: or three records whose content actually changed.
MIGRATION_FIELDS: Final[frozenset[str]] = frozenset({"schema_version", "source_audit"})


@dataclass(frozen=True, slots=True)
class CatalogPatch:
    added: tuple[str, ...]
    removed: tuple[str, ...]
    modified: tuple[RecordChange, ...]
    migrated: tuple[RecordChange, ...]
    unchanged: tuple[str, ...]
    metadata_changes: tuple[FieldChange, ...]
    baseline_count: int
    target_count: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "baseline_entry_count": self.baseline_count,
            "target_entry_count": self.target_count,
            "added_count": len(self.added),
            "removed_count": len(self.removed),
            "modified_count": len(self.modified),
            "migrated_count": len(self.migrated),
            "unchanged_count": len(self.unchanged),
            "metadata_changes": [c.as_dict() for c in self.metadata_changes],
            "added": list(self.added),
            "removed": list(self.removed),
            "modified": [c.as_dict() for c in self.modified],
            "migrated": [c.as_dict() for c in self.migrated],
        }


def _short(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    text = " ".join(text.split())
    return text if len(text) <= _TRUNCATE_AT else text[: _TRUNCATE_AT - 1] + "…"


def _field_changes(field: str, before: Any, after: Any) -> list[FieldChange]:
    """Report the smallest thing that actually changed.

    Saying ``primary_source`` changed and printing two truncated JSON blobs is
    not a reviewable diff, so nested objects are descended one level and lists
    of objects are compared element-wise where the lengths match.
    """
    if isinstance(before, dict) and isinstance(after, dict):
        changes: list[FieldChange] = []
        for key in sorted(set(before) | set(after)):
            if _normalise(before.get(key)) != _normalise(after.get(key)):
                changes.extend(
                    _field_changes(f"{field}.{key}", before.get(key), after.get(key))
                )
        return changes
    if (
        isinstance(before, list)
        and isinstance(after, list)
        and len(before) == len(after)
        and all(isinstance(x, dict) for x in before + after)
    ):
        changes = []
        for index, (left, right) in enumerate(zip(before, after)):
            changes.extend(_field_changes(f"{field}[{index}]", left, right))
        return changes
    return [FieldChange(field=field, before=_short(before), after=_short(after))]


def build_patch(baseline: Catalog, target: Catalog) -> CatalogPatch:
    """Diff two catalogs at record and field level."""
    base_records = {t.id: technique_to_record(t) for t in baseline.techniques}
    target_records = {t.id: technique_to_record(t) for t in target.techniques}

    added = tuple(t.id for t in target.techniques if t.id not in base_records)
    removed = tuple(t.id for t in baseline.techniques if t.id not in target_records)

    modified: list[RecordChange] = []
    migrated: list[RecordChange] = []
    unchanged: list[str] = []
    for record_id, base in base_records.items():
        current = target_records.get(record_id)
        if current is None:
            continue
        changes = tuple(
            change
            for field in COMPARED_FIELDS
            if _normalise(base.get(field)) != _normalise(current.get(field))
            for change in _field_changes(field, base.get(field), current.get(field))
        )
        content = tuple(
            c for c in changes if c.field.split(".")[0] not in MIGRATION_FIELDS
        )
        migration = tuple(
            c for c in changes if c.field.split(".")[0] in MIGRATION_FIELDS
        )
        if content:
            modified.append(RecordChange(record_id=record_id, fields=content))
        else:
            unchanged.append(record_id)
        if migration:
            migrated.append(RecordChange(record_id=record_id, fields=migration))

    metadata_changes = tuple(
        FieldChange(field=name, before=str(before), after=str(after))
        for name, before, after in (
            ("catalog_version", baseline.metadata.catalog_version, target.metadata.catalog_version),
            ("schema_version", baseline.metadata.schema_version, target.metadata.schema_version),
            ("generated_at", baseline.metadata.generated_at, target.metadata.generated_at),
            ("entry_count", baseline.metadata.entry_count, target.metadata.entry_count),
            (
                "categories",
                ", ".join(baseline.metadata.categories),
                ", ".join(target.metadata.categories),
            ),
        )
        if str(before) != str(after)
    )

    return CatalogPatch(
        added=added,
        removed=removed,
        modified=tuple(modified),
        migrated=tuple(migrated),
        unchanged=tuple(unchanged),
        metadata_changes=metadata_changes,
        baseline_count=len(baseline.techniques),
        target_count=len(target.techniques),
    )


def render_patch_markdown(
    patch: CatalogPatch,
    *,
    baseline_label: str,
    target_label: str,
    backlog: Sequence[str] = (),
    notes: Sequence[str] = (),
) -> str:
    """Render the manifest for human review."""
    lines = [
        "# Source-of-truth patch",
        "",
        f"Baseline: `{baseline_label}` — {patch.baseline_count} records",
        f"Target:   `{target_label}` — {patch.target_count} records",
        "",
        "| change | count |",
        "|---|---|",
        f"| records added | {len(patch.added)} |",
        f"| records with content changes | {len(patch.modified)} |",
        f"| records touched only by the schema migration | {len(patch.migrated)} |",
        f"| records removed | {len(patch.removed)} |",
        f"| records with no content change | {len(patch.unchanged)} |",
        "",
    ]

    if patch.metadata_changes:
        lines += ["## Metadata", "", "| field | before | after |", "|---|---|---|"]
        for change in patch.metadata_changes:
            lines.append(
                f"| {change.field} | {change.before or '—'} | {change.after or '—'} |"
            )
        lines.append("")

    if patch.removed:
        lines += [
            f"## Records removed ({len(patch.removed)})",
            "",
            "Removal from the source of truth is irreversible without a rebuild; "
            "check each of these deliberately.",
            "",
        ]
        lines += [f"- `{record_id}`" for record_id in patch.removed]
        lines.append("")

    if patch.added:
        lines += [f"## Records added ({len(patch.added)})", ""]
        lines += [f"- `{record_id}`" for record_id in sorted(patch.added)]
        lines.append("")

    if patch.migrated:
        fields = sorted({c.field for r in patch.migrated for c in r.fields})
        lines += [
            f"## Schema migration ({len(patch.migrated)} records)",
            "",
            f"Every record gains or changes {', '.join('`' + f + '`' for f in fields)} "
            "as part of the 1.2.0 -> 1.3.0 bump. Listed as a count rather than "
            "per record, so the content diff below stays readable.",
            "",
        ]

    if patch.modified:
        lines += [
            f"## Records with content changes ({len(patch.modified)})",
            "",
            "Every existing record touched by this patch, and exactly what "
            "changed in it. Anything here that you did not ask for is a bug.",
            "",
            "| record | field | before | after |",
            "|---|---|---|---|",
        ]
        for record in patch.modified:
            for change in record.fields:
                before = change.before.replace("|", "\\|") or "—"
                after = change.after.replace("|", "\\|") or "—"
                lines.append(f"| `{record.record_id}` | {change.field} | {before} | {after} |")
        lines.append("")

    if backlog:
        lines += [
            "## Not resolved by this patch",
            "",
            "Carried forward deliberately. Each needs a decision or a source "
            "consulted; none is something a program should settle on its own.",
            "",
        ]
        lines += [f"- {item}" for item in backlog]
        lines.append("")

    if notes:
        lines += ["## Notes", ""] + [f"- {item}" for item in notes] + [""]

    return "\n".join(lines)
