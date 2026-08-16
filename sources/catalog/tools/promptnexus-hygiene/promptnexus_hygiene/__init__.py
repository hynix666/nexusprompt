"""Hygiene tooling for the PromptNexus Prompt-Technique Catalog.

Two commands:

* ``normalize-catalog`` -- rewrite a catalog into canonical schema 1.2.0 form
  and emit an auditable ledger of every edit.
* ``validate-catalog``  -- fail a build on any of the defect classes the
  normalizer repairs, so drift cannot reappear silently.

Both operate on the XML export. The JSON file remains the source of truth: the
decisions in :mod:`promptnexus_hygiene.policy` are meant to be ported into
``scripts/build_catalog.py``, with these tools acting as the gate that proves
the port worked.
"""

from __future__ import annotations

__version__ = "1.0.0"

__all__ = ["__version__"]
