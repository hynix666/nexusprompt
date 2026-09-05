#!/usr/bin/env python3
"""
Scaffold a new technique stub in scripts/catalog-additions.json.

Usage:
  python scripts/new-technique.py <id> "<Name>"
  e.g. python scripts/new-technique.py chain-of-thought "Chain of Thought"

Appends a minimal stub TechniqueRecord to scripts/catalog-additions.json.
The stub passes schema validation; all TODO fields must be filled in before
running import:catalog.

After creation:
  1. Edit scripts/catalog-additions.json — find the new record by id and fill
     in every TODO field.
  2. npm run import:catalog   — merges the record into techniques.json
  3. npm run check:catalog    — verifies the full catalog
  4. npm run verify           — full suite
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
ADDITIONS_FILE = REPO_ROOT / "scripts" / "catalog-additions.json"
SCHEMA_FILE = REPO_ROOT / "contracts" / "technique-record.schema.json"

ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")


def load_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def validate_required_fields(record: dict, schema: dict) -> list[str]:
    """Check that every top-level required field is present."""
    required = schema.get("required", [])
    return [f"missing required field: {field}" for field in required if field not in record]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scaffold a new technique stub in catalog-additions.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("id", help="Technique id in kebab-case (e.g. chain-of-thought)")
    parser.add_argument("name", help='Display name (e.g. "Chain of Thought")')
    args = parser.parse_args()

    technique_id: str = args.id
    name: str = args.name

    if not ID_PATTERN.match(technique_id):
        print(
            f"Error: id must be kebab-case (lowercase letters, digits, hyphens), got: {technique_id!r}",
            file=sys.stderr,
        )
        sys.exit(1)

    additions = load_json(ADDITIONS_FILE)
    schema = load_json(SCHEMA_FILE)

    existing_ids = {r["id"] for r in additions.get("records", [])}
    if technique_id in existing_ids:
        print(
            f"Error: id {technique_id!r} already exists in catalog-additions.json",
            file=sys.stderr,
        )
        sys.exit(1)

    stub = {
        "id": technique_id,
        "name": name,
        # category enum from technique-record.schema.json — change as appropriate
        "category": "reasoning-elicitation",
        "subcategory": "single-path-reasoning",
        "executive_summary": "TODO: one-sentence summary of what the technique does",
        "description": "TODO: full description of the technique",
        "verification_status": "unverified",
        "cost_profile": "single-call",
        "when_to_use": [
            "TODO: describe the first condition under which this technique is appropriate"
        ],
        "when_not_to_use": [
            "TODO: describe when this technique should be avoided"
        ],
        "known_pitfalls": [
            "TODO: describe at least one known failure mode or limitation"
        ],
        "related_techniques": [],
        "primary_source": {
            "authors": "TODO: Author, Author",
            "year": 2024,
            "title": "TODO: Paper title",
            "venue": "TODO: Conference, journal, or 'arXiv preprint'",
            "arxiv_id": None,
            "url": "TODO: https://..."
        },
        "usage_templates": [
            {
                "template_name": "TODO: short name for this template",
                "template": "TODO: template text; use {{variable}} for placeholders",
                "template_id": f"{technique_id}--TODO-template-name",
                "determinism": "deterministic-at-temperature-zero",
                "reproducibility_note": "TODO: what must be pinned to reproduce a run",
                "variables": [
                    {
                        "name": "variable",
                        "description": "TODO: what this placeholder represents",
                        "example": None
                    }
                ]
            }
        ],
        "tags": ["TODO"],
        "status": "unverified",
        "aliases": [],
        "secondary_sources": [],
        "corpus_file": None,
        "schema_version": "1.3.0",
        "source_audit": {
            "description": "unverified",
            "pitfalls": "unverified"
        }
    }

    errors = validate_required_fields(stub, schema)
    if errors:
        print("Schema validation errors:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)

    additions["records"].append(stub)

    with open(ADDITIONS_FILE, "w", encoding="utf-8") as f:
        json.dump(additions, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Added stub for {technique_id!r} to scripts/catalog-additions.json")
    print()
    print("Next steps:")
    print(f"  1. Fill in every TODO field in scripts/catalog-additions.json")
    print(f"     (find the record by searching for \"{technique_id}\")")
    print(f"  2. Set the correct category — valid values are in")
    print(f"     contracts/technique-record.schema.json under properties.category.enum")
    print(f"  3. npm run import:catalog   — merge into techniques.json")
    print(f"  4. npm run check:catalog    — verify the full catalog")
    print(f"  5. npm run verify           — full suite")


if __name__ == "__main__":
    main()
