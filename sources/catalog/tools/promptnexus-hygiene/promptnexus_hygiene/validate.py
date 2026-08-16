"""Validation harness.

One check per defect class, each with a stable id so a finding can be waived,
tracked or greped without matching on message text. Checks are pure functions
over a :class:`CheckContext`; adding one means appending to ``CHECKS``.

Severity contract:
  ERROR    -- the catalog is internally inconsistent or violates 1.2.0. Fails
              the build. No judgement call required to fix it.
  WARNING  -- the catalog is well-formed but a human should look. Fails the
              build only under ``--strict``.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Callable, Final, Iterable, Iterator, Sequence

from . import labels, policy, schema
from .model import Catalog, ParseNotes, ParsedCatalog

__all__ = [
    "Severity",
    "Finding",
    "CheckContext",
    "Report",
    "CHECKS",
    "run_checks",
]


class Severity:
    #: Fails the build. No judgement call needed to fix it.
    ERROR = "ERROR"
    #: A human should look. Fails the build only under ``--strict``.
    WARNING = "WARNING"
    #: A finding the policy has already reviewed and accepted. Reported only
    #: under ``--show-waived`` and never fails a build, including under
    #: ``--strict`` -- otherwise the diagnostic flag would break CI, and a
    #: reviewed decision would masquerade as an open problem forever.
    WAIVED = "WAIVED"


@dataclass(frozen=True, slots=True)
class Finding:
    check_id: str
    severity: str
    technique_id: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {
            "check_id": self.check_id,
            "severity": self.severity,
            "technique_id": self.technique_id,
            "message": self.message,
        }


@dataclass(frozen=True, slots=True)
class CheckContext:
    catalog: Catalog
    notes: ParseNotes
    allow_dangling: bool = False
    show_waived: bool = False
    alias_allowlist: dict[str, str] | None = None

    def aliases_allowed(self) -> dict[str, str]:
        return (
            policy.ALIAS_COLLISION_ALLOWLIST
            if self.alias_allowlist is None
            else self.alias_allowlist
        )


Check = Callable[[CheckContext], Iterable[Finding]]

_ARXIV_RE: Final[re.Pattern[str]] = re.compile(rf"^{schema.ARXIV_ID_PATTERN}$")
_SLUG_RE: Final[re.Pattern[str]] = re.compile(rf"^{schema.SLUG_PATTERN}$")
_PLACEHOLDER_RE: Final[re.Pattern[str]] = re.compile(
    schema.TEMPLATE_PLACEHOLDER_PATTERN
)
_ET_AL_RE: Final[re.Pattern[str]] = re.compile(schema.ET_AL_PATTERN)


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------


def check_metadata_consistency(ctx: CheckContext) -> Iterator[Finding]:
    """C001 - root attributes and <catalog_metadata> must agree."""
    catalog = ctx.catalog
    fields = ("schema_version", "catalog_version", "entry_count")
    for field_name in fields:
        root_value = getattr(catalog, field_name)
        metadata_value = getattr(catalog.metadata, field_name)
        if root_value != metadata_value:
            yield Finding(
                "C001",
                Severity.ERROR,
                "<catalog>",
                f"{field_name}: root says {root_value!r}, "
                f"<catalog_metadata> says {metadata_value!r}",
            )
    # The root attribute is a dateTime and the metadata element a date, so
    # they are compared on the calendar day rather than byte-for-byte.
    if catalog.generated_at[:10] != catalog.metadata.generated_at[:10]:
        yield Finding(
            "C001",
            Severity.ERROR,
            "<catalog>",
            f"generated_at: root says {catalog.generated_at!r}, "
            f"<catalog_metadata> says {catalog.metadata.generated_at!r} "
            "(they must name the same day)",
        )
    if catalog.schema_version != schema.SCHEMA_VERSION:
        yield Finding(
            "C001",
            Severity.ERROR,
            "<catalog>",
            f"catalog schema_version {catalog.schema_version!r} is not the "
            f"schema this build supports ({schema.SCHEMA_VERSION})",
        )


def check_entry_count(ctx: CheckContext) -> Iterator[Finding]:
    """C002 - declared entry_count must match the number of techniques."""
    actual = str(len(ctx.catalog.techniques))
    if ctx.catalog.entry_count != actual:
        yield Finding(
            "C002",
            Severity.ERROR,
            "<catalog>",
            f"entry_count says {ctx.catalog.entry_count!r}, found {actual}",
        )


def check_id_element(ctx: CheckContext) -> Iterator[Finding]:
    """C003 - every technique carries both @id and a matching <id> element."""
    for technique_id in sorted(ctx.notes.missing_id_element):
        yield Finding(
            "C003",
            Severity.ERROR,
            technique_id,
            "<id> element is missing (only the @id attribute is present)",
        )


def check_id_uniqueness(ctx: CheckContext) -> Iterator[Finding]:
    """C004 - ids are unique and slug-formed."""
    seen: dict[str, int] = defaultdict(int)
    for technique in ctx.catalog.techniques:
        seen[technique.id] += 1
        if not _SLUG_RE.match(technique.id):
            yield Finding(
                "C004", Severity.ERROR, technique.id, "id is not a lowercase slug"
            )
    for technique_id, count in sorted(seen.items()):
        if count > 1:
            yield Finding(
                "C004", Severity.ERROR, technique_id, f"id appears {count} times"
            )


def check_categories_declared(ctx: CheckContext) -> Iterator[Finding]:
    """C005 - every category in use is registered, and vice versa."""
    declared = set(ctx.catalog.metadata.categories)
    used = {t.category for t in ctx.catalog.techniques}
    for category in sorted(used - declared):
        members = sorted(t.id for t in ctx.catalog.techniques if t.category == category)
        yield Finding(
            "C005",
            Severity.ERROR,
            "<catalog_metadata>",
            f"category {category!r} is used by {len(members)} entr"
            f"{'y' if len(members) == 1 else 'ies'} "
            f"({', '.join(members[:3])}{'...' if len(members) > 3 else ''}) "
            "but is not declared",
        )
    for category in sorted(declared - used):
        yield Finding(
            "C005",
            Severity.WARNING,
            "<catalog_metadata>",
            f"category {category!r} is declared but has no members",
        )


def check_controlled_vocabularies(ctx: CheckContext) -> Iterator[Finding]:
    """C006 - status / verification_status / cost_profile / determinism."""
    for technique in ctx.catalog.techniques:
        for field_name in ("status", "verification_status", "cost_profile"):
            value = getattr(technique, field_name)
            allowed = schema.CONTROLLED_VOCABULARIES[field_name]
            if value not in allowed:
                yield Finding(
                    "C006",
                    Severity.ERROR,
                    technique.id,
                    f"{field_name}={value!r} is outside the controlled vocabulary "
                    f"{sorted(allowed)}",
                )
        for template in technique.usage_templates:
            if template.determinism not in schema.DETERMINISM_VALUES:
                yield Finding(
                    "C006",
                    Severity.ERROR,
                    technique.id,
                    f"determinism={template.determinism!r} on template "
                    f"{template.template_id!r} is outside the controlled vocabulary",
                )


def check_serialization(ctx: CheckContext) -> Iterator[Finding]:
    """C007 - one serializer, one format."""
    for technique_id in sorted(ctx.notes.empty_corpus_file):
        yield Finding(
            "C007",
            Severity.ERROR,
            technique_id,
            "<corpus_file> is present but empty; optional elements are omitted",
        )
    for technique_id in sorted(ctx.notes.unmarked_empty_elements):
        yield Finding(
            "C007",
            Severity.ERROR,
            technique_id,
            'empty element without an empty="true" / nil="true" marker',
        )
    for technique_id in sorted(ctx.notes.unindented_entries):
        yield Finding(
            "C007",
            Severity.WARNING,
            technique_id,
            "entry is not pretty-printed; it was written by a second serializer",
        )


def check_schema_stamp(ctx: CheckContext) -> Iterator[Finding]:
    """C008 - per-entry schema_version matches the catalog's."""
    for technique in ctx.catalog.techniques:
        if technique.schema_version != ctx.catalog.schema_version:
            yield Finding(
                "C008",
                Severity.ERROR,
                technique.id,
                f"schema_version={technique.schema_version!r} but the catalog "
                f"declares {ctx.catalog.schema_version!r}",
            )


def check_duplicates(ctx: CheckContext) -> Iterator[Finding]:
    """C009 - two entries describing one technique."""
    by_name: dict[str, list[str]] = defaultdict(list)
    by_arxiv: dict[str, list[str]] = defaultdict(list)
    by_title: dict[str, list[str]] = defaultdict(list)
    by_template: dict[str, list[str]] = defaultdict(list)

    for technique in ctx.catalog.techniques:
        by_name[technique.name.strip().lower()].append(technique.id)
        source = technique.primary_source
        if source is not None:
            if source.arxiv_id:
                by_arxiv[source.arxiv_id].append(technique.id)
            if source.title:
                by_title[source.title.strip().lower()].append(technique.id)
        for template in technique.usage_templates:
            by_template[template.template_id].append(technique.id)

    for label, index, severity in (
        ("name", by_name, Severity.ERROR),
        ("primary_source.arxiv_id", by_arxiv, Severity.ERROR),
        ("primary_source.title", by_title, Severity.ERROR),
        ("template_id", by_template, Severity.ERROR),
    ):
        for value, ids in sorted(index.items()):
            if len(ids) > 1:
                yield Finding(
                    "C009",
                    severity,
                    ids[0],
                    f"{label} {value!r} is shared by {', '.join(sorted(ids))}",
                )


def check_referential_integrity(ctx: CheckContext) -> Iterator[Finding]:
    """C010 - related_techniques must resolve, and must not self-reference."""
    valid = ctx.catalog.ids()
    severity = Severity.WARNING if ctx.allow_dangling else Severity.ERROR
    for technique in ctx.catalog.techniques:
        for reference in technique.related_techniques:
            if reference == technique.id:
                yield Finding(
                    "C010", Severity.ERROR, technique.id, "references itself"
                )
            elif reference not in valid:
                yield Finding(
                    "C010",
                    severity,
                    technique.id,
                    f"related_techniques target {reference!r} does not exist",
                )
        if len(set(technique.related_techniques)) != len(technique.related_techniques):
            yield Finding(
                "C010",
                Severity.ERROR,
                technique.id,
                "related_techniques contains duplicates",
            )


def check_alias_collisions(ctx: CheckContext) -> Iterator[Finding]:
    """C011 - an alias must resolve to one entry, or be a declared collision."""
    index: dict[str, list[str]] = defaultdict(list)
    for technique in ctx.catalog.techniques:
        for alias in technique.aliases:
            index[alias.strip().lower()].append(technique.id)
    allowlist = ctx.aliases_allowed()
    for alias, ids in sorted(index.items()):
        unique_ids = sorted(set(ids))
        if len(unique_ids) < 2:
            continue
        if alias in allowlist:
            # A declared collision is a reviewed decision; the allowlist entry
            # is the audit record. Surface it only when explicitly asked, so it
            # does not sit in the report forever as a permanent warning.
            if ctx.show_waived:
                yield Finding(
                    "C011",
                    Severity.WAIVED,
                    unique_ids[0],
                    f"waived alias collision {alias!r} -> {', '.join(unique_ids)}: "
                    f"{allowlist[alias]}",
                )
        else:
            yield Finding(
                "C011",
                Severity.ERROR,
                unique_ids[0],
                f"alias {alias!r} resolves to {', '.join(unique_ids)}; add it to "
                "ALIAS_COLLISION_ALLOWLIST if the collision is real",
            )


def check_template_variables(ctx: CheckContext) -> Iterator[Finding]:
    """C012 - every {{placeholder}} is declared, and every declaration is used."""
    for technique in ctx.catalog.techniques:
        for template in technique.usage_templates:
            used = set(_PLACEHOLDER_RE.findall(template.template))
            declared = {v.name for v in template.variables if v.name}
            for name in sorted(used - declared):
                yield Finding(
                    "C012",
                    Severity.ERROR,
                    technique.id,
                    f"template {template.template_id!r} uses {{{{{name}}}}} but "
                    "does not declare it",
                )
            for name in sorted(declared - used):
                yield Finding(
                    "C012",
                    Severity.WARNING,
                    technique.id,
                    f"template {template.template_id!r} declares unused "
                    f"variable {name!r}",
                )
            if not template.template_id.startswith(
                technique.id + schema.TEMPLATE_ID_SEPARATOR
            ):
                yield Finding(
                    "C012",
                    Severity.WARNING,
                    technique.id,
                    f"template_id {template.template_id!r} does not follow the "
                    f"'<technique-id>--<slug>' convention",
                )


def check_corpus_file_consistency(ctx: CheckContext) -> Iterator[Finding]:
    """C013 - corpus_file present exactly when status is corpus-present."""
    for technique in ctx.catalog.techniques:
        has_file = bool(technique.corpus_file)
        is_corpus = technique.status == "corpus-present"
        if is_corpus and not has_file:
            yield Finding(
                "C013",
                Severity.ERROR,
                technique.id,
                "status=corpus-present but no corpus_file is recorded",
            )
        if has_file and not is_corpus:
            yield Finding(
                "C013",
                Severity.WARNING,
                technique.id,
                f"corpus_file is recorded but status={technique.status!r}",
            )


def check_source_quality(ctx: CheckContext) -> Iterator[Finding]:
    """C014 - a 'verified' entry must carry something that was verified."""
    for technique in ctx.catalog.techniques:
        source = technique.primary_source
        if source is None:
            yield Finding("C014", Severity.ERROR, technique.id, "no primary_source")
            continue
        for field_name in ("authors", "year", "title", "venue"):
            if not getattr(source, field_name):
                yield Finding(
                    "C014",
                    Severity.ERROR,
                    technique.id,
                    f"primary_source.{field_name} is empty",
                )
        if source.arxiv_id and not _ARXIV_RE.match(source.arxiv_id):
            yield Finding(
                "C014",
                Severity.ERROR,
                technique.id,
                f"malformed arxiv_id {source.arxiv_id!r}",
            )
        if technique.status == "verified-external" and not (source.url or source.arxiv_id):
            yield Finding(
                "C014",
                Severity.WARNING,
                technique.id,
                "status=verified-external but neither url nor arxiv_id is recorded, "
                "so the verification cannot be reproduced",
            )
        authors = source.authors.strip().lower()
        if authors in schema.PLACEHOLDER_AUTHOR_VALUES:
            yield Finding(
                "C014",
                Severity.WARNING,
                technique.id,
                f"primary_source.authors={source.authors!r} names no author",
            )
        elif any(
            token in authors for token in schema.PLACEHOLDER_AUTHOR_SUBSTRINGS
        ):
            # Vendor documentation genuinely has an organisation as its author.
            # That is acceptable for the practitioner-guide tier provided the
            # document itself is linked; for a literature entry it is not.
            if technique.status != "practitioner-guide":
                yield Finding(
                    "C014",
                    Severity.WARNING,
                    technique.id,
                    f"primary_source.authors={source.authors!r} names an "
                    "organisation, not authors, but the entry is not "
                    "status=practitioner-guide",
                )
            elif not source.url:
                yield Finding(
                    "C014",
                    Severity.WARNING,
                    technique.id,
                    "organisational author is acceptable for a practitioner "
                    "guide, but the document must be linked via url",
                )


def check_required_text(ctx: CheckContext) -> Iterator[Finding]:
    """C015 - mandatory prose fields carry text."""
    for technique in ctx.catalog.techniques:
        for field_name in (
            "name",
            "category",
            "subcategory",
            "executive_summary",
            "description",
        ):
            if not getattr(technique, field_name).strip():
                yield Finding(
                    "C015", Severity.ERROR, technique.id, f"{field_name} is empty"
                )
        if not technique.usage_templates:
            yield Finding("C015", Severity.ERROR, technique.id, "no usage template")


def check_author_format(ctx: CheckContext) -> Iterator[Finding]:
    """C016 - "et al." must truncate a long author list, not replace one."""
    for technique in ctx.catalog.techniques:
        source = technique.primary_source
        if source is None or not _ET_AL_RE.search(source.authors.strip()):
            continue
        named = [
            part
            for part in re.split(r",\s*", source.authors)
            if part.strip() and not part.strip().lower().startswith("et al")
        ]
        if len(named) >= schema.MIN_AUTHORS_BEFORE_ET_AL:
            continue
        if technique.id in policy.ABBREVIATED_AUTHOR_BACKLOG:
            if ctx.show_waived:
                yield Finding(
                    "C016",
                    Severity.WAIVED,
                    technique.id,
                    f"authors={source.authors!r}: "
                    f"{policy.ABBREVIATED_AUTHOR_BACKLOG_NOTE}",
                )
            continue
        yield Finding(
            "C016",
            Severity.WARNING,
            technique.id,
            f"authors={source.authors!r} abbreviates {len(named)} name(s) with "
            "'et al.'; the catalog convention is the full surname sequence",
        )


def check_graph_connectivity(ctx: CheckContext) -> Iterator[Finding]:
    """C017 - a record with no cross-references is an island in the graph.

    The catalog's value is partly the relationship graph; a record nothing
    links to and that links to nothing is reachable only by exact-id lookup.
    This is the signature of a record added to satisfy a reference rather than
    authored into the catalog.
    """
    inbound: dict[str, int] = defaultdict(int)
    for technique in ctx.catalog.techniques:
        for reference in technique.related_techniques:
            inbound[reference] += 1
    for technique in ctx.catalog.techniques:
        if technique.related_techniques:
            continue
        yield Finding(
            "C017",
            Severity.WARNING,
            technique.id,
            "record declares no related_techniques"
            + (
                f" (referenced by {inbound[technique.id]} other record(s))"
                if inbound[technique.id]
                else " and nothing references it -- fully isolated"
            ),
        )


def check_render_labels(ctx: CheckContext) -> Iterator[Finding]:
    """C018 - every vocabulary value has a display label.

    The Markdown and PDF renderings map slugs to prose. A value with no label
    either stops the build or, worse, reaches the reader as a raw slug. This
    fails at validation time instead, where it is cheap.
    """
    for field_name, values in sorted(labels.missing_labels(ctx.catalog).items()):
        for value in sorted(values):
            yield Finding(
                "C018",
                Severity.ERROR,
                "<catalog>",
                f"{field_name}={value!r} has no display label; the Markdown and "
                "PDF renderings cannot present it",
            )


def check_source_audit(ctx: CheckContext) -> Iterator[Finding]:
    """C019 - every record states what has been checked about its prose.

    An unlabelled record is indistinguishable from a verified one to a reader,
    which is the whole failure this field exists to prevent.
    """
    for technique in ctx.catalog.techniques:
        audit = technique.source_audit
        if audit.description not in schema.DESCRIPTION_AUDIT_VALUES:
            yield Finding(
                "C019",
                Severity.ERROR,
                technique.id,
                f"source_audit.description={audit.description!r} is outside the "
                f"controlled vocabulary {sorted(schema.DESCRIPTION_AUDIT_VALUES)}",
            )
        if audit.pitfalls not in schema.PITFALLS_AUDIT_VALUES:
            yield Finding(
                "C019",
                Severity.ERROR,
                technique.id,
                f"source_audit.pitfalls={audit.pitfalls!r} is outside the "
                f"controlled vocabulary {sorted(schema.PITFALLS_AUDIT_VALUES)}",
            )


CHECKS: Final[tuple[tuple[str, str, Check], ...]] = (
    ("C001", "metadata/root consistency", check_metadata_consistency),
    ("C002", "declared entry count", check_entry_count),
    ("C003", "id element present", check_id_element),
    ("C004", "id uniqueness and form", check_id_uniqueness),
    ("C005", "category registration", check_categories_declared),
    ("C006", "controlled vocabularies", check_controlled_vocabularies),
    ("C007", "single canonical serialization", check_serialization),
    ("C008", "per-entry schema stamp", check_schema_stamp),
    ("C009", "duplicate entries", check_duplicates),
    ("C010", "referential integrity", check_referential_integrity),
    ("C011", "alias resolution", check_alias_collisions),
    ("C012", "template variable agreement", check_template_variables),
    ("C013", "corpus_file consistency", check_corpus_file_consistency),
    ("C014", "source completeness", check_source_quality),
    ("C015", "mandatory content", check_required_text),
    ("C016", "author-string format", check_author_format),
    ("C017", "relationship-graph connectivity", check_graph_connectivity),
    ("C018", "render-label coverage", check_render_labels),
    ("C019", "prose audit labelling", check_source_audit),
)


# --------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Report:
    findings: tuple[Finding, ...]
    strict: bool

    @property
    def errors(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity == Severity.ERROR)

    @property
    def warnings(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity == Severity.WARNING)

    @property
    def waived(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity == Severity.WAIVED)

    @property
    def ok(self) -> bool:
        return not self.errors and not (self.strict and self.warnings)

    def exit_code(self) -> int:
        return 0 if self.ok else 1

    def by_check(self) -> dict[str, list[Finding]]:
        grouped: dict[str, list[Finding]] = {}
        for finding in self.findings:
            grouped.setdefault(finding.check_id, []).append(finding)
        return grouped


def run_checks(
    parsed: ParsedCatalog,
    *,
    strict: bool = False,
    allow_dangling: bool = False,
    show_waived: bool = False,
    only: Sequence[str] | None = None,
) -> Report:
    """Run the registry against a parsed catalog.

    ``only`` restricts execution to the given check ids, which is what makes a
    finding waivable in CI without editing the checks themselves.
    """
    context = CheckContext(
        catalog=parsed.catalog,
        notes=parsed.notes,
        allow_dangling=allow_dangling,
        show_waived=show_waived,
    )
    selected = set(only) if only else None
    findings: list[Finding] = []
    for check_id, _label, check in CHECKS:
        if selected is not None and check_id not in selected:
            continue
        findings.extend(check(context))
    findings.sort(key=lambda f: (f.check_id, f.technique_id, f.message))
    return Report(findings=tuple(findings), strict=strict)
