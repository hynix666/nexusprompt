"""Canonical definition of PromptNexus catalog schema 1.2.0.

This module is *descriptive only*: it states what a conforming catalog looks
like. It contains no remediation decisions (see :mod:`policy`) and no I/O
(see :mod:`model`). Keeping it dependency-free means the same constants can be
imported by the builder (``scripts/build_catalog.py``), the normalizer and the
validator, so the three cannot disagree about what "1.2.0" means -- which is
precisely the failure this whole package exists to prevent.
"""

from __future__ import annotations

from typing import Final

#: 1.3.0 adds the <source_audit> element. The bump is deliberate: adding an
#: element without one is the silent-drift behaviour this package exists to
#: catch, and consumers need a way to tell a record that predates the field
#: from one that omits it.
SCHEMA_VERSION: Final[str] = "1.3.0"
PREVIOUS_SCHEMA_VERSION: Final[str] = "1.2.0"

# --------------------------------------------------------------------------
# Element ordering
# --------------------------------------------------------------------------
# Order is part of the schema, not a formatting preference: a byte-stable
# serialization is what makes catalog diffs reviewable and builds reproducible.

TECHNIQUE_ELEMENT_ORDER: Final[tuple[str, ...]] = (
    "id",
    "name",
    "category",
    "subcategory",
    "executive_summary",
    "description",
    "verification_status",
    "cost_profile",
    "status",
    "corpus_file",
    "schema_version",
    "aliases",
    "when_to_use",
    "when_not_to_use",
    "known_pitfalls",
    "related_techniques",
    "tags",
    "primary_source",
    "secondary_sources",
    "usage_templates",
    "source_audit",
)

#: Elements that may be absent from a ``<technique>``. Everything else in
#: ``TECHNIQUE_ELEMENT_ORDER`` is mandatory. Absent means *omitted entirely* --
#: an empty element is a distinct (and invalid) state.
TECHNIQUE_OPTIONAL_ELEMENTS: Final[frozenset[str]] = frozenset(
    {"corpus_file", "secondary_sources"}
)

#: Child order of ``<source_audit>``.
SOURCE_AUDIT_ELEMENT_ORDER: Final[tuple[str, ...]] = ("description", "pitfalls")

#: What has been checked about a record's prose, and against what. Separate
#: axes because they are settled by different evidence: an abstract can confirm
#: what a technique does, and almost never states how it fails, so a description
#: and a pitfalls list are never verified by the same reading.
DESCRIPTION_AUDIT_VALUES: Final[frozenset[str]] = frozenset(
    {
        # Compared against the source abstract; unsupported claims removed.
        "verified-against-abstract",
        # Compared against the full paper.
        "verified-against-paper",
        # Never checked against the source.
        "unverified",
    }
)

PITFALLS_AUDIT_VALUES: Final[frozenset[str]] = frozenset(
    {
        # Each pitfall traced to the paper's own account of its limitations.
        "verified-against-paper",
        # Not checked. Claims may be sound practitioner knowledge; they are not
        # attributable to the cited source, and the record does not imply they are.
        "unverified",
    }
)

SOURCE_ELEMENT_ORDER: Final[tuple[str, ...]] = (
    "authors",
    "year",
    "title",
    "venue",
    "arxiv_id",
    "url",
)

#: ``arxiv_id`` and ``url`` may be empty strings for non-arXiv / offline
#: sources; the remaining source fields must carry text.
SOURCE_OPTIONAL_FIELDS: Final[frozenset[str]] = frozenset({"arxiv_id", "url"})

TEMPLATE_ELEMENT_ORDER: Final[tuple[str, ...]] = (
    "template_name",
    "template",
    "template_id",
    "determinism",
    "reproducibility_note",
    "variables",
)

VARIABLE_ELEMENT_ORDER: Final[tuple[str, ...]] = ("name", "description", "example")

METADATA_ELEMENT_ORDER: Final[tuple[str, ...]] = (
    "catalog_name",
    "schema_version",
    "catalog_version",
    "generated_at",
    "entry_count",
    "categories",
    "source_note",
)

ROOT_ATTRIBUTE_ORDER: Final[tuple[str, ...]] = (
    "schema_version",
    "catalog_version",
    "generated_at",
    "entry_count",
)

# --------------------------------------------------------------------------
# Controlled vocabularies
# --------------------------------------------------------------------------
# Closed sets. Anything outside them is drift and must either be mapped onto a
# member (policy.py) or deliberately promoted into the set here, with a code
# review attached. Silent growth of these sets is what produced 10 distinct
# `verification_status` values from an original 3.

STATUSES: Final[frozenset[str]] = frozenset(
    {
        # Sourced from the PROMPTS.zip PDF corpus.
        "corpus-present",
        # Peer-reviewed / preprint literature verified live against the publisher.
        "verified-external",
        # First-party vendor documentation or practitioner framework with no
        # academic source. Kept distinct because collapsing it into
        # `verified-external` would overstate the evidence tier.
        "practitioner-guide",
    }
)

VERIFICATION_STATUSES: Final[frozenset[str]] = frozenset(
    {
        # A machine or program can decide whether the output is correct.
        "verifier-checkable",
        # Correctness requires a model or human judge.
        "judge-checkable",
        # Nothing in the emitted text settles whether the technique worked.
        "unverifiable-by-text",
    }
)

COST_PROFILES: Final[frozenset[str]] = frozenset(
    {
        "single-call",
        "multi-call-fixed",
        "multi-call-adaptive",
        "agentic-loop",
        "training-time",
    }
)

DETERMINISM_VALUES: Final[frozenset[str]] = frozenset(
    {
        "deterministic-at-temperature-zero",
        "stochastic-by-design",
        "requires-external-system",
        "training-time-not-applicable",
    }
)

#: Field name -> allowed values, for the generic vocabulary check.
CONTROLLED_VOCABULARIES: Final[dict[str, frozenset[str]]] = {
    "description_audit": DESCRIPTION_AUDIT_VALUES,
    "pitfalls_audit": PITFALLS_AUDIT_VALUES,
    "status": STATUSES,
    "verification_status": VERIFICATION_STATUSES,
    "cost_profile": COST_PROFILES,
    "determinism": DETERMINISM_VALUES,
}

# --------------------------------------------------------------------------
# Lexical rules
# --------------------------------------------------------------------------

#: ``2201.11903`` or ``2201.11903v2``; also the pre-2007 ``math/0211159`` form.
ARXIV_ID_PATTERN: Final[str] = r"(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?/\d{7}(v\d+)?)"

#: Slug form used for ``technique/@id``, ``category`` and ``template_id``.
SLUG_PATTERN: Final[str] = r"[a-z0-9]+(-[a-z0-9]+)*"

#: ``template_id`` convention is ``<technique-id>--<template-slug>``.
TEMPLATE_ID_SEPARATOR: Final[str] = "--"

#: Marker attributes. 1.2.0 distinguishes "deliberately empty" from
#: "accidentally empty": an empty list container carries ``empty="true"`` and an
#: empty text leaf carries ``nil="true"``. An unmarked empty element is the
#: signature of a serializer that does not implement the schema.
EMPTY_MARKER_ATTRIBUTE: Final[str] = "empty"
NIL_MARKER_ATTRIBUTE: Final[str] = "nil"

#: Container elements and the tag of the items they hold.
LIST_CONTAINERS: Final[dict[str, str]] = {
    "aliases": "alias",
    "when_to_use": "item",
    "when_not_to_use": "item",
    "known_pitfalls": "pitfall",
    "related_techniques": "technique_id",
    "tags": "tag",
    "usage_templates": "template",
    "secondary_sources": "source",
    "variables": "variable",
    "categories": "category",
}

#: Placeholder syntax inside ``<template>`` bodies.
TEMPLATE_PLACEHOLDER_PATTERN: Final[str] = r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}"

#: Author strings that name no actual author. Entries carrying one of these
#: cannot be said to be "verified" against anything.
PLACEHOLDER_AUTHOR_VALUES: Final[frozenset[str]] = frozenset(
    {
        "various",
        "unknown",
        "n/a",
        "anonymous",
        "practitioner taxonomies",
        "tbd",
    }
)

#: "et al." legitimately truncates a long author list; it does not legitimately
#: stand in for one. Below this many named surnames, an "et al." is an
#: abbreviation the catalog's own convention does not use.
MIN_AUTHORS_BEFORE_ET_AL: Final[int] = 5

ET_AL_PATTERN: Final[str] = r"\bet\.?\s*al\.?\s*$"

#: Substrings that indicate an institution was recorded where authors belong.
PLACEHOLDER_AUTHOR_SUBSTRINGS: Final[tuple[str, ...]] = (
    "documentation",
    "best practices",
    "guide",
)
