"""Human-readable renderings: the Markdown catalog and the PDF.

**Read this before using it.** Every other module here has avoided rendering
prose, because `scripts/build_catalog.py` already does it and a second generator
is what let the exports drift 47 records apart. This module exists because it
was asked for, and it manages that risk in the only honest way available: the
display strings below were *extracted from the shipped
`PROMPT_TECHNIQUE_CATALOG.md`*, not invented, so the output matches the
builder's own voice — down to the emoji and the reproducibility sentences.

Two consequences worth stating plainly:

* If the real builder still owns the published Markdown, this output will differ
  from it in whatever ways the two implementations differ, and CI's
  "generated exports differ from committed" step will say so. That is the check
  working, not a bug.
* The clean resolution is to pick one owner. Either regenerate the Markdown here
  and drop the builder's Markdown step, or keep the builder's and treat this as
  a preview. Running both and hoping they agree is the arrangement that failed.

New in v1.20.0: every record renders its `source_audit`, so a reader deep in an
entry can see what has been checked about it without going back to the header.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

from . import labels
from .model import Catalog, SourceRef, Technique

__all__ = ["catalog_to_markdown", "write_markdown", "write_pdf"]

#: Status line, with the corpus filename interpolated where there is one.
STATUS_DISPLAY: Final[dict[str, str]] = {
    "corpus-present": "\U0001F4C4 in local corpus (`{corpus_file}`)",
    "verified-external": "\U0001F517 verified externally (arXiv)",
    "practitioner-guide": "\U0001F4D8 practitioner guide (vendor documentation)",
}

VERIFICATION_DISPLAY: Final[dict[str, str]] = {
    "verifier-checkable": "verifier-checkable",
    "judge-checkable": "judge-checkable",
    "unverifiable-by-text": "unverifiable from text alone",
}

COST_DISPLAY: Final[dict[str, str]] = {
    "single-call": "single call",
    "multi-call-fixed": "multi-call, fixed cost",
    "multi-call-adaptive": "multi-call, adaptive/unbounded cost",
    "agentic-loop": "agentic loop",
    "training-time": "training-time (not inference prompting)",
}

#: Label plus the explanation the builder prints after an em dash.
REPRODUCIBILITY_DISPLAY: Final[dict[str, tuple[str, str]]] = {
    "deterministic-at-temperature-zero": (
        "\U0001F3AF deterministic at temperature 0",
        "A single LLM call (or a fixed sequence of them) with no external system "
        "dependency; running this template again at temperature 0 against the "
        "same model version should reproduce the same output.",
    ),
    "stochastic-by-design": (
        "\U0001F3B2 stochastic by design",
        "This template intentionally samples multiple times or explores "
        "adaptively; outputs vary run to run by design (explicit temperature>0 "
        "sampling, or multi-branch search whose path depends on intermediate "
        "stochastic choices).",
    ),
    "requires-external-system": (
        "\U0001F50C requires external system",
        "This template depends on an external system (retrieval index, tool, "
        "solver, or interpreter) whose own behavior is outside the prompt's "
        "control; bit-for-bit reproducibility requires that system's state to "
        "also be fixed.",
    ),
    "training-time-not-applicable": (
        "\U0001F3D7\uFE0F training-time (not applicable)",
        "This template describes a training-time process (fine-tuning or policy "
        "training), not a single reproducible inference call; reproducibility "
        "depends on the training pipeline and data, not on prompt text alone.",
    ),
}

#: How the per-record audit state reads in prose.
AUDIT_DISPLAY: Final[dict[str, dict[str, str]]] = {
    "description": {
        "verified-against-abstract": "checked against the source abstract",
        "verified-against-paper": "checked against the source paper",
        "unverified": "not checked against the source",
    },
    "pitfalls": {
        "verified-against-paper": "traced to the paper's own account of its limitations",
        "unverified": "not traced to the source \u2014 treat as practitioner guidance",
    },
}

_GENERATED_NOTE: Final[str] = (
    "> This document is **generated**. Do not hand-edit it \u2014 edit "
    "`data/prompt_technique_catalog.json` and regenerate, so the "
    "machine-readable dataset and this human-readable catalog cannot drift "
    "apart. That guarantee held only while a single generator wrote every "
    "export; it failed once when a second path wrote to one of them."
)


def _anchor(heading: str) -> str:
    """GitHub-style heading anchor."""
    slug = heading.lower()
    slug = re.sub(r"[^\w\s-]", "", slug)
    return re.sub(r"[\s_]+", "-", slug).strip("-")


def _status_line(technique: Technique) -> str:
    template = STATUS_DISPLAY.get(technique.status)
    if template is None:
        raise KeyError(f"no status display for {technique.status!r}")
    return template.format(corpus_file=technique.corpus_file or "")


def _source_line(source: SourceRef) -> str:
    parts = [f"{source.authors} ({source.year}), *{source.title}*"]
    if source.venue:
        parts.append(source.venue)
    if source.arxiv_id:
        parts.append(f"[arXiv:{source.arxiv_id}](https://arxiv.org/abs/{source.arxiv_id})")
    elif source.url:
        parts.append(f"[link]({source.url})")
    return ", ".join(parts)


def _record_markdown(technique: Technique) -> list[str]:
    lines = [f"### {technique.name}"]
    alias_note = (
        f" \u00b7 aliases: {', '.join(technique.aliases)}" if technique.aliases else ""
    )
    lines.append(f"`{technique.id}`{alias_note}")
    lines.append("")
    lines.append(f"> {technique.executive_summary}")
    lines.append("")
    category = labels.CATEGORY_LABELS.get(technique.category, technique.category)
    lines.append(f"**Category:** {category} / {technique.subcategory}  ")
    lines.append(
        f"**Verification:** "
        f"{VERIFICATION_DISPLAY.get(technique.verification_status, technique.verification_status)}  "
    )
    lines.append(
        f"**Cost profile:** {COST_DISPLAY.get(technique.cost_profile, technique.cost_profile)}  "
    )
    lines.append(f"**Status:** {_status_line(technique)}")
    lines.append("")
    lines.append(technique.description)
    lines.append("")

    for heading, items in (
        ("When to use", technique.when_to_use),
        ("When not to use", technique.when_not_to_use),
        ("Known pitfalls", technique.known_pitfalls),
    ):
        if not items:
            continue
        lines.append(f"**{heading}**")
        lines.extend(f"- {item}" for item in items)
        lines.append("")

    if technique.primary_source is not None:
        lines.append("**Primary source**  ")
        lines.append(_source_line(technique.primary_source))
        lines.append("")
    for source in technique.secondary_sources:
        lines.append("**Secondary source**  ")
        lines.append(_source_line(source))
        lines.append("")

    audit = technique.source_audit
    lines.append(
        "**Source audit:** description "
        f"{AUDIT_DISPLAY['description'].get(audit.description, audit.description)}; "
        "pitfalls "
        f"{AUDIT_DISPLAY['pitfalls'].get(audit.pitfalls, audit.pitfalls)}."
    )
    lines.append("")

    if technique.related_techniques:
        joined = ", ".join(f"`{r}`" for r in technique.related_techniques)
        lines.append(f"**Related techniques:** {joined}")
        lines.append("")
    if technique.tags:
        lines.append(f"**Tags:** {', '.join(f'`{t}`' for t in technique.tags)}")
        lines.append("")

    lines.append("**Usage template(s)**")
    lines.append("")
    for template in technique.usage_templates:
        lines.append(f"*{template.template_name}*  `{template.template_id}`")
        label, explanation = REPRODUCIBILITY_DISPLAY.get(
            template.determinism, (template.determinism, template.reproducibility_note)
        )
        lines.append(f"**Reproducibility:** {label} \u2014 {explanation}")
        lines.append("```")
        lines.append(template.template)
        lines.append("```")
        if template.variables:
            lines.append("")
            for variable in template.variables:
                example = f" (e.g. `{variable.example}`)" if variable.example else ""
                lines.append(f"- `{{{{{variable.name}}}}}` \u2014 {variable.description}{example}")
        lines.append("")
    return lines


def catalog_to_markdown(catalog: Catalog) -> str:
    """Render the full human-readable catalog."""
    by_category: dict[str, list[Technique]] = {}
    for technique in catalog.techniques:
        by_category.setdefault(technique.category, []).append(technique)
    ordered = sorted(
        by_category, key=lambda c: labels.CATEGORY_LABELS.get(c, c).lower()
    )

    metadata = catalog.metadata
    lines = [
        f"# {metadata.catalog_name}",
        "",
        f"*Catalog version {metadata.catalog_version} \u00b7 schema version "
        f"{metadata.schema_version} \u00b7 generated {metadata.generated_at} \u00b7 "
        f"{len(catalog.techniques)} entries*",
        "",
        _GENERATED_NOTE,
        "",
        metadata.source_note,
        "",
        "## Table of Contents",
        "",
    ]
    for category in ordered:
        display = labels.CATEGORY_LABELS.get(category, category)
        entries = by_category[category]
        lines.append(f"- [{display}](#{_anchor(display)}) ({len(entries)})")
        for technique in entries:
            lines.append(f"  - [{technique.name}](#{_anchor(technique.name)})")
    lines.append("")

    for category in ordered:
        lines.append(f"## {labels.CATEGORY_LABELS.get(category, category)}")
        lines.append("")
        for technique in by_category[category]:
            lines.extend(_record_markdown(technique))
    return "\n".join(lines).rstrip() + "\n"


def write_markdown(catalog: Catalog, path: str | Path) -> int:
    text = catalog_to_markdown(catalog)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


# --------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------


def write_pdf(catalog: Catalog, path: str | Path) -> int:
    """Render the catalog to PDF via ReportLab.

    Emoji are stripped rather than drawn: the built-in Type 1 fonts have no
    glyphs for them, and ReportLab renders a missing glyph as a solid black box,
    which is worse than the word alone. The Markdown keeps them.

    Built in invariant mode. ReportLab otherwise stamps a creation timestamp and
    a random document id into every file, so two builds of an unchanged catalog
    differ -- which would make a "generated exports differ from committed" gate
    fire on every run and train everyone to ignore it.
    """
    from reportlab import rl_config

    rl_config.invariant = 1
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        KeepTogether,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
    )

    emoji = re.compile("[\U0001F000-\U0001FAFF\u2190-\u21FF\u2600-\u27BF\uFE0F]")

    def clean(text: str) -> str:
        text = emoji.sub("", text)
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
        text = re.sub(r"`([^`]+)`", r"<font face='Courier'>\1</font>", text)
        return " ".join(text.split())

    styles = getSampleStyleSheet()
    body = ParagraphStyle(
        "body", parent=styles["Normal"], fontSize=9, leading=12.5, spaceAfter=5,
        alignment=TA_LEFT,
    )
    small = ParagraphStyle("small", parent=body, fontSize=8, leading=10.5,
                           textColor="#555555")
    mono = ParagraphStyle("mono", parent=body, fontName="Courier", fontSize=7.4,
                          leading=9.2, leftIndent=8, textColor="#222222")
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=19, spaceAfter=10)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=14, spaceBefore=16,
                        spaceAfter=7)
    h3 = ParagraphStyle("h3", parent=styles["Heading3"], fontSize=11, spaceBefore=11,
                        spaceAfter=3)

    story: list = []
    metadata = catalog.metadata
    story.append(Paragraph(clean(metadata.catalog_name), h1))
    story.append(
        Paragraph(
            clean(
                f"Catalog version {metadata.catalog_version} · schema "
                f"{metadata.schema_version} · generated {metadata.generated_at} · "
                f"{len(catalog.techniques)} entries"
            ),
            small,
        )
    )
    story.append(Spacer(1, 6))
    story.append(Paragraph(clean(metadata.source_note), small))
    story.append(PageBreak())

    by_category: dict[str, list[Technique]] = {}
    for technique in catalog.techniques:
        by_category.setdefault(technique.category, []).append(technique)

    for category in sorted(
        by_category, key=lambda c: labels.CATEGORY_LABELS.get(c, c).lower()
    ):
        display = labels.CATEGORY_LABELS.get(category, category)
        story.append(Paragraph(clean(f"{display} ({len(by_category[category])})"), h2))
        for technique in by_category[category]:
            block = [
                Paragraph(clean(technique.name), h3),
                Paragraph(clean(f"`{technique.id}` — {technique.executive_summary}"), small),
            ]
            story.extend(block)
            story.append(
                Paragraph(
                    clean(
                        f"**Category:** {display} / {technique.subcategory} · "
                        f"**Verification:** {VERIFICATION_DISPLAY.get(technique.verification_status, '')} · "
                        f"**Cost:** {COST_DISPLAY.get(technique.cost_profile, '')} · "
                        f"**Status:** {_status_line(technique)}"
                    ),
                    small,
                )
            )
            story.append(Paragraph(clean(technique.description), body))
            for heading, items in (
                ("When to use", technique.when_to_use),
                ("When not to use", technique.when_not_to_use),
                ("Known pitfalls", technique.known_pitfalls),
            ):
                if not items:
                    continue
                story.append(Paragraph(clean(f"**{heading}**"), body))
                for item in items:
                    story.append(Paragraph(f"• {clean(item)}", body))
            if technique.primary_source is not None:
                story.append(
                    Paragraph(clean(f"**Source:** {_source_line(technique.primary_source)}"), small)
                )
            audit = technique.source_audit
            story.append(
                Paragraph(
                    clean(
                        "**Source audit:** description "
                        f"{AUDIT_DISPLAY['description'].get(audit.description, '')}; "
                        f"pitfalls {AUDIT_DISPLAY['pitfalls'].get(audit.pitfalls, '')}."
                    ),
                    small,
                )
            )
            for template in technique.usage_templates:
                story.append(
                    Paragraph(clean(f"**Template** `{template.template_id}`"), small)
                )
                for line in template.template.splitlines() or [""]:
                    story.append(Paragraph(clean(line) or "&nbsp;", mono))
            story.append(Spacer(1, 5))

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    SimpleDocTemplate(
        str(target),
        pagesize=A4,
        invariant=1,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=metadata.catalog_name,
        author="PromptNexus",
    ).build(story)
    return target.stat().st_size
