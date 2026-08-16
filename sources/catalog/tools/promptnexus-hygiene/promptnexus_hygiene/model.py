"""Typed in-memory model of the catalog, plus strict parse / deterministic emit.

Design notes
------------
* Every dataclass is frozen. Normalization is expressed as pure functions that
  return new objects (``dataclasses.replace``), so a transform can never leave
  a half-mutated catalog behind and every step is trivially testable.
* Parsing is a trust boundary: unknown elements, missing mandatory elements and
  malformed structure raise :class:`CatalogParseError` with the offending
  technique id attached. The two *known* legacy defects -- a missing ``<id>``
  child and an empty ``<corpus_file>`` -- are tolerated and recorded in
  :class:`ParseNotes` instead, because repairing them is the whole point of the
  normalizer; failing to parse them would make the tool useless on real input.
* Serialization is byte-deterministic: fixed element order, fixed two-space
  indent, no timestamps injected at write time.

Security note: input is expected to be a first-party build artifact. We use
``xml.etree.ElementTree``, which does not resolve external entities, and guard
against unbounded input with an explicit size limit at the read boundary.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Sequence

from . import schema

__all__ = [
    "CatalogParseError",
    "SourceRef",
    "SourceAudit",
    "Variable",
    "Template",
    "Technique",
    "CatalogMetadata",
    "Catalog",
    "ParseNotes",
    "ParsedCatalog",
    "parse_catalog",
    "parse_string",
    "parse_json_string",
    "serialize_catalog",
    "write_catalog",
]

#: 64 MiB. The real catalog is <1 MiB; anything larger is a mistake or an
#: attempt to exhaust memory via an expansion attack.
MAX_INPUT_BYTES: Final[int] = 64 * 1024 * 1024

_INDENT: Final[str] = "  "


class CatalogParseError(ValueError):
    """Raised when input cannot be represented in the 1.2.0 model at all."""

    def __init__(self, message: str, *, technique_id: str | None = None) -> None:
        self.technique_id = technique_id
        super().__init__(
            f"[{technique_id}] {message}" if technique_id else message
        )


# --------------------------------------------------------------------------
# Value objects
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SourceRef:
    authors: str
    year: str
    title: str
    venue: str
    arxiv_id: str = ""
    url: str = ""


@dataclass(frozen=True, slots=True)
class Variable:
    name: str
    description: str
    example: str


@dataclass(frozen=True, slots=True)
class Template:
    template_name: str
    template: str
    template_id: str
    determinism: str
    reproducibility_note: str
    variables: tuple[Variable, ...] = ()


@dataclass(frozen=True, slots=True)
class SourceAudit:
    """What has been checked about this record's prose, and against what."""

    description: str = "unverified"
    pitfalls: str = "unverified"


@dataclass(frozen=True, slots=True)
class Technique:
    id: str
    name: str
    category: str
    subcategory: str
    executive_summary: str
    description: str
    verification_status: str
    cost_profile: str
    status: str
    schema_version: str
    aliases: tuple[str, ...] = ()
    when_to_use: tuple[str, ...] = ()
    when_not_to_use: tuple[str, ...] = ()
    known_pitfalls: tuple[str, ...] = ()
    related_techniques: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    primary_source: SourceRef | None = None
    secondary_sources: tuple[SourceRef, ...] = ()
    usage_templates: tuple[Template, ...] = ()
    corpus_file: str | None = None
    source_audit: SourceAudit = SourceAudit()


@dataclass(frozen=True, slots=True)
class CatalogMetadata:
    catalog_name: str
    schema_version: str
    catalog_version: str
    generated_at: str
    entry_count: str
    categories: tuple[str, ...]
    source_note: str


@dataclass(frozen=True, slots=True)
class Catalog:
    schema_version: str
    catalog_version: str
    generated_at: str
    entry_count: str
    metadata: CatalogMetadata
    techniques: tuple[Technique, ...]

    def by_id(self) -> dict[str, Technique]:
        """Index techniques by id. Later duplicates win; use the validator's
        uniqueness check to detect that case rather than relying on this."""
        return {t.id: t for t in self.techniques}

    def ids(self) -> frozenset[str]:
        return frozenset(t.id for t in self.techniques)


@dataclass(frozen=True, slots=True)
class ParseNotes:
    """Defects tolerated at parse time so they can be reported or repaired."""

    missing_id_element: frozenset[str] = frozenset()
    empty_corpus_file: frozenset[str] = frozenset()
    unindented_entries: frozenset[str] = frozenset()
    unmarked_empty_elements: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class ParsedCatalog:
    catalog: Catalog
    notes: ParseNotes


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def _text(element: ET.Element | None) -> str:
    if element is None or element.text is None:
        return ""
    return element.text.strip()


def _child_texts(parent: ET.Element | None, tag: str) -> tuple[str, ...]:
    if parent is None:
        return ()
    return tuple(_text(child) for child in parent.findall(tag))


def _require(parent: ET.Element, tag: str, technique_id: str) -> ET.Element:
    found = parent.find(tag)
    if found is None:
        raise CatalogParseError(
            f"mandatory element <{tag}> is missing", technique_id=technique_id
        )
    return found


def _parse_source(element: ET.Element, technique_id: str) -> SourceRef:
    unknown = {c.tag for c in element} - set(schema.SOURCE_ELEMENT_ORDER)
    if unknown:
        raise CatalogParseError(
            f"unknown source element(s): {sorted(unknown)}", technique_id=technique_id
        )
    return SourceRef(
        authors=_text(element.find("authors")),
        year=_text(element.find("year")),
        title=_text(element.find("title")),
        venue=_text(element.find("venue")),
        arxiv_id=_text(element.find("arxiv_id")),
        url=_text(element.find("url")),
    )


def _parse_template(element: ET.Element, technique_id: str) -> Template:
    unknown = {c.tag for c in element} - set(schema.TEMPLATE_ELEMENT_ORDER)
    if unknown:
        raise CatalogParseError(
            f"unknown template element(s): {sorted(unknown)}", technique_id=technique_id
        )
    variables_parent = element.find("variables")
    variables: list[Variable] = []
    if variables_parent is not None:
        for var in variables_parent.findall("variable"):
            var_unknown = {c.tag for c in var} - set(schema.VARIABLE_ELEMENT_ORDER)
            if var_unknown:
                raise CatalogParseError(
                    f"unknown variable element(s): {sorted(var_unknown)}",
                    technique_id=technique_id,
                )
            variables.append(
                Variable(
                    name=_text(var.find("name")),
                    description=_text(var.find("description")),
                    example=_text(var.find("example")),
                )
            )
    return Template(
        template_name=_text(_require(element, "template_name", technique_id)),
        template=_text(_require(element, "template", technique_id)),
        template_id=_text(_require(element, "template_id", technique_id)),
        determinism=_text(_require(element, "determinism", technique_id)),
        reproducibility_note=_text(element.find("reproducibility_note")),
        variables=tuple(variables),
    )


def _parse_technique(
    element: ET.Element,
    *,
    missing_id: set[str],
    empty_corpus: set[str],
    unindented: set[str],
    unmarked: set[str],
) -> Technique:
    attr_id = (element.get("id") or "").strip()
    id_element = element.find("id")
    element_id = _text(id_element)
    technique_id = attr_id or element_id
    if not technique_id:
        raise CatalogParseError("technique has neither @id nor <id>")
    if id_element is None:
        missing_id.add(technique_id)
    elif attr_id and element_id and attr_id != element_id:
        raise CatalogParseError(
            f"@id={attr_id!r} disagrees with <id>{element_id!r}",
            technique_id=technique_id,
        )

    unknown = {c.tag for c in element} - set(schema.TECHNIQUE_ELEMENT_ORDER)
    if unknown:
        raise CatalogParseError(
            f"unknown element(s): {sorted(unknown)}", technique_id=technique_id
        )

    corpus_element = element.find("corpus_file")
    corpus_file: str | None = None
    if corpus_element is not None:
        corpus_file = _text(corpus_element)
        if not corpus_file:
            empty_corpus.add(technique_id)
            corpus_file = None

    # Entries emitted by a second, non-pretty-printing serializer have no
    # newline between the technique tag and its first child.
    if element.text is None or "\n" not in element.text:
        unindented.add(technique_id)

    # An element that is empty but carries neither `empty="true"` nor
    # `nil="true"` was written by a serializer that does not implement 1.2.0.
    for descendant in element.iter():
        if descendant is element or len(descendant) or (descendant.text or "").strip():
            continue
        if descendant.tag in schema.LIST_CONTAINERS:
            marker = schema.EMPTY_MARKER_ATTRIBUTE
        else:
            marker = schema.NIL_MARKER_ATTRIBUTE
        if descendant.get(marker) != "true":
            unmarked.add(technique_id)
            break

    for mandatory in (
        "name",
        "category",
        "subcategory",
        "executive_summary",
        "description",
        "verification_status",
        "cost_profile",
        "status",
        "schema_version",
        "primary_source",
        "usage_templates",
    ):
        _require(element, mandatory, technique_id)

    secondary_parent = element.find("secondary_sources")
    secondary = (
        tuple(
            _parse_source(src, technique_id)
            for src in secondary_parent.findall("source")
        )
        if secondary_parent is not None
        else ()
    )

    audit_element = element.find("source_audit")
    audit = SourceAudit()
    if audit_element is not None:
        audit = SourceAudit(
            description=_text(audit_element.find("description")) or "unverified",
            pitfalls=_text(audit_element.find("pitfalls")) or "unverified",
        )

    templates_parent = _require(element, "usage_templates", technique_id)
    templates = tuple(
        _parse_template(tpl, technique_id)
        for tpl in templates_parent.findall("template")
    )

    return Technique(
        id=technique_id,
        name=_text(element.find("name")),
        category=_text(element.find("category")),
        subcategory=_text(element.find("subcategory")),
        executive_summary=_text(element.find("executive_summary")),
        description=_text(element.find("description")),
        verification_status=_text(element.find("verification_status")),
        cost_profile=_text(element.find("cost_profile")),
        status=_text(element.find("status")),
        schema_version=_text(element.find("schema_version")),
        aliases=_child_texts(element.find("aliases"), "alias"),
        when_to_use=_child_texts(element.find("when_to_use"), "item"),
        when_not_to_use=_child_texts(element.find("when_not_to_use"), "item"),
        known_pitfalls=_child_texts(element.find("known_pitfalls"), "pitfall"),
        related_techniques=_child_texts(
            element.find("related_techniques"), "technique_id"
        ),
        tags=_child_texts(element.find("tags"), "tag"),
        primary_source=_parse_source(
            _require(element, "primary_source", technique_id), technique_id
        ),
        secondary_sources=secondary,
        usage_templates=templates,
        corpus_file=corpus_file,
        source_audit=audit,
    )


def _parse_metadata(element: ET.Element) -> CatalogMetadata:
    unknown = {c.tag for c in element} - set(schema.METADATA_ELEMENT_ORDER)
    if unknown:
        raise CatalogParseError(f"unknown metadata element(s): {sorted(unknown)}")
    categories_parent = element.find("categories")
    return CatalogMetadata(
        catalog_name=_text(element.find("catalog_name")),
        schema_version=_text(element.find("schema_version")),
        catalog_version=_text(element.find("catalog_version")),
        generated_at=_text(element.find("generated_at")),
        entry_count=_text(element.find("entry_count")),
        categories=_child_texts(categories_parent, "category"),
        source_note=_text(element.find("source_note")),
    )


def parse_string(xml_text: str) -> ParsedCatalog:
    """Parse catalog XML from a string. Raises :class:`CatalogParseError`."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:  # pragma: no cover - exercised via parse_catalog
        raise CatalogParseError(f"XML is not well-formed: {exc}") from exc

    if root.tag != "PromptTechniqueCatalog":
        raise CatalogParseError(f"unexpected root element <{root.tag}>")

    metadata_element = root.find("catalog_metadata")
    if metadata_element is None:
        raise CatalogParseError("mandatory <catalog_metadata> is missing")
    techniques_element = root.find("techniques")
    if techniques_element is None:
        raise CatalogParseError("mandatory <techniques> is missing")

    missing_id: set[str] = set()
    empty_corpus: set[str] = set()
    unindented: set[str] = set()
    unmarked: set[str] = set()
    techniques = tuple(
        _parse_technique(
            el,
            missing_id=missing_id,
            empty_corpus=empty_corpus,
            unindented=unindented,
            unmarked=unmarked,
        )
        for el in techniques_element.findall("technique")
    )

    catalog = Catalog(
        schema_version=(root.get("schema_version") or "").strip(),
        catalog_version=(root.get("catalog_version") or "").strip(),
        generated_at=(root.get("generated_at") or "").strip(),
        entry_count=(root.get("entry_count") or "").strip(),
        metadata=_parse_metadata(metadata_element),
        techniques=techniques,
    )
    notes = ParseNotes(
        missing_id_element=frozenset(missing_id),
        empty_corpus_file=frozenset(empty_corpus),
        unindented_entries=frozenset(unindented),
        unmarked_empty_elements=frozenset(unmarked),
    )
    return ParsedCatalog(catalog=catalog, notes=notes)




# --------------------------------------------------------------------------
# JSON input
# --------------------------------------------------------------------------
# The JSON file is the source of truth, so the gate has to be able to run on it
# directly. Validating only the XML export is what let a fork of the export
# accumulate 174 findings while the source of truth stayed clean.


def _source_from_json(data: dict | None) -> SourceRef | None:
    if not data:
        return None
    year = data.get("year")
    return SourceRef(
        authors=str(data.get("authors") or "").strip(),
        year="" if year is None else str(year).strip(),
        title=str(data.get("title") or "").strip(),
        venue=str(data.get("venue") or "").strip(),
        arxiv_id=str(data.get("arxiv_id") or "").strip(),
        url=str(data.get("url") or "").strip(),
    )


def _technique_from_json(record: dict) -> Technique:
    technique_id = str(record.get("id") or "").strip()
    if not technique_id:
        raise CatalogParseError("record has no id")
    templates = []
    for raw in record.get("usage_templates") or []:
        templates.append(
            Template(
                template_name=str(raw.get("template_name") or "").strip(),
                template=str(raw.get("template") or "").strip(),
                template_id=str(raw.get("template_id") or "").strip(),
                determinism=str(raw.get("determinism") or "").strip(),
                reproducibility_note=str(raw.get("reproducibility_note") or "").strip(),
                variables=tuple(
                    Variable(
                        name=str(v.get("name") or "").strip(),
                        description=str(v.get("description") or "").strip(),
                        example=str(v.get("example") or "").strip(),
                    )
                    for v in (raw.get("variables") or [])
                ),
            )
        )
    corpus_file = record.get("corpus_file")
    audit_raw = record.get("source_audit") or {}
    audit = SourceAudit(
        description=str(audit_raw.get("description") or "unverified"),
        pitfalls=str(audit_raw.get("pitfalls") or "unverified"),
    )
    return Technique(
        id=technique_id,
        name=str(record.get("name") or "").strip(),
        category=str(record.get("category") or "").strip(),
        subcategory=str(record.get("subcategory") or "").strip(),
        executive_summary=str(record.get("executive_summary") or "").strip(),
        description=str(record.get("description") or "").strip(),
        verification_status=str(record.get("verification_status") or "").strip(),
        cost_profile=str(record.get("cost_profile") or "").strip(),
        status=str(record.get("status") or "").strip(),
        schema_version=str(record.get("schema_version") or "").strip(),
        aliases=tuple(str(a).strip() for a in record.get("aliases") or []),
        when_to_use=tuple(str(a).strip() for a in record.get("when_to_use") or []),
        when_not_to_use=tuple(
            str(a).strip() for a in record.get("when_not_to_use") or []
        ),
        known_pitfalls=tuple(str(a).strip() for a in record.get("known_pitfalls") or []),
        related_techniques=tuple(
            str(a).strip() for a in record.get("related_techniques") or []
        ),
        tags=tuple(str(a).strip() for a in record.get("tags") or []),
        primary_source=_source_from_json(record.get("primary_source")),
        secondary_sources=tuple(
            s for s in (
                _source_from_json(x) for x in record.get("secondary_sources") or []
            ) if s is not None
        ),
        usage_templates=tuple(templates),
        corpus_file=str(corpus_file).strip() if corpus_file else None,
        source_audit=audit,
    )


def parse_json_string(text: str) -> ParsedCatalog:
    """Parse the source-of-truth JSON into the same model the XML parses into."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CatalogParseError(f"JSON is not well-formed: {exc}") from exc
    if not isinstance(data, dict):
        raise CatalogParseError("top level must be an object")
    metadata_raw = data.get("catalog_metadata")
    if not isinstance(metadata_raw, dict):
        raise CatalogParseError("mandatory 'catalog_metadata' is missing")
    records = data.get("techniques")
    if not isinstance(records, list):
        raise CatalogParseError("mandatory 'techniques' array is missing")

    techniques = tuple(_technique_from_json(r) for r in records)
    metadata = CatalogMetadata(
        catalog_name=str(metadata_raw.get("catalog_name") or "").strip(),
        schema_version=str(metadata_raw.get("schema_version") or "").strip(),
        catalog_version=str(metadata_raw.get("catalog_version") or "").strip(),
        generated_at=str(metadata_raw.get("generated_at") or "").strip(),
        entry_count=str(metadata_raw.get("entry_count") or "").strip(),
        categories=tuple(str(c).strip() for c in metadata_raw.get("categories") or []),
        source_note=str(metadata_raw.get("source_note") or "").strip(),
    )
    # JSON carries no root attributes; the metadata block is the only stamp, so
    # the two agree by construction and C001 is trivially satisfied.
    catalog = Catalog(
        schema_version=metadata.schema_version,
        catalog_version=metadata.catalog_version,
        generated_at=metadata.generated_at,
        entry_count=metadata.entry_count,
        metadata=metadata,
        techniques=techniques,
    )
    return ParsedCatalog(catalog=catalog, notes=ParseNotes())


def parse_catalog(path: str | Path) -> ParsedCatalog:
    """Read and parse a catalog file, dispatching on suffix (.xml or .json)."""
    file_path = Path(path)
    size = file_path.stat().st_size
    if size > MAX_INPUT_BYTES:
        raise CatalogParseError(
            f"{file_path} is {size} bytes, above the {MAX_INPUT_BYTES}-byte limit"
        )
    text = file_path.read_text(encoding="utf-8")
    if file_path.suffix.lower() == ".json":
        return parse_json_string(text)
    return parse_string(text)


# --------------------------------------------------------------------------
# Serialization
# --------------------------------------------------------------------------


def _leaf(parent: ET.Element, tag: str, text: str) -> ET.Element:
    """Emit a text leaf. An empty leaf carries ``nil="true"`` -- the 1.2.0
    convention that distinguishes "known to be absent" from "forgotten"."""
    child = ET.SubElement(parent, tag)
    if text:
        child.text = text
    else:
        child.set(schema.NIL_MARKER_ATTRIBUTE, "true")
    return child


def _list_element(
    parent: ET.Element, tag: str, item_tag: str, values: Sequence[str]
) -> ET.Element:
    """Emit a list container. An empty container carries ``empty="true"``."""
    container = ET.SubElement(parent, tag)
    if not values:
        container.set(schema.EMPTY_MARKER_ATTRIBUTE, "true")
        return container
    for value in values:
        _leaf(container, item_tag, value)
    return container


def _source_element(parent: ET.Element, tag: str, source: SourceRef) -> None:
    element = ET.SubElement(parent, tag)
    for field_name in schema.SOURCE_ELEMENT_ORDER:
        _leaf(element, field_name, getattr(source, field_name))


def _technique_element(technique: Technique) -> ET.Element:
    element = ET.Element("technique", {"id": technique.id})
    _leaf(element, "id", technique.id)
    _leaf(element, "name", technique.name)
    _leaf(element, "category", technique.category)
    _leaf(element, "subcategory", technique.subcategory)
    _leaf(element, "executive_summary", technique.executive_summary)
    _leaf(element, "description", technique.description)
    _leaf(element, "verification_status", technique.verification_status)
    _leaf(element, "cost_profile", technique.cost_profile)
    _leaf(element, "status", technique.status)
    if technique.corpus_file:
        _leaf(element, "corpus_file", technique.corpus_file)
    _leaf(element, "schema_version", technique.schema_version)
    _list_element(element, "aliases", "alias", technique.aliases)
    _list_element(element, "when_to_use", "item", technique.when_to_use)
    _list_element(element, "when_not_to_use", "item", technique.when_not_to_use)
    _list_element(element, "known_pitfalls", "pitfall", technique.known_pitfalls)
    _list_element(
        element, "related_techniques", "technique_id", technique.related_techniques
    )
    _list_element(element, "tags", "tag", technique.tags)
    if technique.primary_source is not None:
        _source_element(element, "primary_source", technique.primary_source)
    if technique.secondary_sources:
        container = ET.SubElement(element, "secondary_sources")
        for source in technique.secondary_sources:
            _source_element(container, "source", source)
    templates = ET.SubElement(element, "usage_templates")
    for template in technique.usage_templates:
        template_element = ET.SubElement(templates, "template")
        _leaf(template_element, "template_name", template.template_name)
        _leaf(template_element, "template", template.template)
        _leaf(template_element, "template_id", template.template_id)
        _leaf(template_element, "determinism", template.determinism)
        _leaf(template_element, "reproducibility_note", template.reproducibility_note)
        variables = ET.SubElement(template_element, "variables")
        if not template.variables:
            variables.set(schema.EMPTY_MARKER_ATTRIBUTE, "true")
        for variable in template.variables:
            variable_element = ET.SubElement(variables, "variable")
            for field_name in schema.VARIABLE_ELEMENT_ORDER:
                _leaf(variable_element, field_name, getattr(variable, field_name))
    audit = ET.SubElement(element, "source_audit")
    _leaf(audit, "description", technique.source_audit.description)
    _leaf(audit, "pitfalls", technique.source_audit.pitfalls)
    return element


def serialize_catalog(catalog: Catalog) -> str:
    """Render a catalog to canonical XML text. Deterministic for a given input."""
    root = ET.Element("PromptTechniqueCatalog")
    for attribute in schema.ROOT_ATTRIBUTE_ORDER:
        root.set(attribute, getattr(catalog, attribute))

    metadata = ET.SubElement(root, "catalog_metadata")
    _leaf(metadata, "catalog_name", catalog.metadata.catalog_name)
    _leaf(metadata, "schema_version", catalog.metadata.schema_version)
    _leaf(metadata, "catalog_version", catalog.metadata.catalog_version)
    _leaf(metadata, "generated_at", catalog.metadata.generated_at)
    _leaf(metadata, "entry_count", catalog.metadata.entry_count)
    _list_element(metadata, "categories", "category", catalog.metadata.categories)
    _leaf(metadata, "source_note", catalog.metadata.source_note)

    techniques = ET.SubElement(root, "techniques")
    for technique in catalog.techniques:
        techniques.append(_technique_element(technique))

    ET.indent(root, space=_INDENT)
    body = ET.tostring(root, encoding="unicode", short_empty_elements=True)
    return f"<?xml version='1.0' encoding='UTF-8'?>\n{body}\n"


def write_catalog(catalog: Catalog, path: str | Path) -> int:
    """Write canonical XML to ``path``. Returns the number of bytes written."""
    text = serialize_catalog(catalog)
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))
