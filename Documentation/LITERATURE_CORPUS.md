# Literature Corpus — what was checked, and what it establishes

Two corpora of prompt-engineering papers were read against this project, both added 17 August 2026:

| Archive | Files | Distinct | With an arXiv id |
|---|---|---|---|
| `Prompt Survey.zip` (108 MB) | 44 | 43 — one exact duplicate | 39 |
| `Prompt.zip` (271 MB) | 123 | 123 — no duplicates | 113 (112 distinct ids) |
| **Combined** | 167 | | **149 distinct arXiv ids** |

This page records what was **verified**, what was **filed by title only**, and what the corpora do **not** establish.

It follows the convention of [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md): a claim gets recorded here only with the method that produced it.

## The corpus is not frozen into `sources/`

`sources/` holds prior artifacts this project ports from, hash-pinned so a port can be checked against the exact revision it came from. These are third-party published papers: nothing is ported from them, their canonical location is arXiv, and committing 108 MB of PDFs would multiply the repository's size more than twentyfold for no verifiable gain.

The SHA-256 prefixes below are recorded instead, so any later claim can be re-checked against the exact file. `npm run verify:sources` still tracks 420 files, unchanged.

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

## Verified: 39 catalog citations checked against the actual papers — two are wrong

The second corpus overlaps the catalog heavily. Matching on exact arXiv id, **39 of the 159 arXiv-cited records are held**, and each claimed title was compared against the text on the paper's own first page.

| Outcome | Count |
|---|---|
| Title on the paper matches the catalog | **37** |
| Title does **not** match | **2** |
| Paper not held by either corpus | 120 |

### The two defects

**`chain-of-symbol` — wrong title, and demonstrably hand-typed.**

```
catalog : Chain-of-Symbol Prompting Elicits Planning in Large Langauge Models
paper   : Chain-of-Symbol Prompting for Spatial Reasoning in Large Language Models
          arXiv:2305.10276v7, published at COLM 2024
```

Two things are wrong. The subtitle is from an obsolete version — v1 was *"…Elicits Planning…"* and the paper was retitled — so the record cites a title that no longer exists. And `Langauge` is misspelled, which no copy-paste from the source could produce.

**`prompt-matcher-schema-matching` — a title the paper never had.**

```
catalog : Prompt-Matcher: Uncertainty-Guided Schema Matching with LLM Prompting
paper   : Prompt-Matcher: Leveraging Large Models to Reduce Uncertainty in Schema Matching Results
          arXiv:2408.14507v3
```

Same identifier, same subject, a title that is a plausible paraphrase rather than the paper's own.

### Why `check:citations` could not have caught either

Both records pass every internal check, and correctly so: their `year`, `arxiv_id`, `url`, and `title` are mutually consistent. Nothing about a record can reveal that its title does not match the paper, because the paper is not in the record.

This is the same structure as [ADR-0007](./0007-permanent-differential-oracle.md)'s argument for the differential oracle. Internal consistency is a check that two things agree with each other; it is structurally blind to both being wrong together. Catching that needs an external oracle — there, an independently written linter; here, the papers themselves.

**The measured citation accuracy is 37 of 39, on the quarter of the arXiv-cited catalog that can currently be checked.** The other 120 are unexamined, and at this rate roughly six more defects should be expected among them. That is an estimate, not a finding.

Five further records were flagged by the automated pass and cleared on inspection — `instance-adaptive-zero-shot-cot`, `pair-black-box-jailbreak`, `reverse-prompt-engineering-genetic-inversion`, `gcg-adversarial-suffix-attack`, and `smoothllm-randomized-smoothing-defense`. All five are correct; the flags came from titles wrapping across lines in the extracted text, and from `SMOOTHLLM` being typeset in small caps.

## Verified: catalog coverage against The Prompt Report

*The Prompt Report: A Systematic Survey of Prompt Engineering Techniques* (arXiv 2406.06608v6, Schulhoff et al., 80 pages) was read — not merely identified. Its abstract claims **58 text-based LLM prompting techniques**, enumerated in Figure 2.2 across six categories. This is the only external instrument in the corpus capable of asking whether the catalog's 172 records are the *right* 172.

**57 of the 58 were recovered** from Figure 2.2 by text extraction. The missing one is a node the figure's layout did not survive extraction intact; the count is reported as 57 rather than rounded up to the paper's 58.

Each of the 57 was adjudicated against the catalog by id, name, alias, and then by full-text search of every record.

| Category | In the survey | Has a catalog record | Missing |
|---|---|---|---|
| Zero-Shot | 9 | 7 | 2 |
| Few-Shot / ICL | 9 | 3 | 6 |
| Thought Generation | 14 | 10 | 4 |
| **Ensembling** | **10** | **2** | **8** |
| Self-Criticism | 6 | 5 | 1 |
| Decomposition | 9 | 7 | 2 |
| **Total** | **57** | **34** | **23** |

### The gap is concentrated, not general

**Ensembling is the hole.** Of ten ensembling techniques the survey identifies, the catalog has two — `self-consistency` and `universal-self-consistency`. Absent: COSP, DENSE (Demonstration Ensembling), DiVeRSe, Max Mutual Information, Meta-CoT, MoRE, USP, and Prompt Paraphrasing. A catalog built to advise on prompt construction that omits eight of ten ways to ensemble prompts has a shape worth knowing about before Phase 4 imports it.

Second cluster: few-shot **exemplar and instruction selection** — SG-ICL, Vote-K, Prompt Mining, Exemplar Generation, and Instruction Selection have no record, though `knn-prompting` and `fantastically-ordered-prompts` do cover KNN selection and exemplar ordering.

The remaining absences are scattered: Style Prompting, SimToM, Tab-CoT, Memory-of-Thought, Uncertainty-Routed CoT, AutoDiCoT, ReverseCoT, Recursion-of-Thought, Metacognitive Prompting.

**The survey is not a superset.** The catalog's 172 records run far wider than the survey's 58 — jailbreak and injection defence, RAG, agents, structured output, evaluation. The finding is a specific missing cluster, not general thinness.

### Corrections made while adjudicating

Both directions of matcher error appeared, and both were caught by cross-checking rather than by inspection:

- Matching on normalised equality alone reported 22 covered. It missed `emotionprompt` for "Emotion Prompting" and `least-to-most-prompting` for "Least-to-Most" — suffix differences.
- Adding containment introduced a **false negative**: my rule required both strings to be ≥5 characters, so "KNN" (3) could never match `knn-prompting`. Full-text search over every record is what found it. "Exemplar Ordering" was recovered the same way, via `fantastically-ordered-prompts`.
- Five full-text hits were substring artifacts and are *not* coverage: "dense " inside `chain-of-density`, "usp" inside unrelated words, "paraphras" in records about adversarial defence, and "style prompt" mentioned in prose by two records that are about something else.

Two judgements are marked rather than counted as certain: **Self-Verification** is treated as covered by `backward-self-verification`, and **Few-Shot CoT** as subsumed by `chain-of-thought`, since Wei et al.'s original technique is few-shot CoT.

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
- **Not that the 120 unchecked citations are real.** 39 were checked and two were wrong. The rest need either the papers or a network lookup, and this project does no network verification.
- **Not that the 37 confirmed titles are the right *papers* for their techniques.** A citation can name the correct paper and still be the wrong source for the claim a record makes. Reading 172 papers against 172 descriptions is a different exercise and has not been done.
- **Nothing about the three image-only PDFs.** They have no extractable text; their identity rests on their filenames alone, which the "On Meta-Prompting" false positive above should discourage anyone from trusting.
