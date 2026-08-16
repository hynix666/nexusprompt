"""Data-format serializations of a catalog, and the per-technique split.

Scope, deliberately: this module emits **data** — JSON, XML, YAML, and the
per-technique files — all from the one model, so the formats cannot disagree
with each other. It does not emit the Markdown or the PDF. Those need the
slug-to-prose label maps and editorial layout that live in
``scripts/build_catalog.py``, and writing a second copy of that is what let the
exports diverge in the first place. See :mod:`promptnexus_hygiene.labels` for
the maps the real builder needs.

Every writer here is deterministic: fixed key order, no sorting that depends on
locale, no timestamps injected at write time. Running this twice on the same
catalog produces identical bytes, which is what makes the export diff in CI
meaningful.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from .exports import catalog_to_json, technique_to_record
from .render import catalog_to_markdown, write_pdf
from .webapp import catalog_to_app
from .model import Catalog, serialize_catalog

__all__ = ["BundleManifest", "catalog_to_yaml", "write_bundle"]

#: Written into the bundle so a consumer knows what it is holding.
BUNDLE_README: Final[str] = """\
# PromptNexus prompt-technique catalog — v{catalog_version} (schema {schema_version})

{entry_count} techniques.

## Whole-catalog formats

| file | notes |
| --- | --- |
| `prompt_technique_catalog.json` | source of truth shape — drop-in for `data/prompt_technique_catalog.json` |
| `prompt_technique_catalog.xml` | canonical 1.3.0 serialization; validates against `prompt_technique_catalog_1.3.0.xsd` |
| `prompt_technique_catalog.yaml` | same records, YAML block style |
| `PROMPT_TECHNIQUE_CATALOG.md` | the human-readable catalog |
| `PROMPT_TECHNIQUE_CATALOG.pdf` | the same, paginated |
| `app/index.html` | searchable browser app — open it directly, no server needed |

All three are generated from one in-memory model in a single pass, so they
cannot disagree. They are byte-reproducible: regenerating from the same input
yields identical files.

## Per-technique files

    techniques/INDEX.json      id, name, category for every record
    techniques/INDEX.md        the same, grouped by category
    techniques/json/<id>.json  one record per file
    techniques/yaml/<id>.yaml  the same record as YAML

Filenames are the record id, so `techniques/json/<id>.json` is addressable
without consulting the index.

## About the Markdown and PDF

Their display strings -- category names, status and reproducibility wording,
emoji -- were extracted from the catalog's own shipped Markdown rather than
invented, so the voice matches. But `scripts/build_catalog.py` also renders
Markdown, and two generators for one artifact is what let the exports drift
apart before. Pick one owner: either regenerate here and drop the builder's
Markdown step, or treat these as a preview and keep the builder's. Running both
and hoping they match is the arrangement that failed.

The PDF strips emoji. ReportLab's built-in fonts have no glyphs for them and
draw a solid black box instead, which is worse than the word alone.

## Reading `source_audit`

Each record carries what has been checked about its prose:

    "source_audit": {{ "description": ..., "pitfalls": ... }}

`unverified` means nobody checked it against the cited source — not that it is
wrong. No record's `known_pitfalls` have been traced to a paper yet; treat them
as practitioner guidance rather than as findings attributable to the source.
"""


@dataclass(frozen=True, slots=True)
class BundleManifest:
    """What was written, for the caller to report or verify."""

    root: Path
    files: tuple[Path, ...]
    entry_count: int

    def total_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.files)


def _yaml_dump(payload: Any) -> str:
    import yaml

    class _Dumper(yaml.SafeDumper):
        """Block style throughout, and no anchors/aliases.

        PyYAML emits `&id001` / `*id001` for repeated objects by default. That
        is valid YAML and unreadable to a human diffing two catalog versions,
        so aliasing is switched off.
        """

        def ignore_aliases(self, data: Any) -> bool:  # noqa: D102
            return True

    def _str_presenter(dumper: yaml.Dumper, data: str) -> Any:
        style = "|" if "\n" in data else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    _Dumper.add_representer(str, _str_presenter)
    return yaml.dump(
        payload,
        Dumper=_Dumper,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=100,
    )


def catalog_to_yaml(catalog: Catalog) -> str:
    """Render the whole catalog as YAML, mirroring the JSON structure exactly."""
    return _yaml_dump(json.loads(catalog_to_json(catalog)))


def _index_markdown(catalog: Catalog) -> str:
    by_category: dict[str, list] = {}
    for technique in catalog.techniques:
        by_category.setdefault(technique.category, []).append(technique)
    lines = [
        f"# Technique index — v{catalog.metadata.catalog_version}",
        "",
        f"{len(catalog.techniques)} techniques across {len(by_category)} categories.",
        "",
    ]
    for category in sorted(by_category):
        entries = by_category[category]
        lines.append(f"## {category} ({len(entries)})")
        lines.append("")
        for technique in entries:
            lines.append(
                f"- `{technique.id}` — {technique.name} "
                f"([json](json/{technique.id}.json), "
                f"[yaml](yaml/{technique.id}.yaml))"
            )
        lines.append("")
    return "\n".join(lines)


def write_bundle(catalog: Catalog, root: str | Path) -> BundleManifest:
    """Write every data format plus the per-technique split under ``root``."""
    base = Path(root)
    techniques = base / "techniques"
    (base / "app").mkdir(parents=True, exist_ok=True)
    (techniques / "json").mkdir(parents=True, exist_ok=True)
    (techniques / "yaml").mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    def _write(path: Path, text: str) -> None:
        path.write_text(text, encoding="utf-8")
        written.append(path)

    _write(base / "prompt_technique_catalog.json", catalog_to_json(catalog))
    _write(base / "prompt_technique_catalog.xml", serialize_catalog(catalog))
    _write(base / "prompt_technique_catalog.yaml", catalog_to_yaml(catalog))
    _write(base / "PROMPT_TECHNIQUE_CATALOG.md", catalog_to_markdown(catalog))
    _write(base / "app" / "index.html", catalog_to_app(catalog))
    pdf_path = base / "PROMPT_TECHNIQUE_CATALOG.pdf"
    write_pdf(catalog, pdf_path)
    written.append(pdf_path)

    for technique in catalog.techniques:
        record = technique_to_record(technique)
        _write(
            techniques / "json" / f"{technique.id}.json",
            json.dumps(record, indent=2, ensure_ascii=False) + "\n",
        )
        _write(techniques / "yaml" / f"{technique.id}.yaml", _yaml_dump(record))

    _write(
        techniques / "INDEX.json",
        json.dumps(
            {
                "catalog_version": catalog.metadata.catalog_version,
                "schema_version": catalog.metadata.schema_version,
                "entry_count": len(catalog.techniques),
                "techniques": [
                    {"id": t.id, "name": t.name, "category": t.category}
                    for t in catalog.techniques
                ],
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
    )
    _write(techniques / "INDEX.md", _index_markdown(catalog))
    _write(
        base / "README.md",
        BUNDLE_README.format(
            catalog_version=catalog.metadata.catalog_version,
            schema_version=catalog.metadata.schema_version,
            entry_count=len(catalog.techniques),
        ),
    )
    return BundleManifest(
        root=base, files=tuple(written), entry_count=len(catalog.techniques)
    )
