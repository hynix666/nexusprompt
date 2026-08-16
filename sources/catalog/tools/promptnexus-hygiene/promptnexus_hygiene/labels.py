"""Display labels for the human-readable renderings.

Extracted from the shipped `PROMPT_TECHNIQUE_CATALOG.md` rather than invented,
so the wording is the builder's own, then extended with the values the v1.20.0
patch introduces.

Why this exists: the Markdown and PDF renderings map slugs to prose
("reasoning-elicitation" → "Reasoning Elicitation", "corpus-present" → "📄 in
local corpus (...)"). Those maps live inside `scripts/build_catalog.py` and are
keyed on the 11 categories and 2 statuses that existed at v1.17.0. The patch
adds a category and a status neither map has seen, so the first build after
merging will either raise a KeyError or silently render a raw slug into the
human-facing catalog, depending on how the lookups are written.

:func:`missing_labels` turns that from a surprise into a build failure. Wire it
into the builder before merging, or copy the dictionaries into whatever
structure the builder already uses -- either way, the point is that adding a
vocabulary value and forgetting its label should not be possible.
"""

from __future__ import annotations

from typing import Final, Iterable

from .model import Catalog

__all__ = [
    "CATEGORY_LABELS",
    "VERIFICATION_STATUS_LABELS",
    "COST_PROFILE_LABELS",
    "STATUS_LABELS",
    "DETERMINISM_LABELS",
    "DESCRIPTION_AUDIT_LABELS",
    "PITFALLS_AUDIT_LABELS",
    "missing_labels",
]

#: Slug → section heading. The first eleven are exactly the strings the shipped
#: Markdown renders; the last is new in v1.20.0.
CATEGORY_LABELS: Final[dict[str, str]] = {
    "agentic-tool-use": "Agentic & Tool-Integrated Prompting",
    "automatic-prompt-optimization": "Automatic Prompt Optimization",
    "domain-specific-application": "Domain-Specific Application",
    "example-selection-formatting": "Example Selection & Formatting Reliability",
    "prompt-injection-defense": "Prompt Injection & Adversarial Defense",
    "prompt-inversion-analysis": "Prompt Inversion & Analysis",
    "reasoning-elicitation": "Reasoning Elicitation",
    "retrieval-augmentation": "Retrieval Augmentation",
    "self-verification-refinement": "Self-Verification & Refinement",
    "structured-constrained-output": "Structured / Constrained Output",
    "template-pattern-scaffolding": "Template & Pattern Scaffolding",
    # New in v1.20.0.
    "prompt-compression-context-engineering": "Prompt Compression & Context Engineering",
}

VERIFICATION_STATUS_LABELS: Final[dict[str, str]] = {
    "verifier-checkable": "verifier-checkable",
    "judge-checkable": "judge-checkable",
    "unverifiable-by-text": "unverifiable from text alone",
}

COST_PROFILE_LABELS: Final[dict[str, str]] = {
    "single-call": "single call",
    "multi-call-fixed": "multi-call, fixed cost",
    "multi-call-adaptive": "multi-call, adaptive/unbounded cost",
    "agentic-loop": "agentic loop",
    "training-time": "training-time (not inference prompting)",
}

#: ``corpus-present`` renders with the corpus filename interpolated, so its
#: value is a format string rather than a literal.
STATUS_LABELS: Final[dict[str, str]] = {
    "corpus-present": "📄 in local corpus (`{corpus_file}`)",
    "verified-external": "🔗 verified externally (arXiv)",
    # New in v1.20.0: first-party vendor documentation or a practitioner
    # framework with no academic source. Deliberately not folded into
    # verified-external, which would overstate the evidence tier.
    "practitioner-guide": "📘 practitioner guide (vendor documentation)",
}

DETERMINISM_LABELS: Final[dict[str, str]] = {
    "deterministic-at-temperature-zero": "deterministic at temperature 0",
    "stochastic-by-design": "stochastic by design",
    "requires-external-system": "requires an external system",
    "training-time-not-applicable": "training-time (not applicable)",
}

#: How the audit state reads in the Markdown and PDF. Phrased so that
#: "unverified" cannot be mistaken for "found to be wrong".
DESCRIPTION_AUDIT_LABELS: Final[dict[str, str]] = {
    "verified-against-abstract": "checked against the source abstract",
    "verified-against-paper": "checked against the source paper",
    "unverified": "not checked against the source",
}

PITFALLS_AUDIT_LABELS: Final[dict[str, str]] = {
    "verified-against-paper": "traced to the paper's own limitations",
    "unverified": "not traced to the source; treat as practitioner guidance",
}


_FIELD_MAPS: Final[tuple[tuple[str, dict[str, str]], ...]] = (
    ("category", CATEGORY_LABELS),
    ("verification_status", VERIFICATION_STATUS_LABELS),
    ("cost_profile", COST_PROFILE_LABELS),
    ("status", STATUS_LABELS),
)


def missing_labels(catalog: Catalog) -> dict[str, set[str]]:
    """Return every value in the catalog that no label map covers.

    An empty result is the precondition for rendering. Anything in it would
    reach the reader as a raw slug, or stop the build, depending on the
    builder's lookup style -- and a raw slug in a published catalog is the
    worse of the two, because nothing fails.
    """
    missing: dict[str, set[str]] = {}
    for field_name, labels in _FIELD_MAPS:
        unknown = {
            getattr(technique, field_name)
            for technique in catalog.techniques
            if getattr(technique, field_name) not in labels
        }
        if unknown:
            missing[field_name] = unknown

    declared = set(catalog.metadata.categories) - set(CATEGORY_LABELS)
    if declared:
        missing.setdefault("category", set()).update(declared)

    for value, table, label in (
        (
            {t.source_audit.description for t in catalog.techniques},
            DESCRIPTION_AUDIT_LABELS,
            "source_audit.description",
        ),
        (
            {t.source_audit.pitfalls for t in catalog.techniques},
            PITFALLS_AUDIT_LABELS,
            "source_audit.pitfalls",
        ),
    ):
        unknown = value - set(table)
        if unknown:
            missing[label] = unknown

    unknown_determinism = {
        template.determinism
        for technique in catalog.techniques
        for template in technique.usage_templates
        if template.determinism not in DETERMINISM_LABELS
    }
    if unknown_determinism:
        missing["determinism"] = unknown_determinism
    return missing


def format_status(status: str, corpus_file: str | None) -> str:
    """Render a status label, interpolating the corpus filename when present."""
    template = STATUS_LABELS.get(status)
    if template is None:
        raise KeyError(f"no display label for status {status!r}")
    return template.format(corpus_file=corpus_file or "")
