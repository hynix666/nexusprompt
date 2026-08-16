"""Records whose prose described a different technique than the one they cite.

Found by the content audit: for each record whose citation metadata turned out
to be fabricated, the description was compared against the paper's abstract.
Most held up. This one did not — it carried a real paper's citation over a
description of something else entirely, which is the most damaging failure mode
in a reference catalog, because every surface signal says the entry is sound.

Unlike :mod:`additions`, nothing here is a new technique. These replace the
body of an existing record, keeping its id, status and (already verified)
primary_source, so no cross-reference moves.

Each replacement states what the original claimed and what the paper actually
says, so a reviewer can check the rewrite against the source rather than
trusting it.
"""

from __future__ import annotations

from typing import Final

from .model import Technique, Template, Variable
from .schema import SCHEMA_VERSION

__all__ = ["CONTENT_REPLACEMENTS", "REPLACEMENT_NOTES"]


REPLACEMENT_NOTES: Final[dict[str, str]] = {
    "dera": (
        "The record described a generic Solver/Critic critique loop — solver "
        "proposes, critic finds flaws, repeat until approved — down to the "
        "subcategory (solver-critic-dialogue), the tags and the usage template. "
        "DERA has neither role. Nair et al. define a Researcher, who processes "
        "information and surfaces the crucial components of the problem, and a "
        "Decider, who holds the autonomy to integrate that information and "
        "decide the final output; the setting is safety-critical clinical text, "
        "where the criterion is factual accuracy and completeness rather than "
        "iterative approval. Rewritten from the paper's abstract (arXiv "
        "2303.17071); every claim below is traceable to it."
    ),
}


DERA = Technique(
    id="dera",
    name="DERA (Dialog-Enabled Resolving Agents)",
    category="agentic-tool-use",
    subcategory="researcher-decider-dialog",
    executive_summary=(
        "Split generation into two agent roles that hold a dialog: a Researcher "
        "that surfaces the crucial components of the problem, and a Decider "
        "that integrates them and owns the final output. Aimed at factual "
        "accuracy and completeness in safety-critical text."
    ),
    description=(
        "DERA frames output improvement as a conversation between two agent "
        "types rather than as a critique loop. The Researcher processes the "
        "available information and identifies the components of the problem "
        "that matter; the Decider has the autonomy to integrate what the "
        "Researcher surfaces and to make the judgment calls that fix the final "
        "output. The asymmetry is the point: one role widens the field of "
        "considerations, the other narrows it and remains accountable for what "
        "ships, which keeps the dialog from collapsing into two agents "
        "negotiating. Nair et al. evaluate it on three clinically-focused "
        "tasks, where the governing criterion is whether the output is "
        "factually accurate and complete rather than whether it is stylistically "
        "better; gains are reported in human evaluation of medical conversation "
        "summarization and care plan generation."
    ),
    verification_status="judge-checkable",
    cost_profile="multi-call-adaptive",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("DERA", "Dialog-Enabled Resolving Agents"),
    when_to_use=(
        "Output must be factually complete, and omissions matter as much as "
        "errors — clinical summaries, incident reports, compliance text.",
        "A single pass reliably misses considerations that a second reader "
        "would raise.",
        "Someone or something must remain accountable for the final text, so a "
        "symmetric multi-agent debate is the wrong shape.",
    ),
    when_not_to_use=(
        "The task has a checkable answer, where a verifier or test beats a "
        "second model's judgment.",
        "Latency or cost rules out a multi-turn dialog per output.",
        "The domain is one where neither agent has grounding, in which case the "
        "dialog compounds error rather than removing it.",
    ),
    known_pitfalls=(
        "The Decider inherits the Researcher's blind spots: anything neither "
        "role surfaces is invisible to the process.",
        "Role separation degrades if both agents share a prompt and a model "
        "without distinct instructions, collapsing into one voice agreeing "
        "with itself.",
        "Reported gains are strongest on human evaluation of completeness; "
        "automated metrics moved far less, so evaluate on what you actually "
        "care about.",
    ),
    related_techniques=(
        "self-refine",
        "chain-of-verification",
        "multi-agent-debate",
        "medprompt-framework",
    ),
    tags=("agent", "dialogue", "multi-agent", "factuality", "clinical"),
    primary_source=None,  # kept from the record being replaced (already verified)
    usage_templates=(
        Template(
            template_name="Researcher / Decider dialog",
            template=(
                "You are the RESEARCHER. Read the source material and the draft "
                "output. List the components of the problem that matter for "
                "correctness and completeness, and any information in the "
                "source that the draft has not used. Do not rewrite the "
                "output.\n\n"
                "Source material:\n{{source_material}}\n\n"
                "Draft output:\n{{draft_output}}\n\n"
                "---\n\n"
                "You are the DECIDER. You own the final text. Take the "
                "Researcher's list, decide which items belong in the output and "
                "which do not, and produce the corrected version. State briefly "
                "which items you rejected and why.\n\n"
                "Researcher's findings:\n{{researcher_findings}}"
            ),
            template_id="dera--researcher-decider-dialog",
            determinism="stochastic-by-design",
            reproducibility_note=(
                "Two or more model calls per output, with the Decider's input "
                "depending on the Researcher's turn. Fix both prompts, the "
                "model and the turn limit to reproduce; the dialog length "
                "varies with what the Researcher surfaces."
            ),
            variables=(
                Variable(
                    name="source_material",
                    description="The ground-truth material the output must reflect.",
                    example="Transcript of a patient consultation.",
                ),
                Variable(
                    name="draft_output",
                    description="The first-pass generation to be resolved.",
                    example="Draft visit summary.",
                ),
                Variable(
                    name="researcher_findings",
                    description="The Researcher turn's output, passed to the Decider.",
                    example="Medication change discussed at 04:12 is missing from the summary.",
                ),
            ),
        ),
    ),
)


#: Keyed by record id. The body replaces the record's; id, status, corpus_file
#: and primary_source are kept from the record being replaced.
CONTENT_REPLACEMENTS: Final[dict[str, Technique]] = {"dera": DERA}
