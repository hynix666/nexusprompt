#!/usr/bin/env bash
# .git/hooks/pre-commit — the same gate, locally, before the fork can start.
set -euo pipefail
if git diff --cached --name-only | grep -qE '^(data/prompt_technique_catalog|techniques/|PROMPT_TECHNIQUE_CATALOG)'; then
  python tools/promptnexus-hygiene/validate_catalog.py data/prompt_technique_catalog.json --strict
  if git diff --cached --name-only | grep -qE '^data/prompt_technique_catalog\.(xml|yaml|jsonld)$|^PROMPT_TECHNIQUE_CATALOG\.|^techniques/'; then
    echo "error: generated exports are staged directly." >&2
    echo "Edit data/prompt_technique_catalog.json and run scripts/build_catalog.py." >&2
    exit 1
  fi
fi
