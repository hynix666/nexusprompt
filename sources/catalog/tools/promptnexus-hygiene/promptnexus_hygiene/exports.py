"""Cross-export consistency.

The catalog ships in six formats. Five of them are renderings of one dataset,
so the only way they can disagree is if something wrote to one and not the
others -- which is exactly what happened: the XML advanced to 177 records while
the Markdown and the per-technique files stayed at the 130 of v1.17.0, even
though the Markdown's own header states the two "can never drift apart".

Two capabilities live here:

* :func:`technique_to_record` / :func:`catalog_to_json` render a catalog into
  the record shape the per-technique export already uses, so a remediated XML
  can be turned back into source-of-truth JSON and fed to the real builder.
  Rendering the Markdown here instead would add a *second* generator and repeat
  the mistake this module exists to catch.
* :func:`compare_exports` diffs the XML against the per-technique export and
  the Markdown, and reports every way they disagree.

Record key order is fixed by ``RECORD_KEY_ORDER``. The shipped export uses six
different key orders across its 130 files, which makes byte diffs between builds
show changes that are not content changes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Iterable, Sequence

from .model import Catalog, SourceRef, Technique

__all__ = [
    "RECORD_KEY_ORDER",
    "technique_to_record",
    "catalog_to_json",
    "write_index",
    "ExportDivergence",
    "ExportComparison",
    "compare_exports",
]

#: Canonical key order for a technique record. The shipped per-technique export
#: varies the position of aliases, corpus_file and secondary_sources across
#: files; fixing the order makes regenerated JSON byte-comparable.
RECORD_KEY_ORDER: Final[tuple[str, ...]] = (
    "id",
    "name",
    "category",
    "subcategory",
    "executive_summary",
    "description",
    "verification_status",
    "cost_profile",
    "when_to_use",
    "when_not_to_use",
    "known_pitfalls",
    "related_techniques",
    "primary_source",
    "usage_templates",
    "tags",
    "status",
    "aliases",
    "secondary_sources",
    "corpus_file",
    "schema_version",
    "source_audit",
)

#: Key order inside a usage template, matching the source-of-truth export.
TEMPLATE_KEY_ORDER: Final[tuple[str, ...]] = (
    "template_name",
    "template",
    "variables",
    "template_id",
    "determinism",
    "reproducibility_note",
)

#: Fields compared when checking whether two exports describe the same record.
COMPARED_FIELDS: Final[tuple[str, ...]] = tuple(
    k for k in RECORD_KEY_ORDER if k != "corpus_file"
) + ("corpus_file",)

_MD_HEADER_RE: Final[re.Pattern[str]] = re.compile(
    r"Catalog version ([\d.]+)\s*.\s*schema version ([\d.]+)\s*.\s*"
    r"generated ([\d-]+)\s*.\s*(\d+) entries"
)
#: A record section is a level-3 heading followed by its slug, optionally with
#: an alias list on the same line ("`the-id` . aliases: X, Y").
_MD_ID_RE: Final[re.Pattern[str]] = re.compile(r"^### .+\n`([a-z0-9-]+)`", re.M)


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def _absent(value: str) -> Any:
    """The source of truth writes an absent optional string as ``null``, not as
    an empty string. Emitting "" instead would change 548 values and bury the
    real diff in noise."""
    return value if value else None


def _source_to_dict(source: SourceRef) -> dict[str, Any]:
    year: Any = source.year
    if isinstance(year, str) and year.isdigit():
        year = int(year)
    return {
        "authors": source.authors,
        "year": year,
        "title": source.title,
        "venue": source.venue,
        "arxiv_id": _absent(source.arxiv_id),
        "url": _absent(source.url),
    }


def technique_to_record(technique: Technique) -> dict[str, Any]:
    """Render one technique in the per-technique export's record shape."""
    record = {
        "id": technique.id,
        "name": technique.name,
        "category": technique.category,
        "subcategory": technique.subcategory,
        "executive_summary": technique.executive_summary,
        "description": technique.description,
        "verification_status": technique.verification_status,
        "cost_profile": technique.cost_profile,
        "when_to_use": list(technique.when_to_use),
        "when_not_to_use": list(technique.when_not_to_use),
        "known_pitfalls": list(technique.known_pitfalls),
        "related_techniques": list(technique.related_techniques),
        "primary_source": _source_to_dict(technique.primary_source)
        if technique.primary_source
        else None,
        "secondary_sources": [_source_to_dict(s) for s in technique.secondary_sources],
        "usage_templates": [
            {
                "template_name": t.template_name,
                "template": t.template,
                "variables": [
                    {
                        "name": v.name,
                        "description": v.description,
                        "example": _absent(v.example),
                    }
                    for v in t.variables
                ],
                "template_id": t.template_id,
                "determinism": t.determinism,
                "reproducibility_note": t.reproducibility_note,
            }
            for t in technique.usage_templates
        ],
        "aliases": list(technique.aliases),
        "tags": list(technique.tags),
        "status": technique.status,
        "corpus_file": technique.corpus_file,
        "schema_version": technique.schema_version,
        "source_audit": {
            "description": technique.source_audit.description,
            "pitfalls": technique.source_audit.pitfalls,
        },
    }
    return {key: record[key] for key in RECORD_KEY_ORDER}


def catalog_to_json(catalog: Catalog) -> str:
    """Render the whole catalog in the shape of ``data/prompt_technique_catalog.json``.

    Byte-compatible with the shipped source of truth: same top-level structure,
    two-space indent, unescaped non-ASCII and no trailing newline. Record keys
    use the plurality order of the shipped file (58 of its 130 records);
    the other five orders it contains are what make its build diffs noisy.
    """
    payload = {
        "catalog_metadata": {
            "catalog_name": catalog.metadata.catalog_name,
            "schema_version": catalog.metadata.schema_version,
            "catalog_version": catalog.metadata.catalog_version,
            "generated_at": catalog.metadata.generated_at,
            "entry_count": int(catalog.metadata.entry_count),
            "categories": list(catalog.metadata.categories),
            "source_note": catalog.metadata.source_note,
        },
        "techniques": [technique_to_record(t) for t in catalog.techniques],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


def write_index(catalog: Catalog, path: str | Path) -> None:
    """Write the per-technique INDEX.json for a catalog."""
    payload = {
        "catalog_version": catalog.metadata.catalog_version,
        "schema_version": catalog.metadata.schema_version,
        "entry_count": len(catalog.techniques),
        "techniques": [
            {"id": t.id, "name": t.name, "category": t.category}
            for t in catalog.techniques
        ],
    }
    Path(path).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# --------------------------------------------------------------------------
# Comparison
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ExportDivergence:
    kind: str
    subject: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "subject": self.subject, "detail": self.detail}


@dataclass(frozen=True, slots=True)
class ExportComparison:
    divergences: tuple[ExportDivergence, ...] = ()
    compared_records: int = 0
    notes: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.divergences

    def exit_code(self) -> int:
        return 0 if self.ok else 1


def _load_per_technique(directory: Path) -> tuple[dict[str, dict], list[ExportDivergence]]:
    divergences: list[ExportDivergence] = []
    json_dir = directory / "json"
    markdown_dir = directory / "markdown"
    records: dict[str, dict] = {}
    for path in sorted(json_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        record_id = data.get("id", "")
        if path.stem != record_id:
            divergences.append(
                ExportDivergence(
                    "filename-mismatch",
                    path.name,
                    f"file is named {path.stem!r} but the record id is {record_id!r}",
                )
            )
        records[record_id] = data

    if markdown_dir.is_dir():
        markdown_ids = {p.stem for p in markdown_dir.glob("*.md")}
        for missing in sorted(set(records) - markdown_ids):
            divergences.append(
                ExportDivergence(
                    "missing-file", missing, "has a json record but no markdown file"
                )
            )
        for orphan in sorted(markdown_ids - set(records)):
            divergences.append(
                ExportDivergence(
                    "orphan-file", orphan, "has a markdown file but no json record"
                )
            )

    index_path = directory / "INDEX.json"
    if index_path.is_file():
        index = json.loads(index_path.read_text(encoding="utf-8"))
        indexed = {t["id"] for t in index.get("techniques", [])}
        for missing in sorted(set(records) - indexed):
            divergences.append(
                ExportDivergence("index-omission", missing, "record is not in INDEX.json")
            )
        for phantom in sorted(indexed - set(records)):
            divergences.append(
                ExportDivergence("index-phantom", phantom, "INDEX.json lists a record with no file")
            )
        if str(index.get("entry_count")) != str(len(records)):
            divergences.append(
                ExportDivergence(
                    "stamp-mismatch",
                    "INDEX.json",
                    f"entry_count says {index.get('entry_count')}, "
                    f"{len(records)} record files present",
                )
            )
    return records, divergences


def _normalise(value: Any) -> Any:
    """Compare on content, not on encoding: 2023 and '2023' are the same year,
    and an omitted optional field is the same as an explicit null."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in sorted(value.items())}
    return value


def compare_exports(
    catalog: Catalog,
    *,
    per_technique_dir: Path | None = None,
    markdown_path: Path | None = None,
) -> ExportComparison:
    """Check that every export describes the same catalog."""
    divergences: list[ExportDivergence] = []
    notes: list[str] = []
    compared = 0
    xml_ids = catalog.ids()

    if per_technique_dir is not None:
        records, load_problems = _load_per_technique(per_technique_dir)
        divergences.extend(load_problems)

        for missing in sorted(xml_ids - set(records)):
            divergences.append(
                ExportDivergence(
                    "record-missing-from-export",
                    missing,
                    "present in the XML, absent from the per-technique export",
                )
            )
        for extra in sorted(set(records) - xml_ids):
            divergences.append(
                ExportDivergence(
                    "record-missing-from-xml",
                    extra,
                    "present in the per-technique export, absent from the XML",
                )
            )

        for technique in catalog.techniques:
            shipped = records.get(technique.id)
            if shipped is None:
                continue
            compared += 1
            rendered = technique_to_record(technique)
            for field_name in COMPARED_FIELDS:
                left = _normalise(rendered.get(field_name))
                right = _normalise(shipped.get(field_name))
                if left != right:
                    divergences.append(
                        ExportDivergence(
                            "field-divergence",
                            f"{technique.id}.{field_name}",
                            f"xml={left!r} export={right!r}"[:300],
                        )
                    )

        key_orders = {tuple(r.keys()) for r in records.values()}
        if len(key_orders) > 1:
            notes.append(
                f"the per-technique export uses {len(key_orders)} different key "
                "orders across its records, so byte diffs between builds show "
                "changes that are not content changes"
            )

    if markdown_path is not None and markdown_path.is_file():
        text = markdown_path.read_text(encoding="utf-8")
        header = _MD_HEADER_RE.search(text)
        if header is None:
            divergences.append(
                ExportDivergence(
                    "stamp-missing", markdown_path.name, "no version header found"
                )
            )
        else:
            version, schema_version, generated, count = header.groups()
            # Compared against the root attributes and the actual record
            # count, not against the metadata block: the block can itself be
            # stale, and a Markdown file that agrees with a stale block is not
            # thereby correct. C001 separately enforces root == metadata.
            for label, found, expected in (
                ("catalog_version", version, catalog.catalog_version),
                ("schema_version", schema_version, catalog.schema_version),
                ("generated_at", generated, catalog.generated_at[:10]),
                ("entry_count", count, str(len(catalog.techniques))),
            ):
                if found != expected:
                    divergences.append(
                        ExportDivergence(
                            "stamp-mismatch",
                            f"{markdown_path.name}.{label}",
                            f"markdown says {found!r}, catalog is {expected!r}",
                        )
                    )
        markdown_ids = set(_MD_ID_RE.findall(text))
        if markdown_ids:
            for missing in sorted(xml_ids - markdown_ids):
                divergences.append(
                    ExportDivergence(
                        "record-missing-from-markdown",
                        missing,
                        "present in the XML, absent from the Markdown catalog",
                    )
                )
            for extra in sorted(markdown_ids - xml_ids):
                divergences.append(
                    ExportDivergence(
                        "record-missing-from-xml",
                        extra,
                        "present in the Markdown catalog, absent from the XML",
                    )
                )
        else:
            notes.append(
                f"{markdown_path.name} carries no per-record ids, so only its "
                "header stamp could be checked"
            )

    return ExportComparison(
        divergences=tuple(divergences),
        compared_records=compared,
        notes=tuple(notes),
    )
