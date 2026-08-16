# Source Verification Ledger

Every factual claim this documentation set makes about the four prior artifacts, checked against the artifacts themselves.

**Verified:** 16 August 2026, against seven distinct source drops, ordered oldest to newest by mtime:

| Drop | Date | Contains |
|---|---|---|
| `~/Downloads/files.zip` | Aug 8 | v5 linter at 15 gates, `PromptNexus.jsx` 165.1 KB, `fixtures.json` 14.9 KB |
| `System-Prompt-Builder-final-0a4605ad.zip` | Aug 15 14:57 | final package, pipeline component 120.3 KB |
| `~/Downloads/Compressed/files_3.zip` | Aug 15 15:22 | **`System-Prompt-Builder-updated.zip`** + pipeline component **126.4 KB** |
| `filesZ.zip` | Aug 15 19:15 | 172-technique catalog, hygiene toolchain |
| `Prompt-Nexus.zip` | Aug 16 01:35 | v5 tree with tests, adversarial corpus, standalone proxy |
| `systempromptbuilder.zip` | Aug 16 01:36 | hosted product, Drizzle schema, `.git/` |
| `~/Downloads/Compressed/files_4.zip` | Aug 16 02:10 | **newest linter** (16 gates), `fixtures.json` 16 KB, `PromptNexus.jsx` 175.3 KB |

Three files supplied from `~/Downloads/Telegram Desktop/` are byte-identical (SHA-256) to the working-directory copies and add nothing.

**Port from the newest of each lineage:** the linter and fixtures from `files_4.zip`, the pipeline component from `files_3.zip`. Neither lives in the working directory.

## Frozen — the evidence is now checkable

As of 16 August 2026 the port set is extracted to `sources/`, with `sources/MANIFEST.json` recording a SHA-256 per file (420 files, 4.60 MB) and per contributing archive. Every claim below can be re-checked against those files rather than against archives that may move:

```
node scripts/verify-sources.mjs
```

It re-hashes all 420 files and exits non-zero naming any that are missing or modified. This was tested by corrupting a file and by deleting one — both produce a named failure. The frozen copies re-assert the counts that changed during verification: **16 gates** in `sources/v5/prompt_lint.py`, **11 stages** in `sources/pipeline/SystemPromptBuilderPipeline.tsx`, **40 fixture cases**, **172 catalog records**.

Superseded revisions are deliberately absent: the 15-gate linter, the 9-stage pipeline component, and `prompt_technique_catalog.168.json`. `MANIFEST.json`'s `supersedes` field records which drop replaced which.

This file exists because the documentation set repeatedly cited counts, file names, and schema shapes from systems nobody had re-read. Fourteen of twenty-two checkable claims were wrong. The pattern is consistent and worth naming: **the claims that survived verification are the ones describing artifacts that exist as data or tests; the claims that failed are the ones describing capability that had to be inferred.**

A second pattern emerged once multiple drops of the same artifact were compared: **the sources are still moving, and their own documentation does not keep pace.** The updated final package added two pipeline stages while its `docs/` tree stayed byte-identical — the exact documentation drift this architecture was designed to prevent, occurring inside one of the artifacts being merged. Any count taken from a single archive is a snapshot, not a fact; check the mtime and compare drops before trusting one.

## Method

Each archive was extracted read-only to a scratch directory and inspected directly — no claim was accepted because another document repeated it. Counts come from parsing the actual data files, not from prose. Where a claim named a file, the file was opened; where it named a symbol, the symbol was searched for across every archive.

`files_4.zip` supersedes its counterparts: its `prompt_lint.py` (31 KB), `PromptNexus.jsx` (175.3 KB), and `fixtures.json` (16 KB) are all later revisions than the copies inside `Prompt-Nexus.zip` and `filesZ.zip`. **Port from `files_4.zip`.**

## Re-verification, 16 August 2026 (post-freeze)

Three files supplied from `%TEMP%` — `fixtures.json`, `prompt_lint.py`, `PromptNexus.jsx` — checked against the frozen copies. **All three byte-identical** (SHA-256). Their later mtimes are extraction timestamps, not new content. The freeze holds, and the question was settled by one hash comparison rather than by re-reading 227 KB.

Reading them in full rather than by pattern match added three things:

**The corrected gate severities are independently confirmed.** The severity table in `GATES_REFERENCE.md` was rebuilt from the linter's emission sites. The fixture corpus — written by the source's own authors, and not consulted when those corrections were made — asserts an expected `(gate, severity)` pair per case. **All fifteen match**, including `GUARDRAIL_GAP`'s conditional `WARN` below the safety tier and `FAIL` at it, which appears in the corpus as two separate cases. Two independent sources, same answer.

**The corpus is a regression history.** Eleven of the forty cases carry a `regression:` field naming a defect that actually shipped — lexicographic sorting of `S10` before `S2`, `if token_budget:` skipping a budget of exactly `0`, a `100%` regex that required a literal space, `GUARDED` missing from both the ceiling table and the argparse choices, a dot-all fence regex that broke the CommonMark length rule, and `telescope` satisfying the `scope` guardrail clause through unanchored substring matching. That last one is described in the corpus as *"a false-clean on a safety gate."* These cases are not illustrative; each one exists so a specific bug cannot return. **Port them before porting the gates.**

**Fifteen of sixteen gates have fixture coverage.** `ADVERSARIAL_RESILIENCE` has none — it is opt-in and needs `adversarial/corpus.json` at runtime, so it cannot be exercised by the standard corpus. Worth knowing before treating fixture pass as full gate coverage.

The corpus also documents a limit in the testing strategy that `DEVELOPMENT_AND_TESTING.md` previously did not record: **parity between two implementations cannot detect a defect they share.** Three of the eleven regressions were invisible to the parity harness for exactly that reason and were found by a differential oracle against an independent implementation. That section now says so.

## Verified true

| Claim | Evidence |
|---|---|
| 172-technique catalog | `data/prompt_technique_catalog.json` → 172 records; `techniques/INDEX.json` agrees. Metadata: `schema_version: 1.3.0`, `catalog_version: 1.20.0`, `generated_at: 2026-08-12`. A 168-record snapshot sits alongside it as `prompt_technique_catalog.168.json` |
| Local history bounded at 8 entries | `revisionHistory.slice(0, 8)`, entry-based, at four separate call sites in the newer component (lines 911, 920, 981, 1218). **This confirms the retention conflict was a real defect in the source**, not a documentation error — and the newer 11-stage pipeline makes it worse |
| Final package held provider keys in the browser | `SystemPromptBuilderPipeline.tsx:252` — `headers.Authorization = ` Bearer ${apiKey}` ` in client-side code. ADR-0003's rejected option is accurately described |
| Catalog exports in four formats from one source of truth | `data/` contains `.json`, `.xml`, `.yaml`; `PROMPT_TECHNIQUE_CATALOG.pdf` at package root |
| XSD 1.3.0 validation | `schema/prompt_technique_catalog_1.3.0.xsd`, 12.7 KB |
| Byte-reproducible PDF export | `tools/promptnexus-hygiene/promptnexus_hygiene/render.py` — explicit determinism and invariant-mode handling, plus a `reproducibility_note` field |
| Catalog CI tooling ports as-is | `ci/catalog.yml`, `ci/pre-commit-hook.sh`, and a 14-module `promptnexus_hygiene` package (`schema`, `policy`, `exports`, `render`, `report`, `normalize`, `patch`, …) |
| `⟦WORKFLOW DEMO⟧` honesty convention | Present in `framework_v5_7_0_core.md`, `standalone/app.js`, `tests/test_offline.py`, and both `PromptNexus.jsx` copies |
| Typed provider health and error handling in the hosted product | `server/hostedProviders.ts` — `HostedProviderHealth`, `HostedProviderError`, `callWithTimeout`, `probeModel` |

## Verified false

| # | Claim | Reality | Where it was asserted |
|---|---|---|---|
| 1 | 17 lint gates | **16.** `files_4/prompt_lint.py` emits 16 distinct gate IDs (excluding the `DEGRADED`/`GATE_FAIL` status codes). The copy in `Prompt-Nexus.zip` has 15 | `GATES_REFERENCE.md`, `ARCHITECTURE.md`, `CAPABILITY_MATRIX.md` |
| 2 | `GUARDRAIL_COMPLETENESS` is a gate | Exists in no source file. Its documented description — coverage of the declared risk surface, versus `GUARDRAIL_GAP`'s presence check — is a plausible distinction that was reasoned into existence, not read from code | `GATES_REFERENCE.md` |
| 3 | Two catalog-linked gates in `catalog/tools/gate-extensions/` | No such directory in any archive. No gate reads catalog data | `GATES_REFERENCE.md`, `CATALOG.md` |
| 4 | `TOKEN_SPAM` and `DUPLICATE_INSTRUCTION` are not gates | Both are real and emitted by the linter. `DUPLICATE_INSTRUCTION` is new in `files_4.zip` | omitted from `GATES_REFERENCE.md` |
| 5 | 29-assertion proxy security baseline | **27.** `tests/test_server.py` contains 27 `check()` calls. Neighbouring suites have 33 (`test_offline.py`) and 23 (`test_adversarial.py`); none is 29 | `PROVIDERS.md`, `CONTRACTS.md`, `PRIVACY_AND_SECURITY.md`, `README.md` |
| 6 | `TechniqueRecord` has `technique_id`, `provenance.checked_against_source`, `applicable_stages` | Real fields: `id`, `name`, `category`, `subcategory`, `executive_summary`, `description`, `verification_status`, `cost_profile`, `when_to_use`, `when_not_to_use`, `known_pitfalls`, `related_techniques`, `primary_source`, `secondary_sources`, `usage_templates`, `tags`, `status`, `aliases`, `corpus_file`, `schema_version`, `source_audit`. None of the three documented field names exists | `CONTRACTS.md`, `CATALOG.md` |
| 7 | Provenance is a boolean `checked_against_source` | `verification_status` is three-valued across 172 records: **130** `verifier-checkable`, **34** `unverifiable-by-text`, **8** `judge-checkable`. Per-field audit lives in `source_audit` (e.g. `{"description": "unverified", "pitfalls": "unverified"}`); citations live in a structured `primary_source` with authors, year, and venue | `CONTRACTS.md`, `CATALOG.md` |
| 8 | Hosted adapter reuses a `localRetry`/`localModelStatus` pattern | Neither symbol exists in `server/hostedProviders.ts` or anywhere else | `PROVIDERS.md` |
| 9 | `storage-db` is Postgres | `drizzle/schema.ts` imports from `drizzle-orm/mysql-core`; every table is a `mysqlTable` | `PRIVACY_AND_SECURITY.md` |
| 10 | DB-backed revision persistence, queryable by `run_id`/user/date | The Drizzle schema defines two tables: `users` and `promptAssets`. **There is no runs or revisions table.** This capability does not exist in any source and is new work, not a port | `REVISIONS_AND_EXPORTS.md`, `PROVIDERS.md`, `ARCHITECTURE.md` |
| 11 | `scripts/new-gate.ts` and `scripts/new-technique.py` scaffolding generators | Neither exists in any archive. `CONTRIBUTING.md` instructs contributors not to hand-write gates because these generators exist; `DEVELOPMENT_AND_TESTING.md` claims CI verifies their output | `CONTRIBUTING.md`, `DEVELOPMENT_AND_TESTING.md`, `GATES_REFERENCE.md`, `CATALOG.md` |
| 13 | Gate verdict semantics as documented | **Wrong for five gates.** Read from the emission sites in `prompt_lint.py`: `SECRET_LEAK_SCAN` emits WARN (documented FAIL) — the source states a hit means "look here, not proof"; `CLAIM_DISCIPLINE` WARN (documented FAIL); `DELIMITER_ENTROPY` FAIL (documented WARN); `ORPHAN_CLAIMS` FAIL (documented WARN); `RAG_SHIELD_GAP` FAIL (documented WARN). Two more are conditional rather than fixed: `GUARDRAIL_GAP` is FAIL at safety tier and WARN below, `ADVERSARIAL_RESILIENCE` is banded | `GATES_REFERENCE.md` |
| 14 | `fixtures.json` contains 8 fixtures | **40 cases**, each with `name`, `text`, `options`, `expect`. The count of 8 came from misreading the file's `_comment` array | interim verification note, now corrected |
| 12 | Nine pipeline stages | **Eleven.** The newer component in `files_3.zip` defines `s1`–`s11`: the documented nine plus **`Cost Estimate`** (role `cost`) and **`Tone Check`** (role `tone`), both `on: true` by default. The 120.3 KB copy has nine; the 126.4 KB copy has eleven | `USER_GUIDE.md`, `CONTRACTS.md` (`stage_id` enum), `ARCHITECTURE.md`, `README.md`, ADR-0004 |

## Misattribution

`⟦WORKFLOW DEMO — no model⟧` is credited to the filesZ toolkit in the source-lineage table. It originates in v5 — `framework_v5_7_0_core.md`, `standalone/app.js`, and `tests/test_offline.py` all carry it. filesZ inherited it.

## Unresolved

**The nineteen target properties are not recoverable.** `ARCHITECTURE.md` names 15 (5 structural, 5 quality, 5 verification) while citing 19. A search of `framework_v5_7_0_core.md` and the rest of the v5 documentation found no enumeration of 19 properties — only incidental uses of "Resilience" and "consistency" in unrelated prose. The four missing properties are not in the sources that were supplied. Either the count is wrong, or the list lived somewhere that was never archived. **Do not invent four to make the arithmetic work.**

## What porting actually involves

Two findings that change effort estimates:

- **The linter is monolithic.** `prompt_lint.py` implements all 16 gates as inline checks inside a single ~190-line `lint()` function (`files_4/prompt_lint.py:300-493`), sharing local state and precompiled patterns at module scope. Porting to `core/gates/` as 16 independently testable pure functions is a decomposition, not a translation.
- **The catalog is data, and ports cleanly.** 172 records, a validating XSD, four generated formats, and working CI tooling. This is the highest-confidence port in the project and the one place the documentation's optimism was justified.
