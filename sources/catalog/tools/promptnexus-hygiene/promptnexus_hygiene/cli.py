"""Command-line entry points.

Exit codes (both commands):
  0  success
  1  validation failed / normalization produced a catalog that still fails
  2  usage error or input that cannot be parsed at all
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Sequence

from . import policy, report as report_mod
from .bundle import write_bundle
from .exports import catalog_to_json, compare_exports
from .patch import build_patch, render_patch_markdown
from .model import CatalogParseError, parse_catalog, parse_string, serialize_catalog
from .normalize import normalize
from .validate import run_checks

LOG = logging.getLogger("promptnexus")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def _load(path: str):
    try:
        return parse_catalog(path)
    except FileNotFoundError:
        LOG.error("input not found: %s", path)
        raise SystemExit(EXIT_USAGE)
    except CatalogParseError as exc:
        LOG.error("cannot parse %s: %s", path, exc)
        raise SystemExit(EXIT_USAGE)


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------


def _validate_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="validate-catalog",
        description=(
            "Fail the build on catalog defects: metadata drift, serialization "
            "drift, vocabulary drift, duplicates and broken cross-references."
        ),
    )
    parser.add_argument("input", help="catalog XML to validate")
    parser.add_argument(
        "--format",
        choices=("text", "json", "github"),
        default="text",
        help="report format (default: text)",
    )
    parser.add_argument(
        "--output", help="write the report here instead of stdout"
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="treat warnings as build failures",
    )
    parser.add_argument(
        "--allow-dangling",
        action="store_true",
        help=(
            "downgrade unresolved related_techniques targets to warnings "
            "(use while the missing entries are being authored)"
        ),
    )
    parser.add_argument(
        "--show-waived",
        action="store_true",
        help="also report alias collisions that the policy allowlist waives",
    )
    parser.add_argument(
        "--only",
        nargs="+",
        metavar="CHECK_ID",
        help="run only these checks, e.g. --only C001 C006",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def validate_main(argv: Sequence[str] | None = None) -> int:
    args = _validate_parser().parse_args(argv)
    _configure_logging(args.verbose)

    parsed = _load(args.input)
    report = run_checks(
        parsed,
        strict=args.strict,
        allow_dangling=args.allow_dangling,
        show_waived=args.show_waived,
        only=args.only,
    )

    renderers = {
        "text": report_mod.render_report_text,
        "json": report_mod.render_report_json,
        "github": report_mod.render_report_github,
    }
    rendered = renderers[args.format](report, source=args.input)

    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(rendered, encoding="utf-8")
        LOG.info("report written to %s", args.output)
    else:
        sys.stdout.write(rendered)

    LOG.info(
        "%d error(s), %d warning(s) across %d entries",
        len(report.errors),
        len(report.warnings),
        len(parsed.catalog.techniques),
    )
    return report.exit_code()


# --------------------------------------------------------------------------
# normalize
# --------------------------------------------------------------------------


def _normalize_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="normalize-catalog",
        description=(
            "Rewrite a catalog into canonical 1.2.0 form: one serialization, "
            "merged duplicates, registered categories, mapped vocabularies, "
            "synchronised metadata. Emits an auditable change ledger."
        ),
    )
    parser.add_argument("input", help="catalog XML to normalize")
    parser.add_argument(
        "--output",
        help="path for the normalized XML (omit with --dry-run to write nothing)",
    )
    parser.add_argument(
        "--json-out",
        help=(
            "also write the catalog as source-of-truth JSON, in the record "
            "shape the per-technique export uses. Feed this to "
            "scripts/build_catalog.py to regenerate every rendering; this tool "
            "deliberately does not render Markdown, because a second generator "
            "is what caused the exports to diverge in the first place"
        ),
    )
    parser.add_argument("--ledger-json", help="path for the machine-readable ledger")
    parser.add_argument("--ledger-md", help="path for the Markdown ledger")
    parser.add_argument(
        "--status-policy",
        choices=policy.StatusPolicy.CHOICES,
        default=policy.StatusPolicy.REGISTER,
        help=(
            "'register' (default) keeps practitioner-guide as a distinct "
            "evidence tier; 'remap' folds it into verified-external, which "
            "overstates those entries' provenance"
        ),
    )
    parser.add_argument(
        "--strip-dangling",
        action="store_true",
        help=(
            "delete related_techniques targets that do not resolve. Off by "
            "default: those references are a backlog of missing entries, and "
            "deleting them destroys that signal silently"
        ),
    )
    parser.add_argument(
        "--no-add-entries",
        action="store_true",
        help=(
            "do not append the authored entries that close otherwise "
            "unresolvable cross-references"
        ),
    )
    parser.add_argument(
        "--keep-template-ids",
        action="store_true",
        help=(
            "leave template_id values as they are. Renaming them to "
            "'<technique-id>--<slug>' is a breaking change for anything that "
            "cites a template by id, so this opts out"
        ),
    )
    parser.add_argument("--catalog-version", help="override the emitted catalog_version")
    parser.add_argument("--generated-at", help="override the emitted generated_at")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="compute and report changes without writing the XML",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "validate the normalized result and return non-zero if it still "
            "fails; use this as the build gate"
        ),
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def normalize_main(argv: Sequence[str] | None = None) -> int:
    args = _normalize_parser().parse_args(argv)
    _configure_logging(args.verbose)

    if not args.output and not args.dry_run:
        LOG.error("--output is required unless --dry-run is given")
        return EXIT_USAGE

    parsed = _load(args.input)
    LOG.info("parsed %d entries from %s", len(parsed.catalog.techniques), args.input)

    result = normalize(
        parsed.catalog,
        parsed.notes,
        status_policy=args.status_policy,
        strip_dangling=args.strip_dangling,
        add_entries=not args.no_add_entries,
        canonicalize_template_id_slugs=not args.keep_template_ids,
        catalog_version=args.catalog_version,
        generated_at=args.generated_at,
    )
    LOG.info(
        "%d change(s); %d entries after normalization",
        len(result.changes),
        len(result.catalog.techniques),
    )

    xml_text = serialize_catalog(result.catalog)

    if args.output and not args.dry_run:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(xml_text, encoding="utf-8")
        LOG.info("normalized catalog written to %s", output)

    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(
            catalog_to_json(result.catalog), encoding="utf-8"
        )
        LOG.info("source-of-truth JSON written to %s", args.json_out)

    if args.ledger_json:
        Path(args.ledger_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.ledger_json).write_text(
            report_mod.render_ledger_json(result, source=args.input), encoding="utf-8"
        )
        LOG.info("ledger written to %s", args.ledger_json)
    if args.ledger_md:
        Path(args.ledger_md).parent.mkdir(parents=True, exist_ok=True)
        Path(args.ledger_md).write_text(
            report_mod.render_ledger_markdown(result, source=args.input),
            encoding="utf-8",
        )
        LOG.info("ledger written to %s", args.ledger_md)

    if args.check:
        # Validate the emitted bytes, not the in-memory object: that is what
        # downstream consumers will read.
        reparsed = parse_string(xml_text)
        report = run_checks(reparsed, allow_dangling=args.strip_dangling)
        sys.stdout.write(
            report_mod.render_report_text(report, source=args.output or "<dry-run>")
        )
        return report.exit_code()

    return EXIT_OK




# --------------------------------------------------------------------------
# compare
# --------------------------------------------------------------------------


def _compare_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="compare-exports",
        description=(
            "Check that the catalog's parallel exports describe the same "
            "catalog. Five of the six formats are renderings of one dataset, so "
            "any disagreement means something wrote to one and not the others."
        ),
    )
    parser.add_argument("input", help="catalog XML, treated as the reference")
    parser.add_argument(
        "--per-technique-dir",
        help="directory containing INDEX.json, json/ and markdown/",
    )
    parser.add_argument("--markdown", help="path to PROMPT_TECHNIQUE_CATALOG.md")
    parser.add_argument(
        "--format", choices=("text", "json"), default="text",
    )
    parser.add_argument("--output", help="write the report here instead of stdout")
    parser.add_argument("--verbose", action="store_true")
    return parser


def compare_main(argv: Sequence[str] | None = None) -> int:
    args = _compare_parser().parse_args(argv)
    _configure_logging(args.verbose)

    if not args.per_technique_dir and not args.markdown:
        LOG.error("give --per-technique-dir, --markdown, or both")
        return EXIT_USAGE

    parsed = _load(args.input)
    result = compare_exports(
        parsed.catalog,
        per_technique_dir=Path(args.per_technique_dir) if args.per_technique_dir else None,
        markdown_path=Path(args.markdown) if args.markdown else None,
    )

    if args.format == "json":
        import json as _json

        rendered = _json.dumps(
            {
                "reference": args.input,
                "ok": result.ok,
                "compared_records": result.compared_records,
                "divergence_count": len(result.divergences),
                "divergences": [d.as_dict() for d in result.divergences],
                "notes": list(result.notes),
            },
            indent=2,
            ensure_ascii=False,
        ) + "\n"
    else:
        lines = [f"Export consistency - reference: {args.input}", ""]
        grouped: dict[str, list] = {}
        for divergence in result.divergences:
            grouped.setdefault(divergence.kind, []).append(divergence)
        for kind, items in sorted(grouped.items()):
            lines.append(f"{kind}: {len(items)}")
            for item in items[:40]:
                lines.append(f"  {item.subject}: {item.detail}")
            if len(items) > 40:
                lines.append(f"  ... and {len(items) - 40} more")
            lines.append("")
        for note in result.notes:
            lines.append(f"NOTE: {note}")
        if result.notes:
            lines.append("")
        lines.append(f"{result.compared_records} record(s) compared field by field")
        lines.append(f"TOTAL: {len(result.divergences)} divergence(s)")
        lines.append("RESULT: " + ("PASS" if result.ok else "FAIL"))
        rendered = "\n".join(lines) + "\n"

    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(rendered, encoding="utf-8")
        LOG.info("report written to %s", args.output)
    else:
        sys.stdout.write(rendered)
    return result.exit_code()




# --------------------------------------------------------------------------
# patch
# --------------------------------------------------------------------------


def _patch_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="patch-catalog",
        description=(
            "Remediate a catalog and emit the result as a patch against the "
            "JSON source of truth: new source-of-truth JSON plus a manifest of "
            "every record added, modified and removed."
        ),
    )
    parser.add_argument("baseline", help="current source-of-truth JSON")
    parser.add_argument(
        "target",
        help="catalog carrying the new content (XML export or JSON)",
    )
    parser.add_argument("--json-out", required=True, help="path for the new source-of-truth JSON")
    parser.add_argument("--manifest-md", help="path for the human-readable manifest")
    parser.add_argument("--manifest-json", help="path for the machine-readable manifest")
    parser.add_argument("--ledger-md", help="path for the remediation ledger")
    parser.add_argument(
        "--catalog-version", help="version stamp for the patched catalog"
    )
    parser.add_argument("--generated-at", help="generated_at stamp for the patched catalog")
    parser.add_argument(
        "--status-policy",
        choices=policy.StatusPolicy.CHOICES,
        default=policy.StatusPolicy.REGISTER,
    )
    parser.add_argument(
        "--no-add-entries",
        action="store_true",
        help="do not append the authored entries that close unresolvable references",
    )
    parser.add_argument("--keep-template-ids", action="store_true")
    parser.add_argument("--strip-dangling", action="store_true")
    parser.add_argument(
        "--no-verified-sources",
        action="store_true",
        help="do not apply the arXiv-verified source table",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def patch_main(argv: Sequence[str] | None = None) -> int:
    args = _patch_parser().parse_args(argv)
    _configure_logging(args.verbose)

    baseline = _load(args.baseline).catalog
    parsed_target = _load(args.target)
    LOG.info(
        "baseline %d records, target %d records",
        len(baseline.techniques),
        len(parsed_target.catalog.techniques),
    )

    result = normalize(
        parsed_target.catalog,
        parsed_target.notes,
        status_policy=args.status_policy,
        strip_dangling=args.strip_dangling,
        add_entries=not args.no_add_entries,
        canonicalize_template_id_slugs=not args.keep_template_ids,
        verify_sources=not args.no_verified_sources,
        catalog_version=args.catalog_version,
        generated_at=args.generated_at,
    )

    Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json_out).write_text(catalog_to_json(result.catalog), encoding="utf-8")
    LOG.info("source-of-truth JSON written to %s", args.json_out)

    patch = build_patch(baseline, result.catalog)
    LOG.info(
        "%d added, %d modified, %d removed, %d untouched",
        len(patch.added),
        len(patch.modified),
        len(patch.removed),
        len(patch.unchanged),
    )

    reparsed = parse_string(serialize_catalog(result.catalog))
    report = run_checks(reparsed, strict=True)
    backlog = [
        f"{finding.check_id} {finding.technique_id}: {finding.message}"
        for finding in report.errors + report.warnings
    ] + list(result.manual_actions)

    if args.manifest_md:
        Path(args.manifest_md).parent.mkdir(parents=True, exist_ok=True)
        Path(args.manifest_md).write_text(
            render_patch_markdown(
                patch,
                baseline_label=args.baseline,
                target_label=args.target,
                backlog=backlog,
            ),
            encoding="utf-8",
        )
        LOG.info("manifest written to %s", args.manifest_md)
    if args.manifest_json:
        Path(args.manifest_json).parent.mkdir(parents=True, exist_ok=True)
        payload = patch.as_dict()
        payload["backlog"] = backlog
        Path(args.manifest_json).write_text(
            __import__("json").dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    if args.ledger_md:
        Path(args.ledger_md).parent.mkdir(parents=True, exist_ok=True)
        Path(args.ledger_md).write_text(
            report_mod.render_ledger_markdown(result, source=args.target),
            encoding="utf-8",
        )

    sys.stdout.write(report_mod.render_report_text(report, source=args.json_out))
    return report.exit_code()



# --------------------------------------------------------------------------
# bundle
# --------------------------------------------------------------------------


def _bundle_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bundle-catalog",
        description=(
            "Write every data serialization of a catalog -- JSON, XML, YAML, "
            "and the per-technique split -- from one model, so they cannot "
            "disagree. Does not emit the Markdown catalog or the PDF; those "
            "belong to scripts/build_catalog.py."
        ),
    )
    parser.add_argument("input", help="catalog JSON or XML")
    parser.add_argument("--out", required=True, help="directory to write the bundle into")
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate the catalog before writing, and refuse on errors",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def bundle_main(argv: Sequence[str] | None = None) -> int:
    args = _bundle_parser().parse_args(argv)
    _configure_logging(args.verbose)
    parsed = _load(args.input)

    if args.check:
        report = run_checks(parsed, strict=True)
        if not report.ok:
            sys.stdout.write(report_mod.render_report_text(report, source=args.input))
            LOG.error("refusing to write a bundle from a catalog that does not validate")
            return report.exit_code()

    manifest = write_bundle(parsed.catalog, args.out)
    LOG.info(
        "wrote %d files (%d techniques, %.1f MB) to %s",
        len(manifest.files),
        manifest.entry_count,
        manifest.total_bytes() / 1e6,
        manifest.root,
    )
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover
    """Dispatch for ``python -m promptnexus_hygiene <normalize|validate> ...``."""
    argv = list(sys.argv[1:] if argv is None else argv)
    commands = {
        "normalize": normalize_main,
        "validate": validate_main,
        "compare": compare_main,
        "patch": patch_main,
        "bundle": bundle_main,
    }
    if not argv or argv[0] not in commands:
        sys.stderr.write(
            "usage: python -m promptnexus_hygiene "
            "{normalize|validate|compare|patch|bundle} ...\n"
        )
        return EXIT_USAGE
    return commands[argv[0]](argv[1:])
