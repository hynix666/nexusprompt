"""Claims the source does not support, removed by exact substring edit.

Found by auditing all 38 added records against their papers' abstracts. Each
edit below is anchored on the exact text it replaces; if that text is not found,
:func:`apply_claim_corrections` raises rather than silently doing nothing —
a correction table that no-ops when the record drifts is worse than no table,
because it goes on reporting success.

The operation is *removal*, not rewriting. Where a claim is unsupported it comes
out; where the surrounding sentence would then describe a mechanism the paper
does not have, that is recorded here as a note and left for a human, because
choosing what a record should say instead is editorial work. Two exceptions are
marked ``REWRITTEN`` inline: cases where deleting the unsupported text would
have left the record asserting the wrong mechanism with nothing in its place,
which is a worse failure than either the original or a sourced replacement.

Every ``warrant`` quotes or paraphrases what the abstract actually says, so the
edit can be checked against the source rather than taken on trust.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

__all__ = ["ClaimEdit", "CLAIM_CORRECTIONS", "UNRESOLVED_CLAIM_NOTES"]


@dataclass(frozen=True, slots=True)
class ClaimEdit:
    """One exact-substring edit to one field of one record."""

    field: str
    old: str
    new: str
    warrant: str


CLAIM_CORRECTIONS: Final[dict[str, tuple[ClaimEdit, ...]]] = {
    "branch-solve-merge": (
        ClaimEdit(
            field="description",
            old="evaluating each sub-criterion separately with shuffled ordering",
            new="evaluating each sub-criterion separately",
            warrant=(
                "arXiv 2310.15123 describes branch, solve and merge modules that "
                "decompose a task into parallel sub-tasks, solve them "
                "independently and fuse the results. Shuffled ordering is not "
                "part of the method as described."
            ),
        ),
    ),
    "thought-propagation": (
        ClaimEdit(
            field="executive_summary",
            old=" Achieves 12-15% gains over direct CoT.",
            new="",
            warrant=(
                "arXiv 2310.03965 reports improvements across several tasks that "
                "range below the stated band. A range that excludes the paper's "
                "own weaker result reads as selective."
            ),
        ),
    ),
    "sglang": (
        ClaimEdit(
            field="description",
            old=(
                "The runtime uses RadixAttention — a technique that caches and "
                "reuses attention KV caches across multiple structured "
                "generation requests — to achieve significantly higher "
                "throughput than naive constrained decoding. It also supports "
                "fork/join patterns for parallel generation and speculative "
                "execution."
            ),
            new=(
                "The runtime combines two optimizations: RadixAttention, which "
                "reuses KV cache across calls, and a compressed finite state "
                "machine that speeds up structured-output decoding. It also "
                "supports fork/join patterns for parallel generation."
            ),
            warrant=(
                "REWRITTEN. arXiv 2312.07104 attributes structured-output speed "
                "to the compressed finite state machine and cache reuse to "
                "RadixAttention; the record credited one mechanism with the "
                "other's effect and omitted the FSM entirely. Speculative "
                "execution is not claimed in the abstract."
            ),
        ),
        ClaimEdit(
            field="executive_summary",
            old="Structured generation DSL with RadixAttention for efficient constrained decoding.",
            new="Structured generation DSL with a runtime that reuses KV cache and compiles output constraints to a compressed finite state machine.",
            warrant="Same attribution error in the summary.",
        ),
    ),
    "spotlighting-hines": (
        ClaimEdit(
            field="executive_summary",
            old="delimits, marks, or encodes untrusted user input",
            new="delimits, marks, or encodes untrusted third-party content",
            warrant=(
                "arXiv 2403.14720 addresses *indirect* prompt injection: the "
                "user issues the commands and is the trusted party; the "
                "untrusted material is data processed alongside them. Naming "
                "the user as the untrusted party inverts the threat model."
            ),
        ),
        ClaimEdit(
            field="description",
            old=(
                "Spotlighting transforms untrusted user input before it reaches "
                "the LLM by adding explicit delimiters, visual markers, or "
                "encoding that makes the boundary between trusted instructions "
                "and untrusted input unmistakable. The model is instructed to "
                "treat content within the marked boundaries as user input, not "
                "as instructions."
            ),
            new=(
                "Spotlighting transforms untrusted third-party content — "
                "retrieved documents, tool output, anything the user did not "
                "type — before it reaches the LLM, by adding explicit "
                "delimiters, datamarking, or encoding that makes the boundary "
                "between the user's instructions and that content "
                "unmistakable. The model is instructed to treat content within "
                "the marked boundaries as data, not as instructions."
            ),
            warrant="Same inversion, plus 'datamarking' is the paper's own term.",
        ),
    ),
    "codet": (
        ClaimEdit(
            field="description",
            old=(
                "CodeT generates N candidate solutions to a programming problem, "
                "then filters them through a two-stage pipeline: (1) compilation "
                "filtering — discard candidates that fail to compile, and (2) "
                "test execution filtering — run candidate code against test "
                "cases and select the solution that passes the most tests. This "
                "ensemble approach significantly improves functional correctness "
                "over single-sample code generation."
            ),
            new=(
                "CodeT has the model generate both candidate solutions and test "
                "cases for the same problem, removing the need for hand-written "
                "tests. Solutions are then executed against those generated "
                "tests and scored by dual execution agreement: a solution is "
                "trusted when it agrees with other solutions on the tests they "
                "pass, so consensus across the sampled pairs — not a single test "
                "suite — does the selecting. This significantly improves "
                "functional correctness over single-sample code generation."
            ),
            warrant=(
                "REWRITTEN. arXiv 2207.10397 makes automatic test generation the "
                "contribution and dual execution agreement the selection rule. "
                "The record described neither, and instead named a compilation "
                "filter and a most-tests-passed rule that are not in the paper."
            ),
        ),
        ClaimEdit(
            field="executive_summary",
            old="Generates multiple code candidates, filters by compilation, and selects based on test case execution.",
            new="Has the model generate both candidate solutions and test cases, then selects by execution agreement across them.",
            warrant="Same mechanism error in the summary.",
        ),
    ),
    "highlighted-chain-of-thought": (
        ClaimEdit(
            field="executive_summary",
            old=", eliminating intermediate hallucinations in long multi-hop retrieval tasks and improving human verification speed",
            new=", making the facts a response rests on visible for verification",
            warrant=(
                "arXiv 2503.02003 reports improved accuracy across arithmetic, "
                "QA and logical reasoning, not the elimination of hallucination, "
                "and the evaluation is not on long multi-hop retrieval."
            ),
        ),
    ),
    "confidence-informed-self-consistency": (
        ClaimEdit(
            field="executive_summary",
            old="achieving equal or higher accuracy with up to 53% fewer sampled paths",
            new="achieving comparable accuracy with a significantly smaller sample size",
            warrant=(
                "arXiv 2502.06233 states up to 40% fewer samples. A figure above "
                "the paper's own is an overclaim; the qualitative form is what "
                "the abstract supports."
            ),
        ),
    ),
    "medprompt-framework": (
        ClaimEdit(
            field="executive_summary",
            old="chain-of-thought reasoning, and self-consistency voting. Achieves 90.2% on MedQA",
            new="chain-of-thought reasoning, and choice-shuffling ensembling. Achieves ~90% on MedQA",
            warrant=(
                "Nori et al. (arXiv 2311.16452) use choice-shuffling ensembling, "
                "which counters position bias over answer options and is not "
                "plain self-consistency. The abstract states 90%; the extra "
                "decimal is not sourced from it."
            ),
        ),
        ClaimEdit(
            field="description",
            old="(3) self-consistency ensemble voting across multiple generated answers",
            new="(3) choice-shuffling ensembling, which re-runs the question with the answer options permuted and votes across the runs",
            warrant="Same substitution in the description.",
        ),
    ),
    "verify-and-edit": (
        ClaimEdit(
            field="description",
            old=(
                "(1) Verification — each claim in the generated output is checked "
                "against an external knowledge source (retrieval, database, or "
                "search)"
            ),
            new=(
                "(1) Verification — reasoning chains whose answers the model is "
                "uncertain about are checked against an external knowledge "
                "source (retrieval, database, or search)"
            ),
            warrant=(
                "arXiv 2305.03268 post-edits chain-of-thought rationales in "
                "instances selected by consistency-based uncertainty, not every "
                "claim in every output."
            ),
        ),
    ),
    "cache-optimized-context-engineering": (
        ClaimEdit(
            field="executive_summary",
            old="reducing latency up to 85% and token cost up to 90%",
            new="reducing latency and token cost substantially, per the providers' own published figures",
            warrant=(
                "The record has no arXiv source; the percentages are vendor "
                "documentation claims. Stating them flat presents a vendor "
                "figure as an independent finding."
            ),
        ),
    ),
}


#: Problems found by the audit that an edit cannot settle. Recorded rather than
#: guessed at, because choosing what a record should say instead is editorial.
UNRESOLVED_CLAIM_NOTES: Final[dict[str, str]] = {
    "branch-solve-merge": (
        "The record frames BSM purely as an evaluation-bias technique. arXiv "
        "2310.15123 applies it to two tasks: LLM response evaluation *and* "
        "constrained text generation. Restoring the second is an addition, not "
        "a deletion, so it is left for a human to write."
    ),
    "chain-of-draft": (
        "The '90% token reduction' claim is conservative rather than wrong: the "
        "paper reports usage as low as 7.6% of Chain-of-Thought's tokens. Worth "
        "replacing with the precise figure."
    ),
    "buffer-of-thoughts": (
        "The '~88% cost reduction' figure is derived, not stated: the abstract "
        "says the method needs 12% of the cost of multi-query prompting. "
        "Correct arithmetic, but a reader cannot check it against the source."
    ),
}
