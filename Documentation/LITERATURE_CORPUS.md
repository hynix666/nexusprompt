# Literature Corpus — what was checked, and what it establishes

A 44-file corpus of prompt-engineering papers (`Prompt Survey.zip`, 108 MB, added 17 August 2026) was read against this project. This page records what was **verified**, what was **filed by title only**, and what the corpus does **not** establish.

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

These are the first four of the catalog's 172 citations ever checked against the actual paper. **The other 168 remain unverified against their sources** — nothing in this corpus covers them.

The remaining 35 identified papers are cited nowhere in the catalog, primary or secondary.

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
- **Not that the catalog is complete.** *The Prompt Report* is the obvious instrument for that and has not been used; comparing its taxonomy against the 172 records is unstarted work, listed under Phase 4.
- **Not that the 168 unmatched citations are real.** Four were checked. The rest need either the papers or a network lookup, and this project does no network verification.
- **Nothing about the three image-only PDFs.** They have no extractable text; their identity rests on their filenames alone, which the "On Meta-Prompting" false positive above should discourage anyone from trusting.
