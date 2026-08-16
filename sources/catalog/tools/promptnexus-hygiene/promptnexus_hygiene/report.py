"""Rendering of validation reports and normalization ledgers.

Kept separate from the logic that produces them so that output format is never
a reason to touch a check or a transform. All renderers are pure
``object -> str``; the CLI owns writing.
"""

from __future__ import annotations

import json
from typing import Iterable

from .normalize import NormalizationResult
from .validate import Finding, Report, Severity, CHECKS

__all__ = [
    "render_report_text",
    "render_report_json",
    "render_report_github",
    "render_ledger_json",
    "render_ledger_markdown",
]

_CHECK_LABELS = {check_id: label for check_id, label, _ in CHECKS}


def _bullet(finding: Finding) -> str:
    return f"  {finding.severity:<7} {finding.technique_id}: {finding.message}"


def render_report_text(report: Report, *, source: str) -> str:
    """Human-readable summary, grouped by check id."""
    lines = [f"PromptNexus catalog validation - {source}", ""]
    grouped = report.by_check()
    if not grouped:
        lines.append("No findings.")
    for check_id, _label, _check in CHECKS:
        findings = grouped.get(check_id)
        if not findings:
            continue
        errors = sum(1 for f in findings if f.severity == Severity.ERROR)
        warnings = sum(1 for f in findings if f.severity == Severity.WARNING)
        waived = len(findings) - errors - warnings
        summary = f"{errors} error(s), {warnings} warning(s)"
        if waived:
            summary += f", {waived} waived"
        lines.append(f"{check_id} {_CHECK_LABELS[check_id]}: {summary}")
        lines.extend(_bullet(f) for f in findings)
        lines.append("")
    total = f"TOTAL: {len(report.errors)} error(s), {len(report.warnings)} warning(s)"
    if report.waived:
        total += f", {len(report.waived)} waived (reviewed, never fails a build)"
    if report.strict:
        total += " [strict: warnings fail the build]"
    lines.append(total)
    lines.append("RESULT: " + ("PASS" if report.ok else "FAIL"))
    return "\n".join(lines) + "\n"


def render_report_json(report: Report, *, source: str) -> str:
    """Machine-readable report. Stable key order for diffable CI artifacts."""
    payload = {
        "source": source,
        "strict": report.strict,
        "ok": report.ok,
        "error_count": len(report.errors),
        "warning_count": len(report.warnings),
        "waived_count": len(report.waived),
        "counts_by_check": {
            check_id: len(findings) for check_id, findings in sorted(report.by_check().items())
        },
        "findings": [f.as_dict() for f in report.findings],
    }
    return json.dumps(payload, indent=2, sort_keys=False, ensure_ascii=False) + "\n"


def render_report_github(report: Report, *, source: str) -> str:
    """GitHub Actions annotations, so findings land on the PR diff."""
    lines = []
    for finding in report.findings:
        if finding.severity == Severity.WAIVED:
            continue
        level = "error" if finding.severity == Severity.ERROR else "warning"
        message = f"{finding.check_id} {finding.technique_id}: {finding.message}"
        lines.append(f"::{level} file={source},title={finding.check_id}::{message}")
    return "\n".join(lines) + ("\n" if lines else "")


def render_ledger_json(result: NormalizationResult, *, source: str) -> str:
    """Every edit, machine-readable, for replay against the JSON source of truth."""
    payload = {
        "source": source,
        "change_count": len(result.changes),
        "counts_by_kind": {
            kind: len(changes)
            for kind, changes in sorted(result.changes_by_kind().items())
        },
        "changes": [c.as_dict() for c in result.changes],
        "manual_actions": list(result.manual_actions),
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def _table(rows: Iterable[tuple[str, ...]], headers: tuple[str, ...]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        cells = [cell.replace("|", "\\|").replace("\n", " ") for cell in row]
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def render_ledger_markdown(result: NormalizationResult, *, source: str) -> str:
    """Reviewable ledger. One section per change kind, rationale on every row."""
    grouped = result.changes_by_kind()
    lines = [
        "# Catalog normalization ledger",
        "",
        f"Source: `{source}`",
        "",
        f"Entries after normalization: **{len(result.catalog.techniques)}** "
        f"(catalog_version `{result.catalog.catalog_version}`, "
        f"schema `{result.catalog.schema_version}`)",
        "",
        f"Total changes: **{len(result.changes)}**",
        "",
    ]

    lines.append("## Summary")
    lines.append("")
    lines.extend(
        _table(
            ((kind, str(len(changes))) for kind, changes in sorted(grouped.items())),
            ("change kind", "count"),
        )
    )
    lines.append("")

    for kind, changes in sorted(grouped.items()):
        lines.append(f"## {kind} ({len(changes)})")
        lines.append("")
        # Serialization repairs are uniform across many entries; collapse them
        # to one row per rationale plus the affected id list.
        if kind == "serialization":
            by_field: dict[tuple[str, str, str, str], list[str]] = {}
            for change in changes:
                key = (change.field, change.before, change.after, change.rationale)
                by_field.setdefault(key, []).append(change.technique_id)
            rows = [
                (field, before, after, str(len(ids)), rationale)
                for (field, before, after, rationale), ids in sorted(by_field.items())
            ]
            lines.extend(
                _table(rows, ("field", "before", "after", "entries", "rationale"))
            )
        else:
            rows = [
                (c.technique_id, c.field, c.before, c.after, c.rationale)
                for c in changes
            ]
            lines.extend(
                _table(rows, ("entry", "field", "before", "after", "rationale"))
            )
        lines.append("")

    if result.manual_actions:
        lines.append("## Manual actions the normalizer will not perform")
        lines.append("")
        lines.append(
            "These need a source consulted or an editorial decision made. The "
            "validator keeps reporting them until they are fixed upstream."
        )
        lines.append("")
        for action in result.manual_actions:
            lines.append(f"- {action}")
        lines.append("")

    return "\n".join(lines)
