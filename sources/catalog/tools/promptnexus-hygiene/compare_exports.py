#!/usr/bin/env python3
"""Standalone wrapper: ``python3 compare_exports.py catalog.xml --markdown ...``."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from promptnexus_hygiene.cli import compare_main  # noqa: E402

if __name__ == "__main__":
    sys.exit(compare_main())
