#!/usr/bin/env python3
"""Regenerate verified_sources.json from the live arXiv API.

    python3 verify_sources.py data/prompt_technique_catalog.json --report report.txt

Resolves every record's arxiv_id against arXiv, reports each disagreement, and
rewrites the verified-source table. Where an id returns an unrelated paper the
correct id is recovered by title search and accepted only on an exact match --
never guessed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from promptnexus_hygiene.verify import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
