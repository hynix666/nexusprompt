# Literature Corpus — what was checked, and what it establishes

Two corpora of prompt-engineering papers were read against this project, both added 17 August 2026:

| Corpus | Files | Distinct | With an arXiv id |
|---|---|---|---|
| `Prompt Survey.zip` (108 MB) | 44 | 43 — one exact duplicate | 39 |
| `Prompt.zip` (271 MB) | 123 | 123 — no duplicates | 113 |
| `PDF/` (1.49 GB, four collections) | 528 | 508 — 20 duplicates | 490 |
| **Combined** | 695 | **673** | **486 distinct arXiv ids** |

`PDF/` splits into `PROMPT` (364), `RAG` (127), `Memory` (25) and `PoC` (12). None of its files is image-only — every one yielded page-1 text. It is `.gitignore`d for the reason given below.

This page records what was **verified**, what was **filed by title only**, and what the corpora do **not** establish.

It follows the convention of [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md): a claim gets recorded here only with the method that produced it.

## The corpora are not frozen into `sources/`

`sources/` holds prior artifacts this project ports from, hash-pinned so a port can be checked against the exact revision it came from. These are third-party published papers: nothing is ported from them, their canonical location is arXiv, and the three corpora together are **1.87 GB against a 6 MB tracked repository** — roughly 300 times its size, permanently in history.

SHA-256 is recorded for every file instead, so any claim here can be re-checked against the exact bytes. `*.zip` and `PDF/` are `.gitignore`d; `npm run verify:sources` still tracks 420 files, unchanged.

## Verified: how the corpus was identified

Titles were not trusted. `pdftotext` extracted the first two pages of each file; **39 of 44 carry an arXiv identifier stamped on page 1**, which is an exact key rather than a similarity guess.

| Fact | Method | Result |
|---|---|---|
| Distinct papers | SHA-256 over all 44 files | **43** — one exact byte-identical duplicate |
| The duplicate | identical digest `b85f03302e50` | `A Survey of Automatic Prompt Engineering An Optimization.pdf` and `Survey of Automatic Prompt Engineering An Optimization.pdf`, both arXiv 2502.11560 |
| arXiv id recoverable | page-1 text extraction | 39 of 44 |
| No id recoverable | — | 5, of which **3 are image-only PDFs with zero extractable text** |

### A correction worth recording

The first cross-reference matched titles with an asymmetric score — intersection over `min(|A|,|B|)` — and reported **18 matches**. Most were false. "On Meta-Prompting" scored a perfect 1.00 against Suzgun & Kalai's *"Meta-Prompting: Enhancing Language Models with Task-Agnostic Scaffolding"*, a different paper, because its only two scoring tokens both appear in the longer title. Every survey containing "large language models" matched *"Large Language Models as Optimizers"* at 0.75.

Switching to Jaccard (intersection over **union**) gave 4. Matching on arXiv id — an exact key, no similarity at all — gave the same 4. Two independent methods agreeing is the reason the number below is stated without hedging.

## Verified: four corpus papers are cited by the technique catalog

Matched on exact arXiv id, then the catalog's claimed title was compared against the title on the paper's own first page. **All four agree.**

| arXiv | Catalog technique | Title agrees with the paper |
|---|---|---|
| 2310.03714 | `dspy` | yes |
| 2312.13382 | `dspy-assertions` | yes |
| 2503.02003 | `highlighted-chain-of-thought` | yes |
| 2411.15100 | `xgrammar-structured-generation-engine` | yes |

These were the first four of the catalog's 172 citations ever checked against an actual paper. The second corpus raised that to 39 — see the verification section below.

The remaining 35 identified papers in this first corpus are cited nowhere in the catalog, primary or secondary.

## Verified: the catalog's citations are internally consistent

Prompted by the four above, all 172 records were audited — now standing, as `npm run check:citations`, inside `npm run verify`.

```
172 technique records, every citation internally consistent.
  159 cite an arXiv preprint (159 distinct ids, none reused for a different paper);
  13 cite a venue, report, or practitioner guide instead.
```

The load-bearing check is that an arXiv id encodes `YYMM`, so a record whose `year` predates the month in its own `arxiv_id` contradicts itself and one of the two fields must be wrong. Also checked: id format, month range, `url` containing its own id, no id reused for a differently-titled paper, and no missing author/year/title.

**Zero problems across all 172.** That is worth stating plainly because it runs against this repository's grain: `SOURCE_VERIFICATION.md` records ten wrong claims in the prose documentation, and the reflex here is to expect the data to be as unreliable. It is not. The catalog's citation metadata is the most disciplined artifact in the project.

This does **not** mean the citations are correct — an internally consistent citation can still point at the wrong paper, and confirming that needs the papers themselves. It means no record contradicts itself.

## Verified: all 159 arXiv citations, against arXiv itself

Every arXiv-cited record was checked against arXiv's own metadata via `export.arxiv.org/api/query`, batched forty at a time with the requested three-second pause.

| Outcome | Count |
|---|---|
| Identifier resolves on arXiv | **159 of 159** |
| Title matches arXiv exactly | **149** |
| Title differs | 10 |
| `year` earlier than the arXiv submission | 0 |

**Every identifier in the catalog is real.** Not one of the 159 is fabricated, mistyped into a different paper, or dead.

### A correction to the previous entry in this ledger

An earlier pass compared citations against the **PDFs** and reported `chain-of-symbol` as a defect, reasoning that its misspelled `Langauge` "no copy-paste from the source could produce". That was wrong, and the reasoning was backwards.

```
catalog       : Chain-of-Symbol Prompting Elicits Planning in Large Langauge Models
arXiv metadata: Chain-of-Symbol Prompting Elicits Planning in Large Langauge Models   ← identical
PDF of v7     : Chain-of-Symbol Prompting for Spatial Reasoning in Large Language Models
```

arXiv's record still carries the original title, typo included; the authors retitled the camera-ready PDF for COLM 2024 without updating the metadata. **The catalog copied arXiv faithfully — the typo is evidence of copy-paste, not of hand-typing.** The record is correct against the authority for what a preprint is called.

The lesson is about instrument choice, not about the catalog: a PDF is not the authority for its own citation, because a paper can be retitled while its record is not.

### The eight genuine title errors

Of the ten differences, one is cosmetic and one is stale-but-defensible:

- `knn-prompting` — arXiv renders `$k$NN Prompting`; the catalog stripped the LaTeX. Not a defect.
- `skeleton-of-thought` — the catalog's *"Large Language Models Can Do Parallel Decoding"* is the original title, matching its stated venue of ICLR 2024; arXiv now shows *"Prompting LLMs for Efficient Parallel Generation"*. Stale, not wrong.

The remaining eight are real:

| Technique | Catalog says | arXiv says |
|---|---|---|
| `prompt-matcher-schema-matching` | Prompt-Matcher: **Uncertainty-Guided Schema Matching with LLM Prompting** | Prompt-Matcher: **Leveraging Large Models to Reduce Uncertainty in Schema Matching Results** |
| `prompting-llms-recommender-systems` | **Prompting Large Language Models for** Recommender Systems… | **Tapping the Potential of Large Language Models as** Recommender Systems… |
| `soda-search-based-inversion` | GPT, But Backwards: **Search-Based Language Model Inversion** | GPT, But Backwards: **Exactly Inverting Language Model Outputs** |
| `modularization-of-thought-code-gen` | Modularization-of-Thought for Code Generation | **MoT:** Modularization-of-Thought **Prompting for Effective** Code Generation |
| `grammar-constrained-decoding-efficiency` | Structural Equivalence and Efficiency… | **Attention Meets Reachability:** Structural Equivalence and Efficiency… |
| `reliable-constrained-diffusion-decoding` | Reliable Constrained Decoding for Diffusion LLMs… | **Lookahead-then-Verify:** Reliable Constrained Decoding… |
| `adaptive-weighted-rejection-sampling` | Fast Controlled Generation **with** Adaptive… | Fast Controlled Generation **from Language Models with** Adaptive… |
| `hackaprompt-taxonomy` | …Through a Global **Prompt Hacking Competition** | …through a Global **Scale** Prompt Hacking Competition |

Three dropped a leading clause, three dropped or altered words, and two are paraphrases. **Measured accuracy: 151 of 159 defensible, 8 wrong — a 5% error rate**, now a count rather than an extrapolation.

**All eight are now corrected at the import boundary.** `sources/` stays frozen — it is the record of what was inherited, defects included — so the fixes live in `scripts/catalog-corrections.json`, each carrying its `from`, `to`, reason, and arXiv evidence, and are applied by `npm run import:catalog`. The import refuses if a frozen value no longer matches the `from` it expects, so a stale correction cannot apply silently. The two adjudicated non-defects, and `chain-of-symbol`, are deliberately left alone and pinned by test so a later reader does not "fix" them.

### Why no offline check could have found these

Every one of the eight passes `check:citations`, correctly: `year`, `arxiv_id`, `url`, and `title` are mutually consistent. Nothing inside a record can reveal that its title does not match the paper, because the paper is not in the record.

This is [ADR-0007](./0007-permanent-differential-oracle.md)'s argument in a second setting. Internal consistency checks that two things agree with each other and is structurally blind to both being wrong together; catching that needs an external oracle. There it was an independently written linter. Here it is arXiv.

### The 13 non-arXiv citations

Semantic Scholar rate-limited every request (HTTP 429, unkeyed endpoint). Crossref resolved exactly one:

- `prompt-chaining` → *PromptChainer*, CHI 2022 Extended Abstracts, **doi:10.1145/3491101.3519729** ✓

The other twelve did not resolve, and most legitimately cannot: two are practitioner guides, one a *Towards Data Science* post, one an OpenAI technical report. **They remain unverified — not disproven.**

That pass did surface something offline-checkable: **three records name `arXiv preprint` as their venue while supplying no `arxiv_id`**, which is a record contradicting itself. `check:citations` now catches that class, and because `sources/` is hash-frozen and the data cannot be corrected in place, the three are recorded in `scripts/catalog-known-defects.json` — an allowlist on the same terms as ADR-0007's: an entry without a reason fails, and an entry whose defect no longer occurs fails as stale, so the excuse cannot outlive the problem.

## Verified: catalog coverage against The Prompt Report

*The Prompt Report: A Systematic Survey of Prompt Engineering Techniques* (arXiv 2406.06608v6, Schulhoff et al., 80 pages) was read — not merely identified. Its abstract claims **58 text-based LLM prompting techniques**, enumerated in Figure 2.2 across six categories. This is the only external instrument in the corpus capable of asking whether the catalog's 172 records are the *right* 172.

**57 of the 58 were recovered** from Figure 2.2 by text extraction. The missing one is a node the figure's layout did not survive extraction intact; the count is reported as 57 rather than rounded up to the paper's 58.

Each of the 57 was adjudicated against the catalog by id, name, alias, and then by full-text search of every record.

| Category | In the survey | Had a record | Has one now |
|---|---|---|---|
| Zero-Shot | 9 | 7 | 7 |
| Few-Shot / ICL | 9 | 3 | 3 |
| Thought Generation | 14 | 10 | 10 |
| **Ensembling** | **10** | **2** | **10** |
| Self-Criticism | 6 | 5 | 5 |
| Decomposition | 9 | 7 | 7 |
| **Total** | **57** | **34** | **42** |

### The gap was concentrated, and is now closed

**Ensembling was the hole.** Of ten ensembling techniques the survey identifies, the catalog had two — `self-consistency` and `universal-self-consistency`. A catalog built to advise on prompt construction that omitted eight of ten ways to ensemble prompts had a shape worth knowing about.

**All eight now have records**, added at the import boundary via `scripts/catalog-additions.json`, taking the catalog from 172 to 180. Each citation was resolved against arXiv's own metadata rather than written from memory: the author-year attributions were read out of the survey's §2.2.4, searched on arXiv, and the returned title, authors, date and venue comment recorded as given.

| Technique | Record | arXiv | Venue as arXiv states it |
|---|---|---|---|
| COSP | `consistency-based-self-adaptive-prompting` | 2305.14106 | Findings of ACL 2023 |
| DENSE | `demonstration-ensembling` | 2308.08780 | ME-FoMo Workshop, ICLR 2023 |
| DiVeRSe | `diverse-step-aware-verifier` | 2206.02336 | *arXiv states none* |
| Max Mutual Information | `max-mutual-information-template-selection` | 2203.11364 | *arXiv states none* |
| Meta-CoT | `meta-reasoning-over-chains` | 2304.13007 | EMNLP 2023 |
| MoRE | `mixture-of-reasoning-experts` | 2305.14628 | Findings of EMNLP 2023 |
| USP | `universal-self-adaptive-prompting` | 2305.14926 | EMNLP 2023 |
| Prompt Paraphrasing | `prompt-paraphrasing` | 1911.12543 | TACL 2020 |

Two of the eight carry `venue: "arXiv preprint"` because arXiv records no venue for them. The survey's citation keys imply conference publications, but a citation key is not evidence, and inferring a venue from one is how the eight wrong titles got there in the first place.

**These records say so about themselves.** Their `source_audit.description` is `verified-against-abstract` rather than the catalog-wide `unverified`: each description was written from the paper's abstract and the survey's account of it. `pitfalls` stays `unverified`, because the pitfalls were not checked against the papers. A test pins that distinction so it does not get normalised away.

That value was originally written as `abstract-verified`, which exists in no schema, along with three invented `determinism` values. Both passed the JSON Schema, which typed those fields as free strings, and were caught only when the frozen XSD was read — see the note on XSD validation in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Worth recording as a small instance of the general pattern: a second, independently-written schema catches what the first one was never asked to check.

**One detail from the frozen catalog's own metadata deserves recording.** Its `source_note` states that as of v1.20.0 "every arXiv-backed primary_source has been resolved against the live arXiv API — authors, title and id are taken from the publisher record rather than transcribed", and that the pass "corrected five records citing an id that belonged to an unrelated paper". That is the same check performed here, and eight wrong titles survived it. The claim was not false — the ids are all real and all resolve, which is what that pass fixed — but title agreement is a different property from id validity, and asserting the one reads as having established the other.

Second cluster: few-shot **exemplar and instruction selection** — SG-ICL, Vote-K, Prompt Mining, Exemplar Generation, and Instruction Selection have no record, though `knn-prompting` and `fantastically-ordered-prompts` do cover KNN selection and exemplar ordering.

**Fifteen absences remain**, and they are scattered rather than clustered: five few-shot exemplar and instruction-selection methods (SG-ICL, Vote-K, Prompt Mining, Exemplar Generation, Instruction Selection), plus Style Prompting, SimToM, Tab-CoT, Memory-of-Thought, Uncertainty-Routed CoT, AutoDiCoT, ReverseCoT, Recursion-of-Thought, and Metacognitive Prompting. No single category is now missing most of itself, which was the property that made ensembling worth fixing first.

**The survey is not a superset.** The catalog's 172 records run far wider than the survey's 58 — jailbreak and injection defence, RAG, agents, structured output, evaluation. The finding is a specific missing cluster, not general thinness.

### Corrections made while adjudicating

Both directions of matcher error appeared, and both were caught by cross-checking rather than by inspection:

- Matching on normalised equality alone reported 22 covered. It missed `emotionprompt` for "Emotion Prompting" and `least-to-most-prompting` for "Least-to-Most" — suffix differences.
- Adding containment introduced a **false negative**: my rule required both strings to be ≥5 characters, so "KNN" (3) could never match `knn-prompting`. Full-text search over every record is what found it. "Exemplar Ordering" was recovered the same way, via `fantastically-ordered-prompts`.
- Five full-text hits were substring artifacts and are *not* coverage: "dense " inside `chain-of-density`, "usp" inside unrelated words, "paraphras" in records about adversarial defence, and "style prompt" mentioned in prose by two records that are about something else.

Two judgements are marked rather than counted as certain: **Self-Verification** is treated as covered by `backward-self-verification`, and **Few-Shot CoT** as subsumed by `chain-of-thought`, since Wei et al.'s original technique is few-shot CoT.

## Verified: the 15 remaining gaps cannot be closed from this corpus

The obvious hope for a 673-paper corpus is that it contains the primary sources for the fifteen techniques the catalog still lacks. **It does not — not one of them.**

Two independent keyword passes were run over every paper's filename and page-1 header, and every hit was read rather than counted. All of them are different papers:

| Gap technique | What the search matched | Verdict |
|---|---|---|
| SimToM | *Think Twice Before Trusting **Self-Detection*** | different paper; matched on "think twice" |
| ReverseCoT | *Reason from Future: Reverse Thought Chain* | different paper |
| Metacognitive Prompting | *MIRROR* (a benchmark), *CoT2-Meta* | neither is the technique's source |
| Memory-of-Thought | *eMoT: evolving Memory-of-Thought* | a successor, not the original |
| SG-ICL | *Think Before You Prune: Selective **Self-Generated** Calibration* | different paper |
| Recursion-of-Thought | *…Guarded (Co-)**recursi**on* — a RAG theory paper | different paper |

Vote-K, Prompt Mining, Instruction Selection, Tab-CoT, Style Prompting, Uncertainty-Routed CoT, AutoDiCoT, Exemplar Generation and Exemplar Selection returned nothing at all.

The reason is a date skew: the corpus is heavily 2025–2026, and the gap techniques are 2022–2023 originals. **A larger corpus is not automatically a more useful one**, and 1.49 GB that closes zero gaps is the demonstration.

## Verified: what the corpus does enable

**96 of the catalog's 167 arXiv-cited records are now physically held**, up from 39. That matters for the one audit still outstanding: every record's `known_pitfalls` and `when_not_to_use` are `unverified` against the source paper — the frozen catalog's own `source_note` says so plainly — and checking them needs the papers, not metadata.

| Category | Held / cited |
|---|---|
| reasoning-elicitation | 28 / 46 |
| agentic-tool-use | 13 / 21 |
| prompt-injection-defense | 13 / 21 |
| structured-constrained-output | 8 / 11 |
| automatic-prompt-optimization | 7 / 15 |
| retrieval-augmentation | 6 / 11 |
| example-selection-formatting | 5 / 13 |
| self-verification-refinement | 4 / 14 |
| everything else | 12 / 15 |

**390 corpus papers are cited nowhere in the catalog** — 248 from `PROMPT`, 94 from `RAG`, 20 from `Memory`, 9 from `PoC`. Two of those numbers are a coverage signal rather than noise:

- **`RAG`: 127 papers, 94 uncited, against a catalog holding 11 `retrieval-augmentation` records.** The catalog treats retrieval as one category among twelve; the corpus treats it as a field.
- **`Memory`: 25 papers, 20 uncited, and the catalog has no memory category at all.** Long-term memory in LLM systems is absent from the taxonomy, not merely thin.

Neither is a defect — the catalog is a *prompting-technique* catalog and both areas sit at its edge. But if the platform is to advise on retrieval or memory, this says the catalog is not currently the place that knowledge lives. That is a scope decision, not a gap to fill quietly.

## Filed by title only — contents not read

The following connections are **filing decisions, not findings**. Only page-1 headers were extracted; no paper's argument, method, or result was read. They record where a future reader should look, and nothing about whether the paper supports anything this project does.

| Project component | Papers that appear relevant, by title |
|---|---|
| `ADVERSARIAL_RESILIENCE` gate + adversarial corpus (Phase 2) | *A Survey of Attacks on LLMs* (2505.12567) · *Prompt Injection attack against LLM-integrated Applications* (2306.05499) · *PI-Hunter: Automated Red Teaming* (2606.12737) |
| `CLAIM_DISCIPLINE` and demo-mode honesty | *Toward Epistemic Stability… Industrial LLM Hallucination Reduction* (2603.10047) · *Discourse Structure… Detecting Hallucinated Chain-of-Thought* (image-only) |
| The `judge-checkable` verification tier (8 of 172 records) and the framework's "deterministic gates gate, judged gates advise" rule | *A Survey on LLM-as-a-Judge* (2411.15594) |
| `calibrate` stage (Phase 3) | *MIRROR: Metacognitive Calibration Benchmark* (2604.19809) · *Intent-based Prompt Calibration* (2402.03099) |
| Structured/constrained output | *XGrammar* (2411.15100, already cited) · *XML Prompting as Grammar-Constrained Interaction* (image-only) |
| The DSPy prototypes reviewed earlier in this project | *DSPy* (2310.03714) · *DSPy Assertions* (2312.13382) — both already cited by the catalog |
| Catalog coverage (Phase 4) | *The Prompt Report* (2406.06608) — a systematic survey whose taxonomy is the natural external check on whether 172 records is the right set |

## What this corpus does not establish

- **Not that any technique works.** No paper's results were read.
- **Not that the catalog is complete.** The coverage check above uses one survey. It found 23 named absences, but a technique absent from *The Prompt Report* and absent from the catalog is invisible to both.
- **Not that the coverage table is mechanically re-checkable.** It compares against a PDF that is not in this repository, so no script in `npm run verify` can re-derive it. It is a point-in-time finding with its method recorded, which is the most this repository's conventions can offer for a claim about an external document.
- **Not that the 151 defensible citations are the right *papers* for their techniques.** A citation can name the correct paper and still be the wrong source for the claim the record makes. Reading 172 papers against 172 descriptions is a different exercise and has not been done.
- **Nothing about the 12 unresolved non-arXiv citations.** Unverified is not disproven.
- **Not a standing guarantee.** The arXiv check ran once, over the network. `npm run verify` stays offline by design, so nothing re-runs it; if arXiv metadata changes, this page silently ages. The script is kept so it can be re-run deliberately.
- **Nothing about the three image-only PDFs.** They have no extractable text; their identity rests on their filenames alone, which the "On Meta-Prompting" false positive above should discourage anyone from trusting.
