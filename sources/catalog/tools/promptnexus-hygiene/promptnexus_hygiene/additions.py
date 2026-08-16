"""Entries authored to close cross-references that pointed at nothing.

Entries authored where a reference resolved to nothing and the technique behind
it is real and identifiable. Every ``primary_source`` below was verified against
the arXiv abstract page and the publisher record.

Two of these were added after the v1.19.0-FINAL release shipped its own records
for the same ids: ``grammar-constrained-decoding`` (the release correctly picked
Geng et al. 2023, a different paper from the efficiency analysis already in the
catalog) and ``knowledge-graph-enhanced-prompting``. The bodies here replace the
stubs that shipped; the ids, names and categories the release chose are kept.

``knowledge-graph-enhanced-prompting`` remains a naming compromise: the id names
a pattern while the source names one system (KnowGPT). The body says so
explicitly rather than pretending the two are the same scope.

These live in code only until they are ported into
``data/prompt_technique_catalog.json``, which remains the source of truth.
"""

from __future__ import annotations

from typing import Final

from .model import SourceRef, Technique, Template, Variable
from .schema import SCHEMA_VERSION

__all__ = ["NEW_ENTRIES", "ADDITION_RATIONALE"]


ADDITION_RATIONALE: Final[str] = (
    "Referenced by an existing entry but absent from the catalog; the technique "
    "is real and identifiable, so the citation is honoured rather than deleted."
)


CHAIN_OF_SYMBOL = Technique(
    id="chain-of-symbol",
    name="Chain-of-Symbol (CoS) Prompting",
    category="reasoning-elicitation",
    subcategory="symbolic-intermediate-representation",
    executive_summary=(
        "Replace the natural-language description of a spatial environment in "
        "the reasoning chain with condensed symbols, so the model reasons over "
        "a compact symbolic state instead of prose."
    ),
    description=(
        "Chain-of-Thought describes intermediate state in natural language, "
        "which is verbose and, for spatial or relational problems, ambiguous. "
        "CoS keeps the chained-reasoning structure but represents the "
        "environment with a fixed symbolic vocabulary -- objects, positions and "
        "relations rendered as tokens rather than sentences. On planning tasks "
        "that require tracking a virtual spatial layout, this both shortens the "
        "prompt and removes the paraphrase noise that causes the model to lose "
        "track of the state. The gain is largest where the state is structured "
        "and the prose encoding of it is redundant."
    ),
    verification_status="verifier-checkable",
    cost_profile="single-call",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("CoS", "Chain of Symbol"),
    when_to_use=(
        "The task carries a structured state -- spatial layout, graph, board "
        "position -- that prose re-describes at every step.",
        "Prompt length is a constraint and the natural-language state encoding "
        "dominates the token budget.",
        "Chain-of-Thought traces show the model losing track of relations "
        "between entities across steps.",
    ),
    when_not_to_use=(
        "The task state is genuinely narrative and has no compact symbolic form.",
        "The reasoning trace must be read by a human who does not know the "
        "symbol vocabulary.",
        "The model is small enough that it cannot hold an ad-hoc symbol "
        "convention consistently across a long chain.",
    ),
    known_pitfalls=(
        "The symbol vocabulary has to be defined in the prompt and used "
        "consistently; a drifting convention is worse than prose.",
        "Gains are concentrated in spatial and relational tasks and do not "
        "transfer automatically to arithmetic or commonsense reasoning.",
        "Compressed traces are harder to audit when the answer is wrong.",
    ),
    related_techniques=(
        "chain-of-thought",
        "chain-of-code",
        "chain-of-draft",
        "plan-and-solve-prompting",
    ),
    tags=("reasoning", "spatial", "symbolic", "token-efficiency"),
    primary_source=SourceRef(
        authors="Hu, Lu, Zhang, Song, Lam, Zhang",
        year="2023",
        title="Chain-of-Symbol Prompting Elicits Planning in Large Langauge Models",
        venue="arXiv",
        arxiv_id="2305.10276",
        url="https://arxiv.org/abs/2305.10276",
    ),
    usage_templates=(
        Template(
            template_name="Symbolic state chain",
            template=(
                "Represent the environment using only these symbols: "
                "{{symbol_legend}}\n\n"
                "Environment:\n{{environment_description}}\n\n"
                "Task: {{task_question}}\n\n"
                "Think step by step. At each step, restate the environment in "
                "symbolic form only -- no prose descriptions of positions. "
                "Give the final answer on the last line."
            ),
            template_id="chain-of-symbol--symbolic-state-chain",
            determinism="deterministic-at-temperature-zero",
            reproducibility_note=(
                "A single LLM call with a fixed symbol legend. Output varies "
                "with the legend chosen; fix the legend to reproduce."
            ),
            variables=(
                Variable(
                    name="symbol_legend",
                    description="The symbol vocabulary and what each token denotes.",
                    example="/ = on top of, | = beside, # = blocked cell",
                ),
                Variable(
                    name="environment_description",
                    description="The initial state, in prose or already symbolic.",
                    example="Brick A is on brick B; brick C is beside brick B.",
                ),
                Variable(
                    name="task_question",
                    description="The planning or reasoning question to answer.",
                    example="In what order can the bricks be removed?",
                ),
            ),
        ),
    ),
)


KNN_PROMPTING = Technique(
    id="knn-prompting",
    name="kNN Prompting",
    category="example-selection-formatting",
    subcategory="retrieval-based-example-selection",
    executive_summary=(
        "Query the model once per training example to obtain distributed "
        "representations, then classify a test instance by nearest-neighbour "
        "lookup over those representations instead of stuffing demonstrations "
        "into the context."
    ),
    description=(
        "In-context learning cannot scale past the context window, and it needs "
        "calibration to counter position and label bias. kNN Prompting sidesteps "
        "both: the LLM's output distribution over each training instance becomes "
        "that instance's representation, and prediction is a nearest-neighbour "
        "vote among stored representations. Because the model's distribution is "
        "used to align test and training instances rather than to emit a label "
        "directly, no calibration step is required, and the method keeps "
        "improving as training data grows well beyond what would fit in a prompt."
    ),
    verification_status="verifier-checkable",
    cost_profile="multi-call-fixed",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("kNN Prompting", "kNN-Prompting"),
    when_to_use=(
        "You have far more labelled examples than fit in the context window.",
        "The task is classification and in-context learning is visibly "
        "miscalibrated across label choices or example orderings.",
        "One-off indexing cost is acceptable in exchange for cheaper, steadier "
        "inference.",
    ),
    when_not_to_use=(
        "The task is open-ended generation rather than classification.",
        "You cannot afford one model call per training instance to build the "
        "datastore.",
        "Labelled data is scarce enough that ordinary few-shot prompting "
        "already covers it.",
    ),
    known_pitfalls=(
        "The datastore must be rebuilt when the underlying model changes; "
        "representations are model-specific.",
        "Retrieval quality bounds accuracy -- a noisy or unbalanced datastore "
        "propagates straight into predictions.",
        "Storage and lookup cost grow with the training set.",
    ),
    related_techniques=(
        "few-shot-prompting",
        "what-makes-good-in-context-examples",
        "retrieval-augmented-generation",
    ),
    tags=("example-selection", "retrieval", "classification", "calibration-free"),
    primary_source=SourceRef(
        authors="Xu, Wang, Mao, Lyu, She, Zhang",
        year="2023",
        title=(
            "kNN Prompting: Beyond-Context Learning with Calibration-Free "
            "Nearest Neighbor Inference"
        ),
        venue="ICLR 2023",
        arxiv_id="2303.13824",
        url="https://arxiv.org/abs/2303.13824",
    ),
    usage_templates=(
        Template(
            template_name="Datastore probe prompt",
            template=(
                "{{task_instruction}}\n\n"
                "Input: {{instance_text}}\n"
                "Label:"
            ),
            template_id="knn-prompting--datastore-probe",
            determinism="requires-external-system",
            reproducibility_note=(
                "The prompt itself is a single deterministic call, but the "
                "prediction depends on an external datastore of cached "
                "representations and a nearest-neighbour index."
            ),
            variables=(
                Variable(
                    name="task_instruction",
                    description="The task framing, identical for every probe.",
                    example="Classify the sentiment of the review.",
                ),
                Variable(
                    name="instance_text",
                    description="A training or test instance to encode.",
                    example="The plot dragged but the acting saved it.",
                ),
            ),
        ),
    ),
)


QUERY2DOC = Technique(
    id="query2doc",
    name="Query2doc",
    category="retrieval-augmentation",
    subcategory="query-expansion",
    executive_summary=(
        "Few-shot prompt an LLM to write a pseudo-document answering the query, "
        "then append that pseudo-document to the query before retrieval."
    ),
    description=(
        "Short queries are poor retrieval keys: they under-specify intent and "
        "share few terms with relevant passages. Query2doc has the model "
        "generate a plausible answer document from parametric knowledge and "
        "concatenates it with the original query, widening lexical overlap for "
        "sparse retrievers and sharpening the embedding for dense ones. The "
        "pseudo-document does not need to be factually correct -- it needs to "
        "carry the vocabulary and framing of the documents that would answer "
        "the query. No retriever fine-tuning is involved."
    ),
    verification_status="verifier-checkable",
    cost_profile="multi-call-fixed",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("query2doc", "Query Expansion with LLMs"),
    when_to_use=(
        "Queries are short or ambiguous and recall is the binding constraint.",
        "You run BM25 or another sparse retriever that depends on term overlap.",
        "You cannot fine-tune the retriever but can afford one extra generation "
        "per query.",
    ),
    when_not_to_use=(
        "Query latency budget does not allow a generation step before retrieval.",
        "The corpus is in a domain the model knows nothing about, so the "
        "pseudo-document adds noise instead of vocabulary.",
        "Queries are already long, well-specified documents.",
    ),
    known_pitfalls=(
        "A hallucinated pseudo-document can drag retrieval toward the wrong "
        "topic; weighting the original query terms higher mitigates this.",
        "Gains shrink for strong dense retrievers already trained in-domain.",
        "Adds one model call to every query, which dominates cost at scale.",
    ),
    related_techniques=(
        "hyde",
        "retrieval-augmented-generation",
        "few-shot-prompting",
    ),
    tags=("retrieval", "query-expansion", "sparse-retrieval", "pseudo-document"),
    primary_source=SourceRef(
        authors="Wang, Yang, Wei",
        year="2023",
        title="Query2doc: Query Expansion with Large Language Models",
        venue="EMNLP 2023",
        arxiv_id="2303.07678",
        url="https://arxiv.org/abs/2303.07678",
    ),
    usage_templates=(
        Template(
            template_name="Few-shot pseudo-document expansion",
            template=(
                "Write a passage that answers the given query.\n\n"
                "{{few_shot_examples}}\n\n"
                "Query: {{query}}\n"
                "Passage:"
            ),
            template_id="query2doc--few-shot-expansion",
            determinism="deterministic-at-temperature-zero",
            reproducibility_note=(
                "One LLM call per query. The retrieval step that consumes the "
                "expanded query is external and deterministic given a fixed index."
            ),
            variables=(
                Variable(
                    name="few_shot_examples",
                    description="Four to eight query/passage exemplars from the domain.",
                    example="Query: how tall is Everest\nPassage: Mount Everest rises 8,849 m ...",
                ),
                Variable(
                    name="query",
                    description="The user query to expand.",
                    example="side effects of ibuprofen",
                ),
            ),
        ),
    ),
)


SELF_EDIT_CODE = Technique(
    id="self-edit-code",
    name="Self-Edit (Fault-Aware Code Editor)",
    category="self-verification-refinement",
    subcategory="execution-feedback-repair",
    executive_summary=(
        "Run the generated program on the example test case, wrap the execution "
        "result into a comment, and have a fault-aware editor pass rewrite the "
        "code using that comment as guidance."
    ),
    description=(
        "Generate-and-edit rather than generate-and-resample. The first pass "
        "produces a candidate program; the candidate is executed against the "
        "test case supplied with the problem; the observed outcome -- passed, "
        "wrong answer, or the actual error message -- is appended as a "
        "supplementary comment; and an editing pass repairs the code with that "
        "evidence in hand. Because the feedback is an execution result rather "
        "than the model's own opinion of its output, the repair signal is "
        "grounded, which is what separates this from unguided self-critique."
    ),
    verification_status="verifier-checkable",
    cost_profile="multi-call-fixed",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("Self-Edit", "Fault-Aware Code Editor"),
    when_to_use=(
        "The task is code generation and at least one executable test case ships "
        "with the problem.",
        "Sampling many candidates is too expensive and you want to improve "
        "pass@1 instead of pass@k.",
        "A sandbox is available to execute untrusted generated code safely.",
    ),
    when_not_to_use=(
        "No test case or executable specification exists, leaving nothing to "
        "generate grounded feedback from.",
        "Execution is unsafe or unavailable in the deployment environment.",
        "The example test is so weak that passing it says nothing about "
        "correctness.",
    ),
    known_pitfalls=(
        "Overfitting to the single example test: code can be edited until it "
        "passes that case while remaining wrong in general.",
        "Executing model-generated code requires a sandbox; running it "
        "unguarded is a security hole.",
        "Repeated edit rounds show diminishing returns and can oscillate "
        "between two broken variants.",
    ),
    related_techniques=(
        "self-refine",
        "codet",
        "structured-cot-code-generation",
        "chain-of-code",
    ),
    tags=("code-generation", "execution-feedback", "self-correction", "repair"),
    primary_source=SourceRef(
        authors="Zhang, Li, Li, Li, Jin",
        year="2023",
        title="Self-Edit: Fault-Aware Code Editor for Code Generation",
        venue="ACL 2023",
        arxiv_id="2305.04087",
        url="https://arxiv.org/abs/2305.04087",
    ),
    usage_templates=(
        Template(
            template_name="Execution-annotated edit pass",
            template=(
                "Problem:\n{{problem_statement}}\n\n"
                "Candidate solution:\n{{generated_code}}\n\n"
                "# Execution on the example test case:\n"
                "# {{execution_result}}\n\n"
                "Rewrite the solution so that it is correct. Return only the "
                "corrected code."
            ),
            template_id="self-edit-code--execution-annotated-edit",
            determinism="requires-external-system",
            reproducibility_note=(
                "Requires a sandboxed execution step between the generation and "
                "edit calls; the edit call itself is deterministic at "
                "temperature zero given a fixed execution result."
            ),
            variables=(
                Variable(
                    name="problem_statement",
                    description="The original problem description and its example test.",
                    example="Given a list of integers, return the two indices that sum to the target.",
                ),
                Variable(
                    name="generated_code",
                    description="The first-pass candidate program.",
                    example="def two_sum(nums, target): ...",
                ),
                Variable(
                    name="execution_result",
                    description=(
                        "Verbatim outcome of running the candidate: passed, the "
                        "wrong output, or the interpreter error."
                    ),
                    example="IndexError: list index out of range",
                ),
            ),
        ),
    ),
)


GRAMMAR_CONSTRAINED_DECODING = Technique(
    id="grammar-constrained-decoding",
    name="Grammar-Constrained Decoding (GCD)",
    category="structured-constrained-output",
    subcategory="decode-time-constraint",
    executive_summary=(
        "Restrict the decoder at each step to tokens a formal grammar permits, "
        "so a general-purpose model emits structurally valid output without "
        "being fine-tuned for the format."
    ),
    description=(
        "Prompting a model to 'respond in JSON' asks it to respect a structure "
        "it can still violate. Grammar-constrained decoding removes the "
        "possibility: a grammar over the output language is compiled into an "
        "incremental parser, and at every decoding step the token distribution "
        "is masked to the continuations that keep a valid parse reachable. "
        "Validity becomes a property of the decoder rather than of the model's "
        "compliance, which lets an unmodified LLM emit parse trees, entity "
        "links or structured records that downstream code can consume without "
        "a repair pass. The cost is that the grammar must exist and the "
        "serving stack must support masking."
    ),
    verification_status="verifier-checkable",
    cost_profile="single-call",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("GCD", "Grammar Constrained Generation"),
    when_to_use=(
        "Output must satisfy a formal structure that downstream code parses.",
        "You cannot fine-tune, but you control the decoding stack.",
        "Retry-on-parse-failure loops are costing more than the constraint "
        "machinery would.",
    ),
    when_not_to_use=(
        "The output format is prose, or too loose to express as a grammar.",
        "You call the model through an API that exposes no logit access or "
        "constraint interface.",
        "Constraint checking per token would dominate latency on a long output.",
    ),
    known_pitfalls=(
        "A grammar guarantees syntactic validity, never semantic correctness: "
        "well-formed nonsense still parses.",
        "Over-tight grammars can push probability mass onto degenerate "
        "completions the model would not otherwise produce.",
        "Incremental parsing adds per-token overhead that grows with grammar "
        "complexity.",
    ),
    related_techniques=(
        "lmql",
        "sglang",
        "xgrammar-structured-generation-engine",
        "grammar-constrained-decoding-efficiency",
    ),
    tags=("structured-output", "decoding", "grammar", "constraint"),
    primary_source=SourceRef(
        authors="Geng, Josifoski, Peyrard, West",
        year="2023",
        title=(
            "Grammar-Constrained Decoding for Structured NLP Tasks without "
            "Finetuning"
        ),
        venue="EMNLP 2023",
        arxiv_id="2305.13971",
        url="https://arxiv.org/abs/2305.13971",
    ),
    usage_templates=(
        Template(
            template_name="Grammar-masked generation",
            template=(
                "Task: {{task}}\n\n"
                "Produce output that conforms to the following grammar. Emit "
                "nothing outside it.\n\n"
                "Grammar:\n{{grammar}}\n\n"
                "Input:\n{{input_text}}\n\n"
                "Output:"
            ),
            template_id="grammar-constrained-decoding--grammar-masked-generation",
            determinism="requires-external-system",
            reproducibility_note=(
                "The prompt alone does not constrain anything; reproducibility "
                "depends on the decoder enforcing the grammar. Fix the grammar "
                "and the constraint library version to reproduce."
            ),
            variables=(
                Variable(
                    name="task",
                    description="What the model should produce.",
                    example="Extract the entities and link them to Wikidata ids.",
                ),
                Variable(
                    name="grammar",
                    description="The grammar the decoder enforces, in the engine's syntax.",
                    example="root ::= \"{\" pair (\",\" pair)* \"}\"",
                ),
                Variable(
                    name="input_text",
                    description="The content to transform.",
                    example="Ada Lovelace worked with Charles Babbage.",
                ),
            ),
        ),
    ),
)


KNOWLEDGE_GRAPH_ENHANCED_PROMPTING = Technique(
    id="knowledge-graph-enhanced-prompting",
    name="Knowledge-Graph-Enhanced Prompting",
    category="retrieval-augmentation",
    subcategory="structured-knowledge-grounding",
    executive_summary=(
        "Extract query-relevant facts or paths from a knowledge graph and "
        "render them into the prompt, grounding the answer in curated "
        "relations rather than in retrieved prose."
    ),
    description=(
        "Text retrieval returns passages; a knowledge graph returns relations. "
        "For multi-hop questions the difference matters, because the path "
        "between two entities is exactly the evidence the answer needs and is "
        "rarely stated in any single passage. The pattern has two stages: "
        "select a subgraph -- triples, paths, or a neighbourhood around the "
        "query entities -- then serialise it into the prompt in a form the "
        "model can read. Both stages are where the difficulty lives: the "
        "search space over subgraphs is large, and the serialisation format "
        "materially changes accuracy. KnowGPT, the record's primary source, "
        "automates both for closed-source models that accept hard prompts only; "
        "the entry covers the broader pattern it instantiates."
    ),
    verification_status="judge-checkable",
    cost_profile="multi-call-fixed",
    status="verified-external",
    schema_version=SCHEMA_VERSION,
    aliases=("Knowledge Graph Prompting", "KG Prompting", "KnowGPT"),
    when_to_use=(
        "A curated knowledge graph covers the domain and is more trustworthy "
        "than the model's parametric knowledge.",
        "Questions are multi-hop and the answer depends on relations between "
        "entities rather than on any single passage.",
        "Answers must be attributable to specific facts for audit.",
    ),
    when_not_to_use=(
        "No knowledge graph exists for the domain, or maintaining one costs "
        "more than the grounding is worth.",
        "The question is open-ended or subjective, so there is no relevant "
        "subgraph to retrieve.",
        "The graph is stale or incomplete enough that grounding in it would be "
        "worse than not grounding at all.",
    ),
    known_pitfalls=(
        "Subgraph selection dominates quality: retrieve too much and the "
        "prompt drowns, too little and the answer is unsupported.",
        "Serialisation format is not neutral -- the same triples expressed "
        "differently change accuracy.",
        "Errors and gaps in the graph propagate into the answer wearing the "
        "authority of curated data.",
    ),
    related_techniques=(
        "graphrag",
        "retrieval-augmented-generation",
        "graph-of-thoughts",
    ),
    tags=("retrieval", "knowledge-graph", "grounding", "multi-hop"),
    primary_source=SourceRef(
        authors="Zhang, Dong, Chen, Zha, Yu, Huang",
        year="2024",
        title="KnowGPT: Knowledge Graph based Prompting for Large Language Models",
        venue="NeurIPS 2024",
        arxiv_id="2312.06185",
        url="https://arxiv.org/abs/2312.06185",
    ),
    usage_templates=(
        Template(
            template_name="Subgraph-grounded answer",
            template=(
                "Answer the question using only the facts below. If they are "
                "insufficient, say so rather than guessing.\n\n"
                "Facts from the knowledge graph:\n"
                "{{relevant_triples_or_paths}}\n\n"
                "Question: {{question}}\n\n"
                "Answer, citing the facts you used:"
            ),
            template_id="knowledge-graph-enhanced-prompting--subgraph-grounded-answer",
            determinism="requires-external-system",
            reproducibility_note=(
                "Requires a knowledge graph and a subgraph-selection step. Fix "
                "the graph snapshot and the selection policy to reproduce; the "
                "final call is deterministic at temperature zero given a fixed "
                "subgraph."
            ),
            variables=(
                Variable(
                    name="relevant_triples_or_paths",
                    description="The selected subgraph, serialised one relation per line.",
                    example="(Ada Lovelace, collaborated_with, Charles Babbage)",
                ),
                Variable(
                    name="question",
                    description="The question to answer from the subgraph.",
                    example="Who did Ada Lovelace work with on the Analytical Engine?",
                ),
            ),
        ),
    ),
)


#: Appended in this order at the end of the catalog, preserving the existing
#: insertion-ordered layout rather than resorting the file.
NEW_ENTRIES: Final[tuple[Technique, ...]] = (
    CHAIN_OF_SYMBOL,
    KNN_PROMPTING,
    QUERY2DOC,
    SELF_EDIT_CODE,
    GRAMMAR_CONSTRAINED_DECODING,
    KNOWLEDGE_GRAPH_ENHANCED_PROMPTING,
)
