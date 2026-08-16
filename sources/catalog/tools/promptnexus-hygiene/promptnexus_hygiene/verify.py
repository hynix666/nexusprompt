"""Resolve every record's ``primary_source`` against the live arXiv API.

The point is reproducibility. ``verified_sources.json`` is machine-derived, so a
reviewer should re-run this rather than take the file on trust -- and re-running
it is also how the table stays correct as records are added.

What it does, per record with an ``arxiv_id``:

* fetch the arXiv entry for that id and compare title, authors and year;
* when the id returns an unrelated paper, search arXiv by the record's title and
  accept a replacement id **only on a near-exact title match** -- a wrong id is
  never swapped for a guess;
* rewrite author strings to the catalog convention: full surname sequence, with
  ``et al.`` only past ten names.

Records without an ``arxiv_id`` are reported for manual attention rather than
resolved; there is no API for "a blog post someone cited".
"""

from __future__ import annotations

import argparse
import difflib
import json
import logging
import re
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Final, Iterable, Sequence

from .model import Catalog, CatalogParseError, parse_catalog

LOG = logging.getLogger("promptnexus.verify")

ARXIV_ENDPOINT: Final[str] = "https://export.arxiv.org/api/query"
ATOM: Final[dict[str, str]] = {"a": "http://www.w3.org/2005/Atom"}

#: Batch size for id lookups, and the pause between calls. arXiv asks for no
#: more than one request every three seconds; being a good citizen of someone
#: else's free API is not optional.
BATCH_SIZE: Final[int] = 10
REQUEST_PAUSE_SECONDS: Final[float] = 4.0
MAX_ATTEMPTS: Final[int] = 4

#: Title similarity at or above this means "the same paper".
TITLE_MATCH_THRESHOLD: Final[float] = 0.95
#: Below this, with no author overlap, means "a different paper entirely".
TITLE_MISMATCH_THRESHOLD: Final[float] = 0.50

#: The catalog lists this many surnames before falling back to "et al.".
MAX_NAMED_AUTHORS: Final[int] = 10

VERIFIED_SOURCES_PATH: Final[Path] = Path(__file__).resolve().parent / "verified_sources.json"

_ET_AL: Final[re.Pattern[str]] = re.compile(r",?\s*et\.?\s*al\.?\s*$", re.I)
_ET_AL_EXACT: Final[re.Pattern[str]] = re.compile(r"et\.?\s*al\.?", re.I)


@dataclass(frozen=True, slots=True)
class ArxivEntry:
    arxiv_id: str
    title: str
    surnames: tuple[str, ...]
    published: str

    @property
    def year(self) -> int:
        return int(self.published[:4])


@dataclass(frozen=True, slots=True)
class Verdict:
    record_id: str
    status: str  # OK | CORRECTED | TITLE-VARIANT | UNRESOLVED | NO-ARXIV-ID
    detail: str
    entry: ArxivEntry | None = None


# --------------------------------------------------------------------------
# arXiv access
# --------------------------------------------------------------------------


def _get(url: str) -> ET.Element | None:
    """Fetch and parse, retrying with backoff. Returns None if it never parses."""
    for attempt in range(MAX_ATTEMPTS):
        completed = subprocess.run(
            [
                "curl", "-sS", "--retry", "3", "--retry-all-errors",
                "--max-time", "70", "-A", "promptnexus-catalog-verification/1.0", url,
            ],
            capture_output=True,
            text=True,
        )
        try:
            return ET.fromstring(completed.stdout)
        except ET.ParseError:
            LOG.debug("arXiv request failed (attempt %d)", attempt + 1)
            time.sleep(REQUEST_PAUSE_SECONDS + 4 * attempt)
    return None


def _entries(root: ET.Element) -> list[ArxivEntry]:
    entries = []
    for element in root.findall("a:entry", ATOM):
        raw_id = element.findtext("a:id", "", ATOM).rsplit("/", 1)[-1]
        entries.append(
            ArxivEntry(
                arxiv_id=raw_id.split("v")[0],
                title=" ".join(element.findtext("a:title", "", ATOM).split()),
                surnames=tuple(
                    author.findtext("a:name", "", ATOM).split()[-1]
                    for author in element.findall("a:author", ATOM)
                ),
                published=element.findtext("a:published", "", ATOM)[:10],
            )
        )
    return entries


def fetch_by_ids(arxiv_ids: Sequence[str]) -> dict[str, ArxivEntry]:
    """Look up entries by id, in batches."""
    found: dict[str, ArxivEntry] = {}
    for start in range(0, len(arxiv_ids), BATCH_SIZE):
        chunk = arxiv_ids[start : start + BATCH_SIZE]
        root = _get(f"{ARXIV_ENDPOINT}?id_list={','.join(chunk)}&max_results=50")
        if root is None:
            LOG.warning("could not resolve ids %s", chunk)
            continue
        for entry in _entries(root):
            found[entry.arxiv_id] = entry
        time.sleep(REQUEST_PAUSE_SECONDS)
    return found


def search_by_title(title: str) -> list[ArxivEntry]:
    query = urllib.parse.quote(f'ti:"{title}"', safe=":")
    root = _get(f"{ARXIV_ENDPOINT}?search_query={query}&max_results=4")
    time.sleep(REQUEST_PAUSE_SECONDS)
    return _entries(root) if root is not None else []


# --------------------------------------------------------------------------
# Comparison
# --------------------------------------------------------------------------


def normalise_title(title: str) -> str:
    lowered = title.lower().replace("\u2013", "-").replace("\u2014", "-")
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", lowered).split())


def title_similarity(left: str, right: str) -> float:
    return difflib.SequenceMatcher(None, normalise_title(left), normalise_title(right)).ratio()


def catalog_surnames(authors: str) -> list[str]:
    trimmed = _ET_AL.sub("", authors.strip())
    return [part.strip() for part in re.split(r",| and ", trimmed) if part.strip()]


def author_string(surnames: Iterable[str]) -> str:
    """Render the catalog's author convention from a list of surnames."""
    names = [s for s in surnames if not _ET_AL_EXACT.fullmatch(s.strip())]
    if len(names) > MAX_NAMED_AUTHORS:
        return ", ".join(names[:MAX_NAMED_AUTHORS]) + ", et al."
    return ", ".join(names)


def verify(catalog: Catalog) -> tuple[list[Verdict], dict[str, dict[str, Any]]]:
    """Check every record against arXiv and build the verified-source table."""
    with_ids = [t for t in catalog.techniques if t.primary_source and t.primary_source.arxiv_id]
    live = fetch_by_ids([t.primary_source.arxiv_id for t in with_ids])

    verdicts: list[Verdict] = []
    table: dict[str, dict[str, Any]] = {}

    for technique in catalog.techniques:
        source = technique.primary_source
        if source is None or not source.arxiv_id:
            verdicts.append(
                Verdict(technique.id, "NO-ARXIV-ID", "no arXiv id; verify by hand")
            )
            continue

        entry = live.get(source.arxiv_id.split("v")[0])
        if entry is None:
            verdicts.append(
                Verdict(technique.id, "UNRESOLVED", f"arXiv returned nothing for {source.arxiv_id}")
            )
            continue

        similarity = title_similarity(source.title, entry.title)
        surnames = catalog_surnames(source.authors)
        live_lower = {s.lower() for s in entry.surnames}
        first_matches = bool(surnames) and surnames[0].split()[-1].lower() in live_lower

        if similarity < TITLE_MISMATCH_THRESHOLD and not first_matches:
            replacement = None
            for candidate in search_by_title(source.title):
                if title_similarity(source.title, candidate.title) >= TITLE_MATCH_THRESHOLD:
                    replacement = candidate
                    break
            if replacement is None:
                verdicts.append(
                    Verdict(
                        technique.id,
                        "UNRESOLVED",
                        f"{source.arxiv_id} is a different paper ({entry.title!r}) and no "
                        "id could be recovered by exact title match -- fix by hand",
                    )
                )
                continue
            verdicts.append(
                Verdict(
                    technique.id,
                    "CORRECTED",
                    f"{source.arxiv_id} belongs to {entry.title!r}; the cited paper is "
                    f"{replacement.arxiv_id}",
                    replacement,
                )
            )
            entry = replacement
        elif similarity < TITLE_MATCH_THRESHOLD:
            verdicts.append(
                Verdict(
                    technique.id,
                    "TITLE-VARIANT",
                    f"catalog title differs from arXiv ({similarity:.2f}); arXiv wins",
                    entry,
                )
            )
        else:
            verdicts.append(Verdict(technique.id, "OK", "matches the arXiv record", entry))

        # `year` is deliberately absent. In this catalog it means the year of
        # the publication venue, not of the arXiv posting: 71 of the 72 records
        # with a dated venue follow the venue (auto-cot is year=2023 /
        # "ICLR 2023" against a 2022 preprint). Writing arXiv's v1 date here
        # would silently rewrite all of them on the next full run.
        table[technique.id] = {
            "arxiv_id": entry.arxiv_id,
            "authors": author_string(entry.surnames),
            "title": entry.title,
            "url": f"https://arxiv.org/abs/{entry.arxiv_id}",
        }

    return verdicts, dict(sorted(table.items()))


def render_report(verdicts: Sequence[Verdict], source: str) -> str:
    from collections import Counter

    counts = Counter(v.status for v in verdicts)
    lines = [f"Source verification against arXiv - {source}", ""]
    for status in ("CORRECTED", "UNRESOLVED", "TITLE-VARIANT", "NO-ARXIV-ID", "OK"):
        selected = [v for v in verdicts if v.status == status]
        if not selected:
            continue
        lines.append(f"{status}: {len(selected)}")
        for verdict in selected:
            lines.append(f"  {verdict.record_id}: {verdict.detail}")
        lines.append("")
    lines.append("TOTAL: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    unresolved = counts.get("UNRESOLVED", 0)
    lines.append("RESULT: " + ("PASS" if not unresolved else f"FAIL ({unresolved} unresolved)"))
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="verify-sources",
        description="Regenerate verified_sources.json from the live arXiv API.",
    )
    parser.add_argument("input", help="catalog JSON or XML")
    parser.add_argument("--report", help="write the verification report here")
    parser.add_argument(
        "--table-out",
        default=str(VERIFIED_SOURCES_PATH),
        help="where to write the verified-source table",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="report without rewriting the table"
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        catalog = parse_catalog(args.input).catalog
    except (FileNotFoundError, CatalogParseError) as exc:
        LOG.error("cannot read %s: %s", args.input, exc)
        return 2

    verdicts, table = verify(catalog)
    report = render_report(verdicts, args.input)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
    else:
        sys.stdout.write(report)

    if not args.dry_run:
        payload = {
            "_provenance": {
                "source": f"arXiv Atom API ({ARXIV_ENDPOINT})",
                "queried_at": date.today().isoformat(),
                "method": (
                    "Each record's arxiv_id was resolved against the live arXiv "
                    "entry. Where the id returned an unrelated paper, the correct "
                    "id was recovered by title search and accepted only on a "
                    "near-exact title match. Author strings follow the catalog "
                    "convention: full surname sequence, 'et al.' only past ten "
                    "names. `year` and `venue` are not written here: in this "
                    "catalog they describe the publication venue, which arXiv "
                    "cannot settle."
                ),
                "record_count": len(table),
            },
            "records": table,
        }
        Path(args.table_out).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        LOG.info("verified-source table written to %s", args.table_out)

    return 1 if any(v.status == "UNRESOLVED" for v in verdicts) else 0
