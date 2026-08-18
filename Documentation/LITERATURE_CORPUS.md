# Literature Corpus — what was checked, and what it establishes

Three corpora of prompt-engineering papers were read against this project, added 17–18 August 2026. `PDF/` grew across several passes and was re-scanned each time; the totals below are current as of the last scan, and the per-section statistics elsewhere on this page state the snapshot they were computed against.

| Corpus | Files | Distinct | With an arXiv id |
|---|---|---|---|
| `Prompt Survey.zip` (108 MB) | 44 | 43 — one exact duplicate | 39 |
| `Prompt.zip` (271 MB) | 123 | 123 — no duplicates | 113 |
| `PDF/` (five collections plus a root drop) | 661 | — | — |
| **Combined** | 828 | **599 distinct by SHA-256** | **550 distinct arXiv ids** |

`PDF/` splits into `PROMPT`, `RAG`, `Memory`, `PoC`, `pipeline` and files at its root, and has grown across several passes — 661 PDFs at last count. None is image-only; every one yielded page-1 text. It is `.gitignore`d for the reason given below.

### `PDF/pipeline/` — the one collection that changed the design

Added last, and unlike the others it is not a technique corpus: 89 PDFs on pipelines, orchestration, failure attribution and judge reliability, **plus three CSV evidence tables with per-row source attribution and two formal drafts**. 57 of the 89 were new by hash; 32 were already held under another collection.

It is recorded separately because it is the only corpus so far that **changed the architecture rather than confirming it** — see sections 4 and 4a of [`PROMPT_ENGINEERING_ENVIRONMENT.md`](./PROMPT_ENGINEERING_ENVIRONMENT.md). Three findings did the work:

| Finding | Detail | Consequence |
|---|---|---|
| Chain depth is a cliff, not a decay | GPT-4o Mini: **100% at 4 steps, 0% at 5**. All seven models tested: **0% at 11–12 steps** | An 11-stage pipeline is viable only *because* each boundary carries a schema, a gate set and a persisted revision. Depth without per-stage validation is where the cliff lives |
| Architecture ranking inverts with load | Reflexive self-correction best at 1k docs/day (F1 0.943), **worst at 100k** (0.871) — correction loops truncated by queuing timeouts | Architecture is a Configuration parameter to be measured, not a decision made once |
| Held-out sets leak through the scorer | Sample disjointness is insufficient; the guarantee needs *both* H ⊥ O and s ⊥ O | `EvalRun` must carry scorer provenance, not only dataset version |

The two drafts also supply a **sizing requirement that no anchored-evaluation proposal elsewhere in the corpus states**: resolving a 2-percentage-point difference at 95% one-sided confidence needs ≈ 3,400 anchor items. That is in direct tension with ADR-0008's "golden set small enough to run offline in seconds", and the resolution — a small smoke set that gates every change, a large anchor that alone may certify a promotion — is recorded in the design doc.

The corpus grew by 44 files mid-analysis — **35 of them new by content**, the rest duplicates of papers already present. Statistics elsewhere on this page computed against the earlier 528-file snapshot are unaffected, and that was checked rather than assumed: of the 35, **none is cited by the catalog and none supplies one of the fifteen missing techniques**. What they did supply is four measurements that changed the architecture, recorded below.

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

**96 of the catalog's 167 arXiv-cited records are physically held**, up from 39; 550 distinct arXiv ids are held in total. The `pipeline` collection added none of them, being orthogonal to the catalog's citations by construction — it is about system structure rather than prompting techniques. That matters for the one audit still outstanding: every record's `known_pitfalls` and `when_not_to_use` are `unverified` against the source paper — the frozen catalog's own `source_note` says so plainly — and checking them needs the papers, not metadata.

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

## Verified: four results that changed the architecture

Five papers were read in depth rather than identified. Four of them carry measurements that [ADR-0008](./0008-evaluation-first-environment.md) is built on, and they are recorded here because each contradicts something a reasonable engineer would otherwise assume.

**Prompt improvements are not monotonic, and their sign depends on the model.** *The Prompting Inversion* evaluates a constrained rule-based prompt against standard CoT on GSM8K across three model generations: it wins on gpt-4o (97% vs 93%) and **loses on gpt-5** (94.00% vs 96.36%). The authors name the mechanism a "guardrail-to-handcuff" transition — constraints that prevent common-sense errors in mid-tier models induce hyper-literalism in stronger ones, producing rejection of reasonable inference and over-constrained incomplete answers. The conclusion is that optimal strategy must co-evolve with model capability, and that **more capable models want simpler prompts**.

**Generic prompt improvements can be severely negative.** *When Generic Prompt Improvements Hurt* measures five prompt conditions over 30-case suites on two local models. Stronger output-contract prompts improved strict extraction for both — but appending generic rules to the user prompt cut Qwen 2.5's RAG citation/content-compliance from **26/30 to 9/30**. Its framing is the one adopted in ADR-0008: a prompt change is a regression risk and belongs in a task-specific suite before deployment.

**A detector's sensitivity changes with the configuration it measures.** The *Cross-Provider Architectural Ablation* (6,912 API calls, three providers, two model generations, twelve configurations) reports that enforcing JSON output appeared to raise hallucination by 10.1 pp and 15.1 pp — and shows the gap is **largely a detection-format artifact**, because structured fields make out-of-inventory mentions easier to find. Under a recall-equalized detector the conclusion reverses. Its headline result is also worth keeping: grounding plus vocabulary constraints plus enforced JSON took non-compliance from 69–80% down to 4–13%, but **per-provider directions diverge** even where the cross-provider average is stable.

**A single comparison run is not a result.** The *block-regularized 5×2 cross-validated McNemar's test* exists because the conventional test's hold-out split "usually produces a highly varied estimation of the error rates", giving it low power. Repeated cross-validated comparison is the fix. It pairs with *Toward Epistemic Stability*'s practitioner protocol of 100 trials per condition.

Together these are why ADR-0008 makes measurement the primary subsystem rather than a testing concern, equalizes detectors before comparing, and requires a significance test before a difference counts as a finding.

## Verified: a systematic search closed the 15 remaining gaps

Run 18 August 2026 as five ordered steps, each with a stated success criterion. arXiv's
API was used wherever an exact key existed, because a title query that matches at
Jaccard 1.00 settles a question that web search only gestures at.

**Step 1 — the fifteen missing techniques. All fifteen resolved, every match exact.**

They reduce to thirteen distinct papers: three papers each cover a parent/child pair in
the survey's taxonomy, and AutoDiCoT has no external source because it is introduced in
The Prompt Report's own case study. `scripts/catalog-gap-sources.json` carries the full
table with authors, venues and dates as arXiv states them.

| Technique | arXiv | Venue as arXiv states it |
|---|---|---|
| Style Prompting | 2302.09185 | EACL 2023 |
| SimToM | 2311.10227 | *none stated* |
| SG-ICL / Exemplar Generation | 2206.08082 | NAACL 2022 Workshop |
| Vote-K / Exemplar Selection | 2209.01975 | *none stated* |
| Instruction Selection | 2205.10782 | *none stated* |
| Tab-CoT | 2305.17812 | Findings of ACL 2023 |
| Memory-of-Thought | 2305.05181 | EMNLP 2023 |
| Uncertainty-Routed CoT | 2312.11805 | Gemini model report |
| RCoT | 2305.11499 | *none stated* |
| Recursion-of-Thought | 2306.06891 | Findings of ACL 2023 |
| Metacognitive Prompting | 2308.05342 | NAACL 2024 |
| Prompt Mining | 1911.12543 | TACL 2020 — already cited |
| AutoDiCoT | 2406.06608 | the survey itself, §6.2.3.3 |

The earlier finding that the 673-paper corpus contained none of these stands, and is
now explained rather than merely reported: these are 2022–2023 originals and the corpus
skews 2025–2026. **More reading would not have found them; a targeted lookup did.**

**Step 2 — the three records naming arXiv with no identifier. One resolved, two are
worse than recorded.**

`recube-repo-context` is arXiv 2603.25770, exact title match; the id is simply missing.
The other two return nothing across three query forms each, so they are not missing
identifiers but **wrong venues** — records claiming a preprint that does not exist under
that title. `scripts/catalog-known-defects.json` now says so.

**Step 3 — evaluation suites.** Current practice sizes a local iteration set at
**200–500 examples** built from real production failures rather than synthetic ones.
Against the ≈3,400-item anchor requirement, that independently confirms the two-tier
split rather than contradicting it: the numbers describe different jobs. One constraint
was missing from the design — **benchmark contamination**. Public suites decay as models
train on them, which is why contamination-resistant designs (monthly refresh, submission-
date filtering, private holdouts) exist, and why a public score should always be paired
with an internal set the model has not seen. That is a second contamination channel,
distinct from the scorer-mediated one, and the anchor must be private to survive it.

**Step 4 — judge validation.** Three protocols: agreement against human labels by
Cohen's κ, consistency by test-retest, and a bias audit presenting pairs in both
orderings. κ ≥ 0.60 is the working floor and ≥ 0.85 the bar where a wrong verdict costs
something, so the threshold is a per-rubric declaration rather than a constant. The
contract requirement that was missing here: pin the judge model id, **version the rubric,
hash the prompt template, and re-calibrate on every change to any of them**.
`judge-verdict.schema.json` now carries `rubric_hash`, and `agreement` now requires a
declared `threshold` beside the value.

**Step 5 — significance.** Consensus for paired binary outcomes on a shared prompt set
is McNemar on the discordant pairs, χ² = (b−c)²/(b+c), or 5×2 cross-validation with a
modified paired t-test; graded and free-form metrics use a paired bootstrap over
resamples. The finding that changes the design is **multiplicity**: with ten models,
forty-five pairwise comparisons need α corrected to 0.05/45 ≈ 0.0011. An optimizer
generates comparisons by construction, so a search over a hundred candidates at a
nominal 0.05 expects about five spurious winners. That is a Goodhart channel distinct
from a writable evaluator and from an undersized anchor, and nothing in the design
addressed it. `comparison.schema.json` now requires `comparisons_in_family` and records
the correction applied.

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
