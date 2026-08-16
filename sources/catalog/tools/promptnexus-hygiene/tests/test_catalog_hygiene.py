"""Tests for promptnexus_hygiene.

Structure: a minimal *clean* catalog fixture, then one planted defect per check.
Each check gets a pair -- clean input must be silent, defective input must fire
the specific check id -- because a check that never fires and a check that
always fires are equally useless, and only the pair catches both.

Run: python -m unittest discover -s tests -v      (stdlib only, no dependencies)
     python -m pytest tests                       (also works)
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from dataclasses import replace
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from promptnexus_hygiene import (  # noqa: E402
    additions,
    claim_corrections,
    content_corrections,
    labels,
    policy,
    schema,
)
from promptnexus_hygiene.model import (  # noqa: E402
    Catalog,
    SourceAudit,
    CatalogMetadata,
    CatalogParseError,
    SourceRef,
    Technique,
    Template,
    Variable,
    parse_string,
    serialize_catalog,
)
from promptnexus_hygiene.model import parse_json_string  # noqa: E402
from promptnexus_hygiene.normalize import (  # noqa: E402
    ClaimEditNotApplicable,
    apply_claim_corrections,
    load_verified_sources,
    normalize,
)
from promptnexus_hygiene.patch import build_patch  # noqa: E402
from promptnexus_hygiene.report import (  # noqa: E402
    render_ledger_json,
    render_ledger_markdown,
    render_report_github,
    render_report_json,
    render_report_text,
)
from promptnexus_hygiene.exports import (  # noqa: E402
    RECORD_KEY_ORDER,
    catalog_to_json,
    compare_exports,
    technique_to_record,
)
from promptnexus_hygiene.validate import Severity, run_checks  # noqa: E402

REAL_CATALOG = Path("/mnt/user-data/uploads/prompt_technique_catalog.xml")
FINAL_CATALOG = Path("/mnt/user-data/uploads/prompt_technique_catalog_FINAL.xml")


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


def _fixture_arxiv_id(technique_id: str) -> str:
    """Distinct-but-deterministic arXiv id per fixture, so the duplicate-source
    check does not fire on unrelated tests."""
    digest = int(hashlib.sha256(technique_id.encode()).hexdigest()[:8], 16)
    return f"2401.{digest % 90000 + 10000:05d}"


def make_template(technique_id: str, slug: str = "basic") -> Template:
    return Template(
        template_name="Basic",
        template="Answer {{question}} carefully.",
        template_id=f"{technique_id}{schema.TEMPLATE_ID_SEPARATOR}{slug}",
        determinism="deterministic-at-temperature-zero",
        reproducibility_note="Single call.",
        variables=(Variable(name="question", description="The question.", example="2+2"),),
    )


def make_technique(technique_id: str, **overrides) -> Technique:
    base = Technique(
        id=technique_id,
        name=technique_id.replace("-", " ").title(),
        category="reasoning-elicitation",
        subcategory="single-path-reasoning",
        executive_summary=f"Summary for {technique_id}.",
        description=f"Description for {technique_id}.",
        verification_status="verifier-checkable",
        cost_profile="single-call",
        status="verified-external",
        schema_version=schema.SCHEMA_VERSION,
        aliases=(technique_id.upper(),),
        when_to_use=("Always.",),
        when_not_to_use=("Never.",),
        known_pitfalls=("None.",),
        related_techniques=(),
        tags=("reasoning",),
        primary_source=SourceRef(
            authors="Doe, Roe",
            year="2024",
            title=f"A paper about {technique_id}",
            venue="arXiv",
            arxiv_id=_fixture_arxiv_id(technique_id),
            url=f"https://arxiv.org/abs/{_fixture_arxiv_id(technique_id)}",
        ),
        usage_templates=(make_template(technique_id),),
    )
    return replace(base, **overrides)


def make_catalog(*techniques: Technique, **overrides) -> Catalog:
    entries = techniques or (make_technique("alpha"), make_technique("beta"))
    categories = tuple(sorted({t.category for t in entries}))
    base = Catalog(
        schema_version=schema.SCHEMA_VERSION,
        catalog_version="1.0.0",
        generated_at="2026-01-01",
        entry_count=str(len(entries)),
        metadata=CatalogMetadata(
            catalog_name="Test Catalog",
            schema_version=schema.SCHEMA_VERSION,
            catalog_version="1.0.0",
            generated_at="2026-01-01",
            entry_count=str(len(entries)),
            categories=categories,
            source_note="Fixture.",
        ),
        techniques=entries,
    )
    return replace(base, **overrides)


def check_ids(catalog: Catalog, *, severity: str | None = None, **kwargs) -> set[str]:
    """Round-trip through XML so notes-based checks see real serialization."""
    parsed = parse_string(serialize_catalog(catalog))
    report = run_checks(parsed, **kwargs)
    return {
        f.check_id
        for f in report.findings
        if severity is None or f.severity == severity
    }


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


class TestModel(unittest.TestCase):
    def test_round_trip_is_lossless(self) -> None:
        catalog = make_catalog()
        reparsed = parse_string(serialize_catalog(catalog))
        self.assertEqual(reparsed.catalog, catalog)

    def test_serialization_is_idempotent(self) -> None:
        once = serialize_catalog(make_catalog())
        twice = serialize_catalog(parse_string(once).catalog)
        self.assertEqual(once, twice)

    def test_empty_containers_carry_marker(self) -> None:
        xml = serialize_catalog(make_catalog(make_technique("alpha", aliases=())))
        self.assertIn('<aliases empty="true" />', xml)

    def test_empty_leaves_carry_nil_marker(self) -> None:
        technique = make_technique("alpha")
        source = replace(technique.primary_source, arxiv_id="", url="")
        xml = serialize_catalog(make_catalog(replace(technique, primary_source=source)))
        self.assertIn('<arxiv_id nil="true" />', xml)

    def test_optional_corpus_file_is_omitted_not_emptied(self) -> None:
        xml = serialize_catalog(make_catalog(make_technique("alpha", corpus_file=None)))
        self.assertNotIn("<corpus_file", xml)

    def test_unknown_element_is_rejected(self) -> None:
        xml = serialize_catalog(make_catalog()).replace(
            "<subcategory>", "<bogus>x</bogus><subcategory>", 1
        )
        with self.assertRaises(CatalogParseError):
            parse_string(xml)

    def test_id_attribute_element_mismatch_is_rejected(self) -> None:
        xml = serialize_catalog(make_catalog()).replace(
            "<id>alpha</id>", "<id>not-alpha</id>", 1
        )
        with self.assertRaises(CatalogParseError):
            parse_string(xml)

    def test_missing_id_element_is_tolerated_and_noted(self) -> None:
        xml = serialize_catalog(make_catalog()).replace("<id>alpha</id>", "", 1)
        parsed = parse_string(xml)
        self.assertEqual(parsed.notes.missing_id_element, frozenset({"alpha"}))

    def test_empty_corpus_file_is_noted(self) -> None:
        xml = serialize_catalog(make_catalog()).replace(
            "<status>verified-external</status>",
            "<status>verified-external</status><corpus_file></corpus_file>",
            1,
        )
        parsed = parse_string(xml)
        self.assertIn("alpha", parsed.notes.empty_corpus_file)
        self.assertIn("alpha", parsed.notes.unmarked_empty_elements)

    def test_malformed_xml_raises_parse_error(self) -> None:
        with self.assertRaises(CatalogParseError):
            parse_string("<PromptTechniqueCatalog><techniques>")

    def test_wrong_root_element_raises(self) -> None:
        with self.assertRaises(CatalogParseError):
            parse_string("<Nope/>")


# --------------------------------------------------------------------------
# Validation: planted-defect pairs
# --------------------------------------------------------------------------


class TestValidationChecks(unittest.TestCase):
    def test_clean_catalog_has_no_errors(self) -> None:
        self.assertEqual(check_ids(make_catalog(), severity=Severity.ERROR), set())

    def test_c001_metadata_disagreement(self) -> None:
        catalog = make_catalog()
        catalog = replace(
            catalog, metadata=replace(catalog.metadata, catalog_version="9.9.9")
        )
        self.assertIn("C001", check_ids(catalog, severity=Severity.ERROR))

    def test_c002_entry_count_mismatch(self) -> None:
        catalog = make_catalog()
        catalog = replace(
            catalog,
            entry_count="99",
            metadata=replace(catalog.metadata, entry_count="99"),
        )
        self.assertIn("C002", check_ids(catalog, severity=Severity.ERROR))

    def test_c003_missing_id_element(self) -> None:
        xml = serialize_catalog(make_catalog()).replace("<id>alpha</id>", "", 1)
        report = run_checks(parse_string(xml))
        self.assertIn("C003", {f.check_id for f in report.errors})

    def test_c004_duplicate_ids(self) -> None:
        catalog = make_catalog(make_technique("alpha"), make_technique("alpha"))
        self.assertIn("C004", check_ids(catalog, severity=Severity.ERROR))

    def test_c004_non_slug_id(self) -> None:
        catalog = make_catalog(make_technique("Alpha_One"))
        self.assertIn("C004", check_ids(catalog, severity=Severity.ERROR))

    def test_c005_undeclared_category(self) -> None:
        catalog = make_catalog(make_technique("alpha", category="brand-new-category"))
        catalog = replace(
            catalog,
            metadata=replace(catalog.metadata, categories=("reasoning-elicitation",)),
        )
        self.assertIn("C005", check_ids(catalog, severity=Severity.ERROR))

    def test_c006_vocabulary_drift(self) -> None:
        catalog = make_catalog(make_technique("alpha", verification_status="self-verifying"))
        self.assertIn("C006", check_ids(catalog, severity=Severity.ERROR))

    def test_c006_determinism_drift(self) -> None:
        technique = make_technique("alpha")
        template = replace(technique.usage_templates[0], determinism="non-deterministic")
        catalog = make_catalog(replace(technique, usage_templates=(template,)))
        self.assertIn("C006", check_ids(catalog, severity=Severity.ERROR))

    def test_c007_unmarked_empty_element(self) -> None:
        xml = serialize_catalog(make_catalog()).replace(
            '<aliases>\n        <alias>ALPHA</alias>\n      </aliases>',
            "<aliases></aliases>",
            1,
        )
        report = run_checks(parse_string(xml))
        self.assertIn("C007", {f.check_id for f in report.errors})

    def test_c008_schema_stamp_mismatch(self) -> None:
        catalog = make_catalog(make_technique("alpha", schema_version="1.1.0"))
        self.assertIn("C008", check_ids(catalog, severity=Severity.ERROR))

    def test_c009_duplicate_name(self) -> None:
        alpha = make_technique("alpha")
        twin = replace(make_technique("alpha-two"), name=alpha.name)
        self.assertIn("C009", check_ids(make_catalog(alpha, twin), severity=Severity.ERROR))

    def test_c009_duplicate_arxiv_id(self) -> None:
        alpha = make_technique("alpha")
        other = make_technique("alpha-two")
        twin = replace(other, primary_source=alpha.primary_source)
        self.assertIn("C009", check_ids(make_catalog(alpha, twin), severity=Severity.ERROR))

    def test_c010_dangling_reference(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=("ghost",)))
        self.assertIn("C010", check_ids(catalog, severity=Severity.ERROR))

    def test_c010_dangling_downgraded_by_allow_flag(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=("ghost",)))
        errors = check_ids(catalog, severity=Severity.ERROR, allow_dangling=True)
        warnings = check_ids(catalog, severity=Severity.WARNING, allow_dangling=True)
        self.assertNotIn("C010", errors)
        self.assertIn("C010", warnings)

    def test_c010_self_reference(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=("alpha",)))
        self.assertIn("C010", check_ids(catalog, severity=Severity.ERROR))

    def test_c011_undeclared_alias_collision(self) -> None:
        catalog = make_catalog(
            make_technique("alpha", aliases=("SHARED",)),
            make_technique("beta", aliases=("shared",)),
        )
        self.assertIn("C011", check_ids(catalog, severity=Severity.ERROR))

    def test_c012_undeclared_placeholder(self) -> None:
        technique = make_technique("alpha")
        template = replace(technique.usage_templates[0], variables=())
        catalog = make_catalog(replace(technique, usage_templates=(template,)))
        self.assertIn("C012", check_ids(catalog, severity=Severity.ERROR))

    def test_c013_corpus_status_without_file(self) -> None:
        catalog = make_catalog(make_technique("alpha", status="corpus-present"))
        self.assertIn("C013", check_ids(catalog, severity=Severity.ERROR))

    def test_c014_malformed_arxiv_id(self) -> None:
        technique = make_technique("alpha")
        source = replace(technique.primary_source, arxiv_id="not-an-id")
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertIn("C014", check_ids(catalog, severity=Severity.ERROR))

    def test_c014_placeholder_author_is_a_warning(self) -> None:
        technique = make_technique("alpha")
        source = replace(technique.primary_source, authors="Various")
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertIn("C014", check_ids(catalog, severity=Severity.WARNING))
        self.assertNotIn("C014", check_ids(catalog, severity=Severity.ERROR))

    def test_c015_empty_mandatory_field(self) -> None:
        catalog = make_catalog(make_technique("alpha", description=""))
        self.assertIn("C015", check_ids(catalog, severity=Severity.ERROR))

    def test_only_filter_restricts_checks(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=("ghost",)))
        parsed = parse_string(serialize_catalog(catalog))
        report = run_checks(parsed, only=["C001"])
        self.assertEqual({f.check_id for f in report.findings}, set())

    def test_waived_alias_collision_never_fails_a_build(self) -> None:
        alias = next(iter(policy.ALIAS_COLLISION_ALLOWLIST))
        catalog = make_catalog(
            make_technique("alpha", aliases=(alias,)),
            make_technique("beta", aliases=(alias.upper(),)),
        )
        parsed = parse_string(serialize_catalog(catalog))
        hidden = run_checks(parsed, strict=True, only=["C011"])
        self.assertEqual(hidden.findings, ())
        shown = run_checks(parsed, strict=True, show_waived=True, only=["C011"])
        self.assertEqual({f.severity for f in shown.findings}, {Severity.WAIVED})
        self.assertTrue(shown.ok)

    def test_organisational_author_ok_for_practitioner_guide_with_url(self) -> None:
        technique = make_technique("alpha", status="practitioner-guide")
        source = replace(
            technique.primary_source,
            authors="Anthropic / Claude Documentation",
            arxiv_id="",
            url="https://example.invalid/doc",
        )
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertNotIn("C014", check_ids(catalog, severity=Severity.WARNING))

    def test_organisational_author_flagged_without_url(self) -> None:
        technique = make_technique("alpha", status="practitioner-guide")
        source = replace(
            technique.primary_source,
            authors="Anthropic / Claude Documentation",
            arxiv_id="",
            url="",
        )
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertIn("C014", check_ids(catalog, severity=Severity.WARNING))

    def test_organisational_author_flagged_for_literature_entry(self) -> None:
        technique = make_technique("alpha", status="verified-external")
        source = replace(technique.primary_source, authors="Vendor Documentation")
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertIn("C014", check_ids(catalog, severity=Severity.WARNING))

    def test_c017_isolated_record_warns(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=()))
        self.assertIn("C017", check_ids(catalog, severity=Severity.WARNING))

    def test_c017_connected_record_is_silent(self) -> None:
        catalog = make_catalog(
            make_technique("alpha", related_techniques=("beta",)),
            make_technique("beta", related_techniques=("alpha",)),
        )
        self.assertNotIn("C017", check_ids(catalog))

    def test_c019_unknown_audit_value_is_an_error(self) -> None:
        technique = make_technique("alpha")
        catalog = make_catalog(
            replace(technique, source_audit=SourceAudit(description="made-up"))
        )
        self.assertIn("C019", check_ids(catalog, severity=Severity.ERROR))

    def test_c019_silent_on_valid_labels(self) -> None:
        self.assertNotIn("C019", check_ids(make_catalog()))

    def test_audit_labels_cover_every_schema_value(self) -> None:
        self.assertEqual(
            set(schema.DESCRIPTION_AUDIT_VALUES) - set(labels.DESCRIPTION_AUDIT_LABELS),
            set(),
        )
        self.assertEqual(
            set(schema.PITFALLS_AUDIT_VALUES) - set(labels.PITFALLS_AUDIT_LABELS), set()
        )

    def test_unverified_label_does_not_read_as_wrong(self) -> None:
        """A reader must not take 'not checked' for 'found to be false'."""
        for table in (labels.DESCRIPTION_AUDIT_LABELS, labels.PITFALLS_AUDIT_LABELS):
            text = table["unverified"].lower()
            self.assertIn("not", text)
            for word in ("wrong", "false", "incorrect", "unreliable"):
                self.assertNotIn(word, text)

    def test_c018_missing_render_label_is_an_error(self) -> None:
        catalog = make_catalog(make_technique("alpha", category="brand-new-category"))
        catalog = replace(
            catalog,
            metadata=replace(
                catalog.metadata, categories=("brand-new-category",)
            ),
        )
        self.assertIn("C018", check_ids(catalog, severity=Severity.ERROR))

    def test_c018_silent_when_every_value_has_a_label(self) -> None:
        self.assertNotIn("C018", check_ids(make_catalog()))

    def test_every_schema_vocabulary_value_has_a_label(self) -> None:
        """A value can only enter the schema with its rendering already decided."""
        self.assertEqual(set(schema.STATUSES) - set(labels.STATUS_LABELS), set())
        self.assertEqual(
            set(schema.VERIFICATION_STATUSES) - set(labels.VERIFICATION_STATUS_LABELS),
            set(),
        )
        self.assertEqual(
            set(schema.COST_PROFILES) - set(labels.COST_PROFILE_LABELS), set()
        )
        self.assertEqual(
            set(schema.DETERMINISM_VALUES) - set(labels.DETERMINISM_LABELS), set()
        )

    def test_corpus_status_label_interpolates_the_filename(self) -> None:
        rendered = labels.format_status("corpus-present", "Chain-of-Thought.pdf")
        self.assertIn("Chain-of-Thought.pdf", rendered)
        with self.assertRaises(KeyError):
            labels.format_status("no-such-status", None)

    def test_c016_new_abbreviated_author_string_warns(self) -> None:
        technique = make_technique("brand-new-entry")
        source = replace(technique.primary_source, authors="Solo et al.")
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertIn("C016", check_ids(catalog, severity=Severity.WARNING))

    def test_c016_long_author_list_may_use_et_al(self) -> None:
        technique = make_technique("alpha")
        source = replace(
            technique.primary_source,
            authors="One, Two, Three, Four, Five, Six, Seven, et al.",
        )
        catalog = make_catalog(replace(technique, primary_source=source))
        self.assertNotIn("C016", check_ids(catalog))

    def test_c016_backlog_entries_are_waived_not_warned(self) -> None:
        """The shipped backlog is empty -- every abbreviation was backfilled --
        so this exercises the waiver mechanism with an injected entry rather
        than depending on the list staying non-empty."""
        backlog_id = "some-backlogged-record"
        technique = make_technique(backlog_id)
        source = replace(technique.primary_source, authors="Someone et al.")
        catalog = make_catalog(replace(technique, primary_source=source))
        with unittest.mock.patch.object(
            policy, "ABBREVIATED_AUTHOR_BACKLOG", frozenset({backlog_id})
        ):
            self.assertNotIn("C016", check_ids(catalog, severity=Severity.WARNING))
            self.assertIn(
                "C016",
                check_ids(catalog, severity=Severity.WAIVED, show_waived=True),
            )
        self.assertIn("C016", check_ids(catalog, severity=Severity.WARNING))

    def test_shipped_abbreviation_backlog_is_empty(self) -> None:
        """A waiver should be a temporary state with a name on it."""
        self.assertEqual(policy.ABBREVIATED_AUTHOR_BACKLOG, frozenset())

    def test_strict_mode_turns_warnings_into_failure(self) -> None:
        technique = make_technique("alpha")
        source = replace(technique.primary_source, authors="Various")
        parsed = parse_string(
            serialize_catalog(make_catalog(replace(technique, primary_source=source)))
        )
        self.assertTrue(run_checks(parsed).ok)
        self.assertFalse(run_checks(parsed, strict=True).ok)
        self.assertEqual(run_checks(parsed, strict=True).exit_code(), 1)


# --------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------


class TestNormalization(unittest.TestCase):
    def _normalize(self, catalog: Catalog, **kwargs):
        """Fixture catalogs opt out of entry authoring by default: the authored
        entries reference real catalog ids that a two-entry fixture lacks, which
        would drown every other assertion in dangling-reference noise. The
        addition pass has its own tests below."""
        kwargs.setdefault("add_entries", False)
        parsed = parse_string(serialize_catalog(catalog))
        return normalize(parsed.catalog, parsed.notes, **kwargs)

    def test_merge_folds_absorbed_into_survivor(self) -> None:
        rule = policy.MERGES[0]
        survivor = make_technique(rule.survivor, aliases=("A",))
        absorbed = make_technique(rule.absorbed, aliases=("B",), tags=("extra",))
        referrer = make_technique("gamma", related_techniques=(rule.absorbed,))
        result = self._normalize(make_catalog(survivor, absorbed, referrer))

        ids = result.catalog.ids()
        self.assertIn(rule.survivor, ids)
        self.assertNotIn(rule.absorbed, ids)
        merged = result.catalog.by_id()[rule.survivor]
        self.assertIn("B", merged.aliases)
        self.assertIn(rule.absorbed, merged.aliases)
        self.assertIn("extra", merged.tags)
        self.assertEqual(
            result.catalog.by_id()["gamma"].related_techniques, (rule.survivor,)
        )

    def test_merge_removes_self_reference(self) -> None:
        rule = policy.MERGES[0]
        survivor = make_technique(rule.survivor, related_techniques=(rule.absorbed,))
        absorbed = make_technique(rule.absorbed)
        result = self._normalize(make_catalog(survivor, absorbed))
        self.assertEqual(result.catalog.by_id()[rule.survivor].related_techniques, ())

    def test_merge_is_idempotent_when_target_absent(self) -> None:
        result = self._normalize(make_catalog(make_technique("alpha")))
        self.assertEqual(len(result.catalog.techniques), 1)

    def test_vocabulary_is_remapped(self) -> None:
        technique = make_technique("alpha", verification_status="enforced-at-runtime")
        template = replace(technique.usage_templates[0], determinism="non-deterministic")
        result = self._normalize(
            make_catalog(replace(technique, usage_templates=(template,)))
        )
        entry = result.catalog.by_id()["alpha"]
        self.assertEqual(entry.verification_status, "verifier-checkable")
        self.assertEqual(entry.usage_templates[0].determinism, "stochastic-by-design")

    def test_singleton_category_is_folded(self) -> None:
        source, decision = next(iter(policy.CATEGORY_REMAP.items()))
        result = self._normalize(make_catalog(make_technique("alpha", category=source)))
        self.assertEqual(result.catalog.by_id()["alpha"].category, decision.to)

    def test_registered_category_is_declared_not_folded(self) -> None:
        category = next(iter(policy.CATEGORIES_TO_REGISTER))
        result = self._normalize(make_catalog(make_technique("alpha", category=category)))
        self.assertEqual(result.catalog.by_id()["alpha"].category, category)
        self.assertIn(category, result.catalog.metadata.categories)

    def test_status_policy_register_preserves_tier(self) -> None:
        catalog = make_catalog(make_technique("alpha", status="practitioner-guide"))
        result = self._normalize(catalog, status_policy=policy.StatusPolicy.REGISTER)
        self.assertEqual(result.catalog.by_id()["alpha"].status, "practitioner-guide")

    def test_status_policy_remap_collapses_tier(self) -> None:
        catalog = make_catalog(make_technique("alpha", status="practitioner-guide"))
        result = self._normalize(catalog, status_policy=policy.StatusPolicy.REMAP)
        self.assertEqual(result.catalog.by_id()["alpha"].status, "verified-external")

    def test_invalid_status_policy_rejected(self) -> None:
        parsed = parse_string(serialize_catalog(make_catalog()))
        with self.assertRaises(ValueError):
            normalize(parsed.catalog, parsed.notes, status_policy="nonsense")

    def test_strip_dangling_removes_only_with_flag(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=("ghost",)))
        kept = self._normalize(catalog)
        self.assertEqual(kept.catalog.by_id()["alpha"].related_techniques, ("ghost",))
        stripped = self._normalize(catalog, strip_dangling=True)
        self.assertEqual(stripped.catalog.by_id()["alpha"].related_techniques, ())


    def test_authored_entries_are_appended_once(self) -> None:
        result = self._normalize(make_catalog(), add_entries=True)
        ids = result.catalog.ids()
        for entry in additions.NEW_ENTRIES:
            self.assertIn(entry.id, ids)
        again = normalize(
            *self._reparse(result.catalog), add_entries=True
        )
        self.assertEqual(
            len(again.catalog.techniques), len(result.catalog.techniques)
        )

    def test_authored_entries_are_schema_conformant(self) -> None:
        """Authored content must clear the same bar as everything else."""
        catalog = make_catalog(*additions.NEW_ENTRIES)
        report = run_checks(parse_string(serialize_catalog(catalog)))
        structural = [
            f
            for f in report.errors
            # C010 fires because the fixture holds only these four entries.
            if f.check_id != "C010"
        ]
        self.assertEqual(structural, [])

    def test_source_correction_replaces_only_named_fields(self) -> None:
        technique_id, correction = next(iter(policy.SOURCE_CORRECTIONS.items()))
        original = replace(
            make_technique(technique_id),
            primary_source=replace(
                make_technique(technique_id).primary_source,
                **{f: "deliberately-wrong" for f in correction.fields},
            ),
        )
        result = self._normalize(
            make_catalog(original), verify_sources=False, correct_claims=False
        )
        source = result.catalog.by_id()[technique_id].primary_source
        for field_name, value in correction.fields.items():
            self.assertEqual(getattr(source, field_name), value)
        untouched = set(("authors", "year", "title", "venue", "arxiv_id", "url")) - set(
            correction.fields
        )
        for field_name in untouched:
            self.assertEqual(
                getattr(source, field_name), getattr(original.primary_source, field_name)
            )

    def test_source_correction_records_verification(self) -> None:
        technique_id, correction = next(iter(policy.SOURCE_CORRECTIONS.items()))
        technique = make_technique(technique_id)
        # Seed every corrected field with a value the correction must overwrite,
        # otherwise the fixture may already match and record no change.
        wrong = {f: "deliberately-wrong" for f in correction.fields}
        technique = replace(
            technique, primary_source=replace(technique.primary_source, **wrong)
        )
        result = self._normalize(
            make_catalog(technique), verify_sources=False, correct_claims=False
        )
        corrections = result.changes_by_kind().get("source-correction", [])
        self.assertTrue(corrections)
        for change in corrections:
            self.assertIn("Verified via", change.rationale)

    def test_dropped_reference_is_removed(self) -> None:
        target = next(iter(policy.REFERENCE_DROPS))
        catalog = make_catalog(make_technique("alpha", related_techniques=(target,)))
        result = self._normalize(catalog)
        self.assertEqual(result.catalog.by_id()["alpha"].related_techniques, ())
        self.assertTrue(result.changes_by_kind().get("reference-dropped"))

    def test_template_ids_are_canonicalized(self) -> None:
        technique = make_technique("alpha")
        template = replace(technique.usage_templates[0], template_id="ab--short-slug")
        catalog = make_catalog(replace(technique, usage_templates=(template,)))
        result = self._normalize(catalog)
        self.assertEqual(
            result.catalog.by_id()["alpha"].usage_templates[0].template_id,
            "alpha--short-slug",
        )

    def test_template_ids_left_alone_when_opted_out(self) -> None:
        technique = make_technique("alpha")
        template = replace(technique.usage_templates[0], template_id="ab--short-slug")
        catalog = make_catalog(replace(technique, usage_templates=(template,)))
        result = self._normalize(catalog, canonicalize_template_id_slugs=False)
        self.assertEqual(
            result.catalog.by_id()["alpha"].usage_templates[0].template_id,
            "ab--short-slug",
        )

    def test_undeclared_template_variable_is_declared(self) -> None:
        template_id, extra = next(iter(policy.TEMPLATE_VARIABLE_ADDITIONS.items()))
        technique_id = template_id.split("--")[0]
        technique = make_technique(technique_id)
        template = replace(
            technique.usage_templates[0], template_id=template_id, variables=()
        )
        catalog = make_catalog(replace(technique, usage_templates=(template,)))
        result = self._normalize(catalog)
        declared = {
            v.name
            for v in result.catalog.by_id()[technique_id].usage_templates[0].variables
        }
        for variable in extra:
            self.assertIn(variable.name, declared)

    def _reparse(self, catalog: Catalog):
        parsed = parse_string(serialize_catalog(catalog))
        return parsed.catalog, parsed.notes

    def test_authored_entry_skipped_when_source_already_covered(self) -> None:
        """A catalog covering the same paper under a different id must not get
        a second record for it."""
        authored = additions.NEW_ENTRIES[0]
        twin = replace(
            make_technique("their-own-id-for-the-same-paper"),
            primary_source=authored.primary_source,
        )
        result = self._normalize(make_catalog(twin), add_entries=True)
        self.assertNotIn(authored.id, result.catalog.ids())
        self.assertTrue(result.changes_by_kind().get("entry-skipped"))

    def test_stub_record_is_enriched_in_place(self) -> None:
        authored = additions.NEW_ENTRIES[0]
        stub = replace(
            make_technique("their-id"),
            primary_source=authored.primary_source,
            description="One line.",
            related_techniques=(),
        )
        peer = make_technique(authored.related_techniques[0])
        result = self._normalize(make_catalog(stub, peer), add_entries=True)
        enriched = result.catalog.by_id()["their-id"]
        self.assertEqual(enriched.description, authored.description)
        self.assertIn(peer.id, enriched.related_techniques)
        # id, name and category are the catalog's, not the authored entry's.
        self.assertEqual(enriched.name, stub.name)
        self.assertTrue(
            enriched.usage_templates[0].template_id.startswith("their-id--")
        )

    def test_enrichment_never_adds_a_dangling_reference(self) -> None:
        authored = additions.NEW_ENTRIES[0]
        stub = replace(
            make_technique("their-id"),
            primary_source=authored.primary_source,
            description="One line.",
            related_techniques=(),
        )
        result = self._normalize(make_catalog(stub), add_entries=True)
        ids = result.catalog.ids()
        for reference in result.catalog.by_id()["their-id"].related_techniques:
            self.assertIn(reference, ids)

    def test_rewrite_skipped_when_target_exists(self) -> None:
        """A rewrite repairs a dangling reference. Once the target is a real
        record, repointing it would corrupt a valid citation."""
        target = next(iter(policy.REFERENCE_REWRITES))
        catalog = make_catalog(
            make_technique("alpha", related_techniques=(target,)),
            make_technique(target),
        )
        result = self._normalize(catalog)
        self.assertEqual(
            result.catalog.by_id()["alpha"].related_techniques, (target,)
        )

    def test_relationship_addition_only_uses_existing_ids(self) -> None:
        record_id, (targets, _) = next(iter(policy.RELATIONSHIP_ADDITIONS.items()))
        present = targets[0]
        catalog = make_catalog(
            make_technique(record_id, related_techniques=()),
            make_technique(present),
        )
        result = self._normalize(catalog)
        added = result.catalog.by_id()[record_id].related_techniques
        self.assertEqual(added, (present,))


    def test_verified_sources_and_hand_corrections_do_not_overlap(self) -> None:
        """One field, one owner. If both tables wrote the same field, whichever
        pass ran last would silently win."""
        verified = load_verified_sources()
        for technique_id, correction in policy.SOURCE_CORRECTIONS.items():
            overlap = set(correction.fields) & set(verified.get(technique_id, {}))
            self.assertEqual(
                overlap, set(), f"{technique_id} is written by both tables: {overlap}"
            )

    def test_verified_sources_never_write_year(self) -> None:
        """`year` means the publication venue's year here, which arXiv cannot
        state. Letting the verifier own it would rewrite 71 baseline records."""
        for record_id, entry in load_verified_sources().items():
            self.assertNotIn("year", entry, record_id)
            self.assertNotIn("venue", entry, record_id)

    def test_verified_sources_carry_provenance(self) -> None:
        payload = json.loads(
            (REPO_ROOT / "promptnexus_hygiene" / "verified_sources.json").read_text()
        )
        self.assertIn("_provenance", payload)
        for key in ("source", "queried_at", "method"):
            self.assertTrue(payload["_provenance"].get(key))

    def test_verified_source_overwrites_the_record(self) -> None:
        technique_id, entry = next(iter(load_verified_sources().items()))
        stale = make_technique(technique_id)
        source = replace(
            stale.primary_source, authors="Wrong et al.", arxiv_id="9999.99999"
        )
        result = self._normalize(make_catalog(replace(stale, primary_source=source)))
        corrected = result.catalog.by_id()[technique_id].primary_source
        self.assertEqual(corrected.authors, entry["authors"])
        self.assertEqual(corrected.arxiv_id, entry["arxiv_id"])

    def test_verified_sources_can_be_disabled(self) -> None:
        technique_id = next(iter(load_verified_sources()))
        stale = make_technique(technique_id)
        source = replace(stale.primary_source, authors="Wrong et al.")
        result = self._normalize(
            make_catalog(replace(stale, primary_source=source)), verify_sources=False
        )
        self.assertEqual(
            result.catalog.by_id()[technique_id].primary_source.authors, "Wrong et al."
        )

    def test_content_replacement_keeps_identity_and_citation(self) -> None:
        """Prose changed; id, status and the verified source must not."""
        record_id, replacement = next(
            iter(content_corrections.CONTENT_REPLACEMENTS.items())
        )
        original = make_technique(record_id, status="corpus-present")
        original = replace(original, corpus_file="Something.pdf")
        # verify_sources is off so the assertion isolates the replacement pass;
        # the source-verification pass legitimately rewrites this same record.
        result = self._normalize(make_catalog(original), verify_sources=False)
        after = result.catalog.by_id()[record_id]
        self.assertEqual(after.description, replacement.description)
        self.assertEqual(after.subcategory, replacement.subcategory)
        self.assertEqual(after.status, original.status)
        self.assertEqual(after.corpus_file, original.corpus_file)
        self.assertEqual(after.primary_source, original.primary_source)

    def test_content_replacement_cannot_add_a_dangling_link(self) -> None:
        record_id = next(iter(content_corrections.CONTENT_REPLACEMENTS))
        result = self._normalize(make_catalog(make_technique(record_id)))
        ids = result.catalog.ids()
        for reference in result.catalog.by_id()[record_id].related_techniques:
            self.assertIn(reference, ids)

    def test_content_replacement_records_its_reasoning(self) -> None:
        record_id = next(iter(content_corrections.CONTENT_REPLACEMENTS))
        result = self._normalize(make_catalog(make_technique(record_id)))
        replaced = result.changes_by_kind().get("content-replaced", [])
        self.assertTrue(replaced)
        for change in replaced:
            self.assertIn("arXiv", change.rationale)

    def test_source_note_states_what_was_not_checked(self) -> None:
        """The note the catalog makes about its own rigour has to be the one it
        actually applied."""
        result = self._normalize(make_catalog())
        note = result.catalog.metadata.source_note
        self.assertIn("have been verified", note)   # "No record's ... have been verified"
        self.assertIn("known_pitfalls", note)
        self.assertIn("No record", note)
        self.assertIn("verified_sources.json", note)

    def test_claim_correction_removes_the_anchored_span(self) -> None:
        record_id, edits = next(iter(claim_corrections.CLAIM_CORRECTIONS.items()))
        edit = edits[0]
        technique = replace(
            make_technique(record_id), **{edit.field: f"before {edit.old} after"}
        )
        result = self._normalize(make_catalog(technique), verify_sources=False)
        after = getattr(result.catalog.by_id()[record_id], edit.field)
        self.assertNotIn(edit.old, after)
        if edit.new:
            self.assertIn(edit.new, after)

    def test_claim_correction_is_fatal_when_the_anchor_is_gone(self) -> None:
        """A correction table that no-ops on drift keeps reporting success while
        the unsupported claim stays in the catalog."""
        record_id = next(iter(claim_corrections.CLAIM_CORRECTIONS))
        technique = replace(
            make_technique(record_id),
            executive_summary="unrelated text",
            description="unrelated text",
        )
        with self.assertRaises(ClaimEditNotApplicable):
            apply_claim_corrections(
                make_catalog(technique), claim_corrections.CLAIM_CORRECTIONS
            )

    def test_claim_correction_is_idempotent(self) -> None:
        record_id, edits = next(iter(claim_corrections.CLAIM_CORRECTIONS.items()))
        edit = edits[0]
        technique = replace(
            make_technique(record_id), **{edit.field: f"before {edit.old} after"}
        )
        once = self._normalize(make_catalog(technique), verify_sources=False)
        twice = normalize(
            *self._reparse(once.catalog), verify_sources=False, add_entries=False
        )
        self.assertEqual(
            getattr(once.catalog.by_id()[record_id], edit.field),
            getattr(twice.catalog.by_id()[record_id], edit.field),
        )

    def test_every_claim_edit_carries_a_warrant(self) -> None:
        for record_id, edits in claim_corrections.CLAIM_CORRECTIONS.items():
            for edit in edits:
                self.assertTrue(edit.warrant.strip(), f"{record_id}.{edit.field}")
                self.assertTrue(edit.old.strip(), f"{record_id}.{edit.field}")

    def test_audit_stamp_marks_only_what_was_checked(self) -> None:
        audited = sorted(policy.DESCRIPTION_AUDITED)[0]
        result = self._normalize(
            make_catalog(make_technique(audited), make_technique("never-audited"))
        )
        by_id = result.catalog.by_id()
        self.assertEqual(
            by_id[audited].source_audit.description, "verified-against-abstract"
        )
        self.assertEqual(by_id["never-audited"].source_audit.description, "unverified")

    def test_no_record_claims_verified_pitfalls(self) -> None:
        """Nothing has been checked against a paper's limitations yet, in any
        record. The day that changes, this test is what forces the label to
        change with it."""
        result = self._normalize(make_catalog())
        for technique in result.catalog.techniques:
            self.assertEqual(technique.source_audit.pitfalls, "unverified")
        self.assertEqual(policy.PITFALLS_AUDITED, frozenset())

    def test_source_note_states_the_pitfalls_gap(self) -> None:
        note = self._normalize(make_catalog()).catalog.metadata.source_note
        self.assertIn("known_pitfalls", note)
        self.assertIn("source_audit", note)

    def test_metadata_is_synchronised(self) -> None:
        catalog = make_catalog()
        catalog = replace(
            catalog,
            catalog_version="2.0.0",
            metadata=replace(catalog.metadata, catalog_version="1.0.0", entry_count="99"),
        )
        result = self._normalize(catalog)
        self.assertEqual(result.catalog.metadata.catalog_version, "2.0.0")
        self.assertEqual(result.catalog.metadata.entry_count, "2")
        self.assertEqual(result.catalog.entry_count, "2")

    def test_normalization_is_idempotent(self) -> None:
        catalog = make_catalog(
            make_technique("alpha", verification_status="task-dependent"),
            make_technique("beta", category="memory-meta-reasoning"),
        )
        first = self._normalize(catalog)
        second_parsed = parse_string(serialize_catalog(first.catalog))
        second = normalize(
            second_parsed.catalog, second_parsed.notes, add_entries=False
        )
        self.assertEqual(
            serialize_catalog(first.catalog), serialize_catalog(second.catalog)
        )
        self.assertEqual(second.changes, ())

    def test_normalized_output_passes_validation(self) -> None:
        catalog = make_catalog(
            make_technique("alpha", verification_status="classifier-dependent"),
            make_technique("beta", category="structured-symbolic-reasoning"),
        )
        result = self._normalize(catalog)
        report = run_checks(parse_string(serialize_catalog(result.catalog)))
        self.assertEqual(report.errors, ())

    def test_every_change_carries_a_rationale(self) -> None:
        catalog = make_catalog(make_technique("alpha", verification_status="self-verifying"))
        result = self._normalize(catalog)
        self.assertTrue(result.changes)
        for change in result.changes:
            self.assertTrue(change.rationale.strip(), change)


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


class TestReporting(unittest.TestCase):
    def test_report_renderers_produce_output(self) -> None:
        catalog = make_catalog(make_technique("alpha", related_techniques=("ghost",)))
        report = run_checks(parse_string(serialize_catalog(catalog)))
        self.assertIn("FAIL", render_report_text(report, source="x"))
        payload = json.loads(render_report_json(report, source="x"))
        self.assertFalse(payload["ok"])
        self.assertIn("::error", render_report_github(report, source="x"))

    def test_ledger_renderers_produce_output(self) -> None:
        catalog = make_catalog(make_technique("alpha", verification_status="task-dependent"))
        parsed = parse_string(serialize_catalog(catalog))
        result = normalize(parsed.catalog, parsed.notes)
        payload = json.loads(render_ledger_json(result, source="x"))
        self.assertGreater(payload["change_count"], 0)
        markdown = render_ledger_markdown(result, source="x")
        self.assertIn("# Catalog normalization ledger", markdown)
        self.assertIn("Manual actions", markdown)


# --------------------------------------------------------------------------
# CLI + end-to-end on the real export
# --------------------------------------------------------------------------


class TestExports(unittest.TestCase):
    def _write_per_technique(self, root: Path, records: list[dict]) -> Path:
        directory = root / "techniques"
        (directory / "json").mkdir(parents=True)
        (directory / "markdown").mkdir(parents=True)
        for record in records:
            (directory / "json" / f"{record['id']}.json").write_text(
                json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            (directory / "markdown" / f"{record['id']}.md").write_text("x", encoding="utf-8")
        (directory / "INDEX.json").write_text(
            json.dumps(
                {
                    "catalog_version": "1.0.0",
                    "schema_version": schema.SCHEMA_VERSION,
                    "entry_count": len(records),
                    "techniques": [
                        {"id": r["id"], "name": r["name"], "category": r["category"]}
                        for r in records
                    ],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return directory

    def test_record_uses_the_canonical_key_order(self) -> None:
        record = technique_to_record(make_technique("alpha"))
        self.assertEqual(tuple(record), RECORD_KEY_ORDER)

    def test_catalog_json_round_trips_through_comparison(self) -> None:
        catalog = make_catalog()
        payload = json.loads(catalog_to_json(catalog))
        # Shape must match data/prompt_technique_catalog.json exactly, or the
        # emitted file is not a drop-in for the source of truth.
        self.assertEqual(list(payload), ["catalog_metadata", "techniques"])
        self.assertEqual(
            payload["catalog_metadata"]["entry_count"], len(catalog.techniques)
        )
        self.assertEqual(len(payload["techniques"]), len(catalog.techniques))

    def test_matching_exports_report_no_divergence(self) -> None:
        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            directory = self._write_per_technique(
                Path(tmp), [technique_to_record(t) for t in catalog.techniques]
            )
            result = compare_exports(catalog, per_technique_dir=directory)
        self.assertTrue(result.ok, result.divergences)
        self.assertEqual(result.compared_records, len(catalog.techniques))

    def test_record_absent_from_export_is_reported(self) -> None:
        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            directory = self._write_per_technique(
                Path(tmp), [technique_to_record(catalog.techniques[0])]
            )
            result = compare_exports(catalog, per_technique_dir=directory)
        self.assertIn(
            "record-missing-from-export", {d.kind for d in result.divergences}
        )

    def test_field_divergence_is_reported(self) -> None:
        catalog = make_catalog()
        records = [technique_to_record(t) for t in catalog.techniques]
        records[0]["description"] = "something else entirely"
        with tempfile.TemporaryDirectory() as tmp:
            directory = self._write_per_technique(Path(tmp), records)
            result = compare_exports(catalog, per_technique_dir=directory)
        self.assertIn("field-divergence", {d.kind for d in result.divergences})

    def test_encoding_differences_are_not_divergences(self) -> None:
        """A year written as 2024 and as '2024' is the same year; an omitted
        optional field and an explicit null are the same absence."""
        catalog = make_catalog()
        records = [technique_to_record(t) for t in catalog.techniques]
        records[0]["primary_source"]["year"] = str(records[0]["primary_source"]["year"])
        records[0].pop("corpus_file")
        with tempfile.TemporaryDirectory() as tmp:
            directory = self._write_per_technique(Path(tmp), records)
            result = compare_exports(catalog, per_technique_dir=directory)
        self.assertTrue(result.ok, result.divergences)

    def test_markdown_stamp_mismatch_is_reported(self) -> None:
        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            markdown = Path(tmp) / "CATALOG.md"
            markdown.write_text(
                "# Catalog\n\n*Catalog version 0.0.1 . schema version "
                f"{schema.SCHEMA_VERSION} . generated 1999-01-01 . 999 entries*\n",
                encoding="utf-8",
            )
            result = compare_exports(catalog, markdown_path=markdown)
        kinds = {d.kind for d in result.divergences}
        self.assertIn("stamp-mismatch", kinds)


class TestJsonInputAndPatch(unittest.TestCase):
    def test_json_round_trips_through_the_model(self) -> None:
        catalog = make_catalog()
        reparsed = parse_json_string(catalog_to_json(catalog)).catalog
        self.assertEqual(reparsed.techniques, catalog.techniques)
        self.assertEqual(reparsed.metadata, catalog.metadata)

    def test_json_absent_values_survive_a_round_trip(self) -> None:
        """The source of truth writes an absent optional as null; emitting ""
        instead would rewrite hundreds of values that did not change."""
        technique = make_technique("alpha", corpus_file=None)
        source = replace(technique.primary_source, url="", arxiv_id="")
        catalog = make_catalog(replace(technique, primary_source=source))
        payload = json.loads(catalog_to_json(catalog))
        record = payload["techniques"][0]
        self.assertIsNone(record["corpus_file"])
        self.assertIsNone(record["primary_source"]["url"])

    def test_malformed_json_raises_parse_error(self) -> None:
        with self.assertRaises(CatalogParseError):
            parse_json_string("{not json")
        with self.assertRaises(CatalogParseError):
            parse_json_string('{"techniques": []}')

    def test_patch_reports_added_modified_and_untouched(self) -> None:
        baseline = make_catalog(make_technique("alpha"), make_technique("beta"))
        target = make_catalog(
            make_technique("alpha"),
            replace(make_technique("beta"), description="rewritten"),
            make_technique("gamma"),
        )
        patch = build_patch(baseline, target)
        self.assertEqual(patch.added, ("gamma",))
        self.assertEqual(patch.removed, ())
        self.assertEqual([c.record_id for c in patch.modified], ["beta"])
        self.assertEqual(patch.unchanged, ("alpha",))

    def test_patch_descends_into_nested_fields(self) -> None:
        """A whole-object diff is not reviewable; the manifest must name the
        sub-field that changed."""
        baseline = make_catalog(make_technique("alpha"))
        technique = make_technique("alpha")
        source = replace(technique.primary_source, url="https://example.invalid/new")
        target = make_catalog(replace(technique, primary_source=source))
        patch = build_patch(baseline, target)
        self.assertEqual(
            [c.field for c in patch.modified[0].fields], ["primary_source.url"]
        )

    def test_patch_detects_removal(self) -> None:
        baseline = make_catalog(make_technique("alpha"), make_technique("beta"))
        target = make_catalog(make_technique("alpha"))
        self.assertEqual(build_patch(baseline, target).removed, ("beta",))


class TestBundle(unittest.TestCase):
    def _bundle(self, catalog, root):
        from promptnexus_hygiene.bundle import write_bundle

        return write_bundle(catalog, root)

    def test_bundle_writes_every_format(self) -> None:
        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            manifest = self._bundle(catalog, tmp)
            root = Path(tmp)
            for name in (
                "prompt_technique_catalog.json",
                "prompt_technique_catalog.xml",
                "prompt_technique_catalog.yaml",
                "techniques/INDEX.json",
                "techniques/INDEX.md",
                "README.md",
            ):
                self.assertTrue((root / name).is_file(), name)
            for technique in catalog.techniques:
                self.assertTrue((root / "techniques" / "json" / f"{technique.id}.json").is_file())
                self.assertTrue((root / "techniques" / "yaml" / f"{technique.id}.yaml").is_file())
            self.assertEqual(manifest.entry_count, len(catalog.techniques))

    def test_formats_carry_identical_records(self) -> None:
        """Three serializations of one model must not be able to disagree."""
        import yaml as _yaml

        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            self._bundle(catalog, tmp)
            root = Path(tmp)
            as_json = json.loads((root / "prompt_technique_catalog.json").read_text())
            as_yaml = _yaml.safe_load((root / "prompt_technique_catalog.yaml").read_text())
            self.assertEqual(as_json, as_yaml)
            from promptnexus_hygiene.model import parse_catalog as _parse

            as_xml = _parse(root / "prompt_technique_catalog.xml").catalog
            self.assertEqual(as_xml.techniques, catalog.techniques)

    def test_bundle_is_byte_reproducible(self) -> None:
        import filecmp

        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a", Path(tmp) / "b"
            self._bundle(catalog, a)
            self._bundle(catalog, b)
            for path in sorted(p for p in a.rglob("*") if p.is_file()):
                self.assertTrue(
                    filecmp.cmp(path, b / path.relative_to(a), shallow=False), path.name
                )

    def test_bundle_passes_its_own_export_comparison(self) -> None:
        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            self._bundle(catalog, tmp)
            result = compare_exports(
                catalog, per_technique_dir=Path(tmp) / "techniques"
            )
        self.assertTrue(result.ok, result.divergences)

    def test_yaml_uses_no_anchors(self) -> None:
        """PyYAML aliases repeated objects by default, which is valid and
        unreadable in a version diff."""
        catalog = make_catalog()
        with tempfile.TemporaryDirectory() as tmp:
            self._bundle(catalog, tmp)
            text = (Path(tmp) / "prompt_technique_catalog.yaml").read_text()
        self.assertNotIn("&id0", text)
        self.assertNotIn("*id0", text)


class TestRendering(unittest.TestCase):
    def test_markdown_has_a_section_per_record(self) -> None:
        from promptnexus_hygiene.render import catalog_to_markdown

        catalog = make_catalog()
        text = catalog_to_markdown(catalog)
        for technique in catalog.techniques:
            self.assertIn(f"### {technique.name}", text)
            self.assertIn(f"`{technique.id}`", text)

    def test_markdown_states_the_audit_state_per_record(self) -> None:
        """The gap this label exists to close is a reader deep in a record with
        no idea what the catalog is vouching for."""
        from promptnexus_hygiene.render import catalog_to_markdown

        text = catalog_to_markdown(make_catalog())
        self.assertIn("**Source audit:**", text)
        self.assertIn("not traced to the source", text)

    def test_markdown_toc_anchors_resolve(self) -> None:
        from promptnexus_hygiene.render import catalog_to_markdown, _anchor

        catalog = make_catalog()
        text = catalog_to_markdown(catalog)
        for technique in catalog.techniques:
            self.assertIn(f"(#{_anchor(technique.name)})", text)

    def test_markdown_is_deterministic(self) -> None:
        from promptnexus_hygiene.render import catalog_to_markdown

        catalog = make_catalog()
        self.assertEqual(catalog_to_markdown(catalog), catalog_to_markdown(catalog))

    def test_unknown_status_fails_loudly(self) -> None:
        """Better a raised KeyError at build time than a raw slug in a published
        catalog, which is the failure mode nothing catches."""
        from promptnexus_hygiene.render import _status_line

        with self.assertRaises(KeyError):
            _status_line(replace(make_technique("alpha"), status="invented"))

    def test_pdf_is_written_and_strips_emoji(self) -> None:
        from promptnexus_hygiene.render import write_pdf

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.pdf"
            size = write_pdf(make_catalog(), path)
            self.assertGreater(size, 1000)
            self.assertTrue(path.read_bytes().startswith(b"%PDF"))


class TestWebApp(unittest.TestCase):
    def _html(self, catalog=None):
        from promptnexus_hygiene.webapp import catalog_to_app

        return catalog_to_app(catalog or make_catalog())

    def test_app_is_self_contained(self) -> None:
        """It has to work from file:// with no network: no CDN, no external
        stylesheet, no web font."""
        html = self._html()
        for forbidden in ("http://", "https://cdn", "<link", "@import", "fonts.googleapis"):
            self.assertNotIn(forbidden, html.replace("https://arxiv.org", ""))

    def test_every_record_is_embedded(self) -> None:
        catalog = make_catalog()
        html = self._html(catalog)
        payload = json.loads(
            html.split('<script id="catalog-data" type="application/json">')[1]
            .split("</script>")[0]
            .replace("<\\/", "</")
        )
        self.assertEqual(len(payload["techniques"]), len(catalog.techniques))

    def test_template_bodies_cannot_break_out_of_the_script_block(self) -> None:
        """A prompt template containing </script> would otherwise end the data
        block early and take the rest of the page with it."""
        technique = make_technique("alpha")
        hostile = replace(
            technique.usage_templates[0],
            template="Wrap it in </script><script>alert(1)</script> please",
        )
        html = self._html(make_catalog(replace(technique, usage_templates=(hostile,))))
        block = html.split('<script id="catalog-data" type="application/json">')[1]
        block = block.split("</script>")[0]
        self.assertIn("alert(1)", block)  # survived intact, inside the block

    def test_all_sentinels_are_replaced(self) -> None:
        html = self._html()
        for sentinel in ("__CATALOG_DATA__", "__CATALOG_META__", "__CATALOG_LABELS__"):
            self.assertNotIn(sentinel, html)

    def test_app_is_deterministic(self) -> None:
        catalog = make_catalog()
        self.assertEqual(self._html(catalog), self._html(catalog))

    def test_labels_reach_the_app(self) -> None:
        html = self._html()
        self.assertIn("Reasoning Elicitation", html)
        self.assertIn("not traced to the source", html)


class TestCommandLine(unittest.TestCase):
    def _run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "promptnexus_hygiene", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_validate_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            clean = Path(tmp) / "clean.xml"
            clean.write_text(serialize_catalog(make_catalog()), encoding="utf-8")
            self.assertEqual(self._run("validate", str(clean)).returncode, 0)

            broken = Path(tmp) / "broken.xml"
            broken.write_text(
                serialize_catalog(
                    make_catalog(make_technique("alpha", related_techniques=("ghost",)))
                ),
                encoding="utf-8",
            )
            self.assertEqual(self._run("validate", str(broken)).returncode, 1)

    def test_missing_input_is_usage_error(self) -> None:
        self.assertEqual(self._run("validate", "/nonexistent.xml").returncode, 2)

    def test_normalize_requires_output_unless_dry_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.xml"
            path.write_text(serialize_catalog(make_catalog()), encoding="utf-8")
            self.assertEqual(self._run("normalize", str(path)).returncode, 2)
            self.assertEqual(
                self._run("normalize", str(path), "--dry-run").returncode, 0
            )

    @unittest.skipUnless(REAL_CATALOG.exists(), "real catalog export not present")
    def test_real_catalog_normalizes_to_the_expected_residual(self) -> None:
        """The mechanical defect classes must go to zero; the editorial ones
        must survive, because a tool that silently 'fixes' a wrong citation is
        worse than one that leaves it visible."""
        from promptnexus_hygiene.model import parse_catalog

        parsed = parse_catalog(REAL_CATALOG)
        before = run_checks(parsed)
        mechanical = {"C001", "C002", "C003", "C005", "C006", "C007", "C008", "C009"}
        self.assertTrue(mechanical & {f.check_id for f in before.errors})

        result = normalize(parsed.catalog, parsed.notes)
        after = run_checks(
            parse_string(serialize_catalog(result.catalog)), strict=True
        )
        self.assertEqual(after.errors, ())
        self.assertEqual(after.warnings, ())
        self.assertTrue(after.ok)
        # 170 as received, minus 2 merged duplicates, plus 6 authored entries.
        self.assertEqual(len(result.catalog.techniques), 174)


    @unittest.skipUnless(FINAL_CATALOG.exists(), "FINAL release not present")
    def test_final_release_normalizes_to_a_clean_strict_build(self) -> None:
        """The v1.19.0-FINAL release ships with its own gate green. This asserts
        what that gate misses and that remediation closes all of it."""
        from promptnexus_hygiene.model import parse_catalog

        parsed = parse_catalog(FINAL_CATALOG)
        before = run_checks(parsed)
        self.assertTrue(before.errors, "FINAL should not be clean as shipped")

        result = normalize(parsed.catalog, parsed.notes)
        after = run_checks(
            parse_string(serialize_catalog(result.catalog)), strict=True
        )
        self.assertEqual(after.errors, ())
        self.assertEqual(after.warnings, ())
        # 177 as shipped, minus the hyde, flare and opro duplicate pairs.
        self.assertEqual(len(result.catalog.techniques), 174)


    @unittest.skipUnless(FINAL_CATALOG.exists(), "FINAL release not present")
    def test_shipped_exports_disagree_with_the_shipped_xml(self) -> None:
        """The Markdown header promises the dataset and the human-readable
        catalog can never drift apart. They have."""
        from promptnexus_hygiene.model import parse_catalog

        markdown = Path("/mnt/user-data/uploads/PROMPT_TECHNIQUE_CATALOG.md")
        if not markdown.is_file():
            self.skipTest("markdown export not present")
        catalog = parse_catalog(FINAL_CATALOG).catalog
        result = compare_exports(catalog, markdown_path=markdown)
        self.assertFalse(result.ok)
        self.assertIn("stamp-mismatch", {d.kind for d in result.divergences})


    @unittest.skipUnless(
        Path("/mnt/user-data/uploads/prompt_technique_catalog.json").exists(),
        "source-of-truth JSON not present",
    )
    def test_shipped_source_of_truth_is_clean_apart_from_the_schema_bump(self) -> None:
        """The 130-record source of truth has no content defects -- the entire
        surface lives in the 40 records that only ever existed in the XML.

        It does now fail on schema version, because it predates 1.3.0 and so
        carries no source_audit. That is what a migration is supposed to look
        like: the old file is invalid under the new schema until it is
        regenerated, which is why the bump and the merge have to land together.
        """
        from promptnexus_hygiene.model import parse_catalog

        parsed = parse_catalog("/mnt/user-data/uploads/prompt_technique_catalog.json")
        report = run_checks(parsed)
        self.assertEqual(len(parsed.catalog.techniques), 130)
        self.assertEqual({f.check_id for f in report.errors}, {"C001"})
        self.assertTrue(
            all("schema_version" in f.message for f in report.errors), report.errors
        )


if __name__ == "__main__":
    unittest.main()
