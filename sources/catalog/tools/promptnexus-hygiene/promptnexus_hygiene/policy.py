"""Remediation policy: every judgement call, in one reviewable place.

Nothing here is inferred at runtime. Each mapping is an explicit editorial
decision with a recorded rationale, so a reviewer can disagree with a single
line rather than reverse-engineering the normalizer. Port this file into
``scripts/build_catalog.py`` once accepted -- fixing the XML export alone
leaves the JSON source of truth wrong and the drift returns on the next build.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from .model import Variable

__all__ = [
    "Decision",
    "MergeRule",
    "StatusPolicy",
    "CATEGORY_REMAP",
    "CATEGORIES_TO_REGISTER",
    "VERIFICATION_STATUS_REMAP",
    "DETERMINISM_REMAP",
    "STATUS_REMAP",
    "MERGES",
    "REFERENCE_REWRITES",
    "REFERENCE_DROPS",
    "SourceCorrection",
    "SOURCE_CORRECTIONS",
    "TEMPLATE_VARIABLE_ADDITIONS",
    "ALIAS_COLLISION_ALLOWLIST",
    "ABBREVIATED_AUTHOR_BACKLOG",
    "SOURCE_NOTE",
    "KNOWN_MANUAL_ACTIONS",
]


@dataclass(frozen=True, slots=True)
class Decision:
    """A single value-level remapping and why it was made."""

    to: str
    rationale: str


@dataclass(frozen=True, slots=True)
class MergeRule:
    """Fold ``absorbed`` into ``survivor``.

    List-valued fields are unioned (survivor order first, then novel items from
    the absorbed entry). Scalar fields keep the survivor's value. The absorbed
    id is retained as an alias so existing lookups still resolve, and every
    inbound ``related_techniques`` reference is rewritten to the survivor.
    """

    survivor: str
    absorbed: str
    rationale: str


class StatusPolicy:
    """How to treat the ``practitioner-guide`` status value."""

    REGISTER = "register"
    REMAP = "remap"
    CHOICES = (REGISTER, REMAP)


# --------------------------------------------------------------------------
# Categories
# --------------------------------------------------------------------------

#: Singleton categories folded into an existing peer. Each of these was coined
#: for a single entry and duplicates the concept of a category that already
#: exists; a taxonomy where 3 of 15 categories have one member each is not a
#: taxonomy.
CATEGORY_REMAP: Final[dict[str, Decision]] = {
    "example-selection-ensemble": Decision(
        to="example-selection-formatting",
        rationale=(
            "Members are medprompt-framework and knn-prompting; both are "
            "example selection. Ensembling is a property of a technique, not a "
            "distinct taxonomic axis, and the existing category already covers "
            "the concept. Overrule by deleting this line if the split is wanted."
        ),
    ),
    "memory-meta-reasoning": Decision(
        to="reasoning-elicitation",
        rationale=(
            "Single member (buffer-of-thoughts). A reusable thought-template "
            "buffer elicits reasoning; it is a subcategory concern, and the "
            "entry already carries a distinguishing subcategory."
        ),
    ),
    "structured-symbolic-reasoning": Decision(
        to="reasoning-elicitation",
        rationale=(
            "Members are chain-of-code and chain-of-symbol. Sibling techniques "
            "that reason through code or symbols (program-of-thoughts, "
            "chain-of-draft) already sit in reasoning-elicitation; splitting "
            "them is inconsistent. Overrule by deleting this line."
        ),
    ),
}

#: Categories that are in genuine use and should be promoted into
#: ``<catalog_metadata>/<categories>`` rather than folded away.
CATEGORIES_TO_REGISTER: Final[dict[str, Decision]] = {
    "prompt-compression-context-engineering": Decision(
        to="prompt-compression-context-engineering",
        rationale=(
            "Three members (longllmlingua, selective-context, recomp) and it "
            "answers the gap analysis's recommendation for a System Design / "
            "Context Engineering area. Real mass, real concept: register it."
        ),
    ),
}

# --------------------------------------------------------------------------
# Controlled-vocabulary drift
# --------------------------------------------------------------------------
# `verification_status` answers one question: what can decide whether the
# technique produced a correct result? The drifted values answer a different
# question -- *where* enforcement happens -- which is design detail that belongs
# in `description`, not in a status enum. They are mapped back onto the axis.

VERIFICATION_STATUS_REMAP: Final[dict[str, Decision]] = {
    "self-verifying": Decision(
        to="verifier-checkable",
        rationale=(
            "SelfCheckGPT emits a consistency score a program can threshold; "
            "'self-' describes who runs the verifier, not whether one exists."
        ),
    ),
    "enforced-at-runtime": Decision(
        to="verifier-checkable",
        rationale=(
            "A guardrail either fired or did not; that is machine-decidable. "
            "Enforcement point belongs in the description."
        ),
    ),
    "enforced-at-decode-time": Decision(
        to="verifier-checkable",
        rationale="Grammar conformance of the decoded output is machine-decidable.",
    ),
    "enforced-by-dsl-compiler": Decision(
        to="verifier-checkable",
        rationale="Compiler acceptance is machine-decidable; same axis as above.",
    ),
    "classifier-dependent": Decision(
        to="verifier-checkable",
        rationale=(
            "Llama Guard returns a label a program can assert against. "
            "Classifier accuracy is a quality question, not a checkability one."
        ),
    ),
    "implementation-dependent": Decision(
        to="unverifiable-by-text",
        rationale=(
            "Prefix caching, XML tagging and spotlighting leave no signal in "
            "the emitted text that says the technique was applied correctly."
        ),
    ),
    "task-dependent": Decision(
        to="unverifiable-by-text",
        rationale=(
            "CO-STAR shapes a prompt; nothing in the response settles whether "
            "the framework was followed."
        ),
    ),
}

DETERMINISM_REMAP: Final[dict[str, Decision]] = {
    "implementation-dependent": Decision(
        to="requires-external-system",
        rationale=(
            "A verification_status value used in the determinism field -- the "
            "two vocabularies leaked into each other. Constrained decoding is "
            "deterministic or not depending on the decoding engine, which is "
            "exactly what requires-external-system already denotes."
        ),
    ),
    "non-deterministic": Decision(
        to="stochastic-by-design",
        rationale=(
            "Exact synonym of the established value; two spellings of one "
            "concept defeat grouping and filtering."
        ),
    ),
    "deterministic": Decision(
        to="deterministic-at-temperature-zero",
        rationale=(
            "Unqualified 'deterministic' overclaims: no LLM call is "
            "deterministic above temperature zero. The qualified value is the "
            "honest one and is what the other 86 templates use."
        ),
    ),
}

#: Only applied under ``StatusPolicy.REMAP``. The default is to register
#: ``practitioner-guide`` in the schema instead, because collapsing vendor docs
#: into ``verified-external`` silently upgrades their evidence tier -- the
#: catalog would then claim three entries were verified against literature that
#: does not exist.
STATUS_REMAP: Final[dict[str, Decision]] = {
    "practitioner-guide": Decision(
        to="verified-external",
        rationale=(
            "Lossy fallback for consumers that hard-code the original "
            "two-value status enum. Prefer StatusPolicy.REGISTER."
        ),
    ),
}

# --------------------------------------------------------------------------
# Duplicate entries
# --------------------------------------------------------------------------

MERGES: Final[tuple[MergeRule, ...]] = (
    MergeRule(
        survivor="opro",
        absorbed="opro-optimization-by-prompting",
        rationale=(
            "Exact duplicate: same paper (arXiv 2309.03409), same title. The "
            "absorbed record was created to satisfy textgrad's mangled "
            "'oprompt-optimization' reference; the fix for a mis-typed id is to "
            "repoint the reference, not to mint a second record for the same "
            "paper. The original entry survives because it is the fuller one."
        ),
    ),
    MergeRule(
        survivor="hyde",
        absorbed="hyde-hypothetical-document-embeddings",
        rationale=(
            "Identical technique: same name, same title, same arXiv 2212.10496, "
            "same template_id. Shorter id kept as the canonical slug."
        ),
    ),
    MergeRule(
        survivor="flare",
        absorbed="flare-forward-looking-active-retrieval",
        rationale=(
            "Identical technique: same name, same title, same arXiv 2305.06983, "
            "same template_id. Shorter id kept as the canonical slug."
        ),
    ),
)

# --------------------------------------------------------------------------
# Cross-references
# --------------------------------------------------------------------------

#: Dangling ``related_techniques`` targets with an unambiguous intended entry.
#: Only add a line here when the target is certain -- a wrong rewrite is worse
#: than a dangling reference the validator will keep shouting about.
REFERENCE_REWRITES: Final[dict[str, Decision]] = {
    "grammar-constrained-decoding": Decision(
        to="grammar-constrained-decoding-efficiency",
        rationale=(
            "Short form of an entry that exists under the longer id; cited by "
            "lmql and sglang."
        ),
    ),
    "raptor": Decision(
        to="raptor-recursive-tree-retrieval",
        rationale=(
            "The entry exists under its expanded id and carries RAPTOR as an "
            "alias; cited by graphrag."
        ),
    ),
    "struq-structured-query-defense": Decision(
        to="struq-structured-queries",
        rationale=(
            "Same technique (arXiv 2402.06363) under the catalog's id; cited "
            "by spotlighting-hines."
        ),
    ),
    "xgrammar-structured-generation": Decision(
        to="xgrammar-structured-generation-engine",
        rationale=(
            "Same technique (arXiv 2411.15100) under the catalog's id; cited "
            "by lmql and sglang."
        ),
    ),
    "oprompt-optimization": Decision(
        to="opro",
        rationale=(
            "Mangled form of OPRO (arXiv 2309.03409), which the catalog "
            "already carries; cited by textgrad."
        ),
    ),
}

#: References to delete outright. Reserved for targets that name a research
#: direction rather than an identifiable technique -- authoring an entry to
#: satisfy the citation would be inventing a source.
REFERENCE_DROPS: Final[dict[str, Decision]] = {
    "knowledge-graph-enhanced-prompting": Decision(
        to="",
        rationale=(
            "Names a family of approaches, not a single technique, and matches "
            "no paper the catalog could cite. graphrag retains its other, "
            "resolvable links."
        ),
    ),
}


# --------------------------------------------------------------------------
# Source-record corrections
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SourceCorrection:
    """A verified replacement for a wrong or placeholder ``primary_source``.

    Only fields that are set are changed. ``verified_via`` records what was
    actually checked, so a reviewer can re-run the verification rather than
    trusting this file.
    """

    fields: dict[str, str]
    rationale: str
    verified_via: str


# Field ownership: anything arXiv can state authoritatively -- authors, title,
# year, arxiv_id, url -- belongs to verified_sources.json and is not repeated
# here. This table holds only what a publisher API cannot settle: the venue, and
# records with no arXiv presence at all. Two mechanisms writing one field is how
# a correction silently loses to whichever pass runs last.
SOURCE_CORRECTIONS: Final[dict[str, SourceCorrection]] = {
    "medprompt-framework": SourceCorrection(
        fields={"venue": "arXiv"},
        rationale=(
            "The record named Nature Medicine as the venue for what is an arXiv "
            "preprint, and carried the title of Moor et al.'s Nature "
            "'Generalist Medical AI' over Nori et al.'s authorship. The title, "
            "authors and id are corrected from arXiv; only the venue needs "
            "stating here."
        ),
        verified_via="arXiv 2311.16452 record",
    ),
    "confidence-informed-self-consistency": SourceCorrection(
        fields={"venue": "Findings of ACL 2025"},
        rationale=(
            "Recorded as an arXiv preprint; it appeared in Findings of ACL 2025. "
            "The author placeholder 'Various' is corrected from arXiv."
        ),
        verified_via="Findings of ACL 2025 proceedings record for arXiv 2502.06233",
    ),
    "co-star-framework": SourceCorrection(
        fields={
            "authors": "Teo (GovTech Singapore, Data Science and AI team)",
            "year": "2023",
            "title": "How I Won Singapore's GPT-4 Prompt Engineering Competition",
            "venue": "Towards Data Science",
            "url": (
                "https://towardsdatascience.com/how-i-won-singapores-gpt-4-"
                "prompt-engineering-competition-34c195a93d41/"
            ),
        },
        rationale=(
            "'Practitioner Taxonomies' names no author and the title was "
            "invented. CO-STAR originates with GovTech Singapore's Data "
            "Science and AI team and was published in Teo's December 2023 "
            "write-up, which is the citable artifact."
        ),
        verified_via="Towards Data Science article and GovTech Singapore accounts of the 2023 competition",
    ),
    "zero-shot-prompting": SourceCorrection(
        fields={
            "url": (
                "https://cdn.openai.com/better-language-models/"
                "language_models_are_unsupervised_multitask_learners.pdf"
            ),
        },
        rationale=(
            "status=verified-external with no url or arXiv id, so the "
            "verification could not be reproduced. The GPT-2 technical report "
            "has a stable canonical URL."
        ),
        verified_via="OpenAI CDN copy of the 2019 technical report",
    ),
}


#: Cross-references to add to records that declare none. Each target is either
#: a record that already cites this one (so the link is reciprocal) or its
#: immediate sibling. Kept explicit rather than derived: blanket reciprocation
#: would add hundreds of edges nobody reviewed.
RELATIONSHIP_ADDITIONS: Final[dict[str, tuple[tuple[str, ...], str]]] = {
    "grammar-constrained-decoding": (
        (
            "lmql",
            "sglang",
            "xgrammar-structured-generation-engine",
            "grammar-constrained-decoding-efficiency",
        ),
        "lmql and sglang already cite this record; the other two are the "
        "engine and the efficiency analysis of the same mechanism.",
    ),
    "knowledge-graph-enhanced-prompting": (
        ("graphrag", "retrieval-augmented-generation"),
        "graphrag already cites this record; RAG is the parent mechanism.",
    ),
}


# --------------------------------------------------------------------------
# Record enrichment
# --------------------------------------------------------------------------

#: When a catalog record and an authored entry in :mod:`additions` describe the
#: same paper, the fuller content is transplanted onto the catalog's record --
#: keeping the catalog's id, name, category and status so no cross-reference
#: breaks. Matching is by arXiv id, not by record id, because two catalogs can
#: name the same technique differently.
ENRICH_BY_ARXIV_ID: Final[bool] = True

ENRICHMENT_RATIONALE: Final[str] = (
    "Record covered the right paper but carried a stub body (one-line "
    "description, no cross-references, a '--primary-template' placeholder). "
    "Replaced with the authored content for the same source; id, name, "
    "category and status preserved so existing references keep resolving."
)


# --------------------------------------------------------------------------
# Template repairs
# --------------------------------------------------------------------------

#: Placeholders used in a template body but never declared. Adding a
#: declaration is safe where the placeholder's meaning is unambiguous from the
#: body; anything less obvious stays a validation failure for a human.
TEMPLATE_VARIABLE_ADDITIONS: Final[dict[str, tuple[Variable, ...]]] = {
    "lmql--constrained-query": (
        Variable(
            name="review_text",
            description=(
                "The input text interpolated into the worked example inside the "
                "LMQL query body."
            ),
            example="The battery lasts two days but the screen scratches easily.",
        ),
    ),
}

#: Alias strings that legitimately denote two techniques. These are real
#: collisions in the literature, not catalog errors, but they must be declared
#: so that an alias index is a documented many-to-one rather than a silent one.
ALIAS_COLLISION_ALLOWLIST: Final[dict[str, str]] = {
    "bot": "Boosting-of-Thoughts and Buffer-of-Thoughts both use this acronym.",
    "dsp": (
        "Directional Stimulus Prompting and Demonstrate-Search-Predict both "
        "use this acronym."
    ),
}

#: Entries whose ``primary_source.authors`` reads "X et al." where the catalog's
#: convention is a full surname sequence. This was 29 entries; all of them were
#: backfilled from the live arXiv author lists (see verified_sources.json), so
#: the list is empty and every abbreviation now fails --strict on sight. The
#: mechanism stays because a future import may need the same waiver, but a
#: waiver should be a temporary state with a name on it, not a permanent one.
ABBREVIATED_AUTHOR_BACKLOG: Final[frozenset[str]] = frozenset()

ABBREVIATED_AUTHOR_BACKLOG_NOTE: Final[str] = (
    "Known abbreviated author string; backfill the full surname sequence from "
    "the source. Tracked, not ignored."
)


#: The catalog's own account of how its entries were sourced. The previous
#: wording asserted that every verified-external entry had been "verified live
#: against arXiv/publisher records" -- which was not true of the 40 records that
#: reached the XML export without passing through the builder: five of them
#: cited papers nobody had opened. A claim a catalog makes about its own rigour
#: has to be the one it actually applied.
SOURCE_NOTE: Final[str] = (
    "Synthesized from the PROMPTS.zip PDF corpus (status=corpus-present entries) "
    "plus literature located via web search (status=verified-external entries) "
    "and first-party vendor documentation (status=practitioner-guide entries). "
    "As of v1.20.0 every arXiv-backed primary_source has been resolved against "
    "the live arXiv API -- authors, title and id are taken from the publisher "
    "record rather than transcribed (see verified_sources.json for the table and "
    "its provenance); that pass corrected five records citing an id that belonged "
    "to an unrelated paper. Record prose has been audited against the source "
    "abstract for the 38 records added in v1.20.0 and for a seeded random sample "
    "of 24 pre-existing records; two records were rewritten and nine had "
    "unsupported claims removed. No record's known_pitfalls or when_not_to_use "
    "claims have been verified against the source paper -- in any record, "
    "including pre-existing ones. Per-record audit state is carried in the "
    "source_audit element. See PromptNexus_Literature_Review.md for the search "
    "history."
)


#: Records whose description was compared against the source abstract and
#: corrected where unsupported. Everything else keeps the default `unverified`.
#: This is a record of work done, not a quality judgement: an unverified record
#: may be perfectly accurate, and the sampled ones were.
DESCRIPTION_AUDITED: Final[frozenset[str]] = frozenset(
    {
        "adaptive-graph-of-thoughts",
        "adaptive-rag",
        "apar-auto-parallel-decoding",
        "autodan-genetic-jailbreak",
        "autogen",
        "automatic-prompt-engineer",
        "branch-solve-merge",
        "buffer-of-thoughts",
        "cache-optimized-context-engineering",
        "chain-of-code",
        "chain-of-draft",
        "co-star-framework",
        "codet",
        "confidence-informed-self-consistency",
        "constitutional-ai",
        "corrective-rag",
        "crescendo-multi-turn-jailbreak",
        "dera",
        "diffusion-formal-syntax",
        "evoprompt",
        "expertprompting",
        "factscore",
        "flare",
        "found-in-the-middle-calibration",
        "frugalgpt",
        "grammar-constrained-decoding-efficiency",
        "graph-of-thoughts",
        "graphrag",
        "hierarchical-chain-of-thought",
        "highlighted-chain-of-thought",
        "hyde",
        "indirect-prompt-injection",
        "instance-adaptive-zero-shot-cot",
        "llama-guard",
        "lmql",
        "longllmlingua",
        "maieutic-prompting",
        "many-tier-instruction-hierarchy",
        "medprompt-framework",
        "mipro",
        "modularization-of-thought-code-gen",
        "nemo-guardrails",
        "opro",
        "plan-and-solve-prompting",
        "prompt-pattern-catalog",
        "promptrobust-perturbation-benchmark",
        "rarr",
        "recomp",
        "selective-context",
        "selfcheckgpt",
        "sglang",
        "skeleton-of-thought",
        "spotlighting-hines",
        "step-back-prompting",
        "swe-agent",
        "system-2-attention",
        "textgrad",
        "thought-propagation",
        "truncproof-json-guardrail",
        "verify-and-edit",
        "xgrammar-structured-generation-engine",
        "xml-tagging-schema-specs",
    }
)

#: No record's pitfalls have been checked against a paper -- not in the import,
#: not in the pre-existing 130. The label is uniform today and will stop being
#: uniform as the work in FOLLOW_UP.md gets done, which is the point of carrying
#: it per record rather than only in source_note.
PITFALLS_AUDITED: Final[frozenset[str]] = frozenset()


# --------------------------------------------------------------------------
# Work that a program must not do on its own
# --------------------------------------------------------------------------

#: Defects that require a human to consult a source. The normalizer will not
#: invent content for these; the validator reports them until they are fixed
#: upstream in the JSON source of truth.
KNOWN_MANUAL_ACTIONS: Final[tuple[str, ...]] = (
    "Port this policy, the authored entries in additions.py and the ledger's "
    "edits into data/prompt_technique_catalog.json and scripts/build_catalog.py. "
    "Until that lands, the next build re-emits every defect this pass repaired: "
    "the XML is an export, not the source of truth.",
    "29 entries still carry an abbreviated 'X et al.' author string where the "
    "catalog convention is the full surname sequence. They are tracked as a "
    "waived C016 backlog (see --show-waived), so a new abbreviation fails a "
    "strict build while these stay visible until backfilled from source. Note "
    "that one of them, structured-cot-code-generation, predates the appended "
    "block -- this is not purely a v1.19.0 problem.",
    "15 template_id values were renamed to the '<technique-id>--<slug>' "
    "convention. That is a breaking change for anything citing a template by "
    "id; the ledger lists every old -> new pair, and --keep-template-ids opts "
    "out if external consumers depend on the old values.",
    "chain-of-symbol records the arXiv title verbatim, including its typo "
    "('Langauge'). Fidelity to the record was preferred over a silent "
    "correction; change it only if the catalog adopts a normalisation rule for "
    "source titles.",
    "graphrag's reference to 'knowledge-graph-enhanced-prompting' was dropped "
    "rather than satisfied: it names a research direction, not a technique with "
    "a citable source. If a specific method was meant, author the entry and "
    "restore the link.",
)
