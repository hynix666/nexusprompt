#!/usr/bin/env python3
"""Standalone wrapper: ``python3 bundle_catalog.py catalog.json --out dist/``."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from promptnexus_hygiene.cli import bundle_main  # noqa: E402

if __name__ == "__main__":
    sys.exit(bundle_main())
