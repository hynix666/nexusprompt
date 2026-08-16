# Source Freeze and Provenance — Design

**Date:** 16 August 2026
**Status:** Approved for implementation
**Scope:** Establishes the verified source inputs for the PromptNexus merge and the mechanism that keeps ported code traceable to them. Precedes all porting work.

## Problem

The PromptNexus merge ports code from four prior systems. Those systems were supplied as seven archive drops over eight days, and the drops are not interchangeable:

- The linter exists in three revisions. The oldest (`files.zip`, Aug 8) has 15 gates; the newest (`files_4.zip`, Aug 16) has 16, adding `DUPLICATE_INSTRUCTION`.
- The pipeline component exists in two revisions. The copy in the working directory has 9 stages; the copy in `files_3.zip` has **11**, adding `Cost Estimate` and `Tone Check`.
- Three files supplied from a second location are byte-identical duplicates and add nothing.

Verification against these sources found twelve false claims in the documentation set, two of which were false only because they described an older revision. The gate count and the stage count both changed under the documentation while it was being corrected.

The updated final package illustrates the failure mode precisely: it added two pipeline stages while its `docs/` tree remained byte-identical. The drift this architecture exists to prevent is present in the artifacts being merged.

Without a freeze, ported code inherits this ambiguity. A gate ported today cannot later be shown to correspond to any particular source revision, and `execution_provenance.core_build_hash` — which the contract requires — would identify a build without identifying what that build was derived from.

## Goals

1. Establish exactly one canonical revision per source lineage, identified by content hash.
2. Preserve the files that will actually be ported, independent of the archives' continued existence.
3. Make every ported module traceable to the source file and revision it came from.
4. Fail the build if a frozen source file changes after the freeze.

## Non-goals

- **No re-verification workflow for future drops.** The source set is complete; no further archives exist. If one appears, the manifest is sufficient to determine whether it is genuinely new, but no automated ingestion path is built for a case that is not expected to occur.
- **No archive retention.** Only files that feed a target package are extracted. The archives are not deleted by this work and remain available at their current paths, so re-extraction stays possible — but it is not guaranteed, and this is an accepted tradeoff.
- **No porting.** This design establishes inputs. Translating them into `core/`, `adapters/`, and `packages/` is separate work with its own design.

## The extraction set

Newest revision of each lineage. Paths are as they appear inside their archive.

### From `files_4.zip` (Aug 16 02:10) — newest linter

| File | Feeds |
|---|---|
| `prompt_lint.py` | `core/gates/` — 16 gates, currently one monolithic `lint()` |
| `fixtures.json` | `core/gates/` — 8 fixtures, the parity baseline for the port |
| `PromptNexus.jsx` | `shells/toolkit-ui` — newest toolkit shell |

### From `Prompt-Nexus.zip` (Aug 16 01:35) — v5 tree

| File | Feeds |
|---|---|
| `promptnexus-v5/adversarial/corpus.json` | `core/scorer/` |
| `promptnexus-v5/adversarial/scorer.py` | `core/scorer/` |
| `promptnexus-v5/standalone/serve.py` | `adapters/provider-local-proxy` |
| `promptnexus-v5/tests/test_server.py` | provider contract tests — the 27-assertion security baseline |
| `promptnexus-v5/tests/test_prompt_lint.py` | `core/gates/` test port |
| `promptnexus-v5/tests/check_versions.py` | build-hash stamping |
| `promptnexus-v5/tests/differential.mjs` | cross-implementation parity harness |
| `promptnexus-v5/tests/parity.mjs` | cross-shell parity harness |
| `promptnexus-v5/framework_v5_7_0_core.md` | reference — gate semantics and framework conventions |

### From `filesZ.zip` (Aug 15 19:15) → nested `promptnexus-catalog-v1.20.0-ci-complete.tar.gz`

| Path | Feeds |
|---|---|
| `promptnexus-catalog/data/` | `core/catalog/` — 172 records in JSON, XML, YAML. Excludes the superseded `prompt_technique_catalog.168.json` |
| `promptnexus-catalog/schema/prompt_technique_catalog_1.3.0.xsd` | catalog validation |
| `promptnexus-catalog/techniques/` | per-technique JSON records and index |
| `promptnexus-catalog/tools/promptnexus-hygiene/` | catalog CI toolchain |
| `promptnexus-catalog/ci/` | catalog CI configuration |
| `promptnexus-catalog/reports/SOURCE_VERIFICATION.json` | provenance audit data |

### From `files_3.zip` (Aug 15 15:22) — newest pipeline

| File | Feeds |
|---|---|
| `SystemPromptBuilderPipeline.tsx` | `core/stages/` (11 stage definitions and templates), `packages/pipeline-presentation` (UI) |

### From `systempromptbuilder.zip` (Aug 16 01:36) — hosted product

| File | Feeds |
|---|---|
| `server/hostedProviders.ts` | `adapters/provider-hosted-server` |
| `server/hostedProviders.test.ts` | hosted adapter contract tests |
| `server/hostedProviderConfig.test.ts` | hosted adapter config tests |
| `server/storage.ts` | `adapters/storage-db` reference |
| `server/referenceContext.ts` | `adapters/storage-db` reference |
| `drizzle/schema.ts` | `adapters/storage-db` — MySQL; `users` and `promptAssets` only |
| `drizzle/0000_condemned_doctor_doom.sql` | migration reference |

Excluded deliberately:

| Excluded | Reason |
|---|---|
| `files.zip` in full | Superseded — its `prompt_lint.py` has 15 gates against `files_4`'s 16 |
| Working-directory `SystemPromptBuilderPipeline.tsx` | Superseded — 9 stages against `files_3`'s 11 |
| `Prompt-Nexus.zip`'s `prompt_lint.py`, `fixtures.json`, `PromptNexus.jsx` | Superseded by the `files_4` copies |
| Three `~/Downloads/Telegram Desktop/` files | Byte-identical to working-directory copies (SHA-256 verified) |
| `data/prompt_technique_catalog.168.json` | Superseded 168-record snapshot |
| `pnpm-lock.yaml`, `client/src/components/ui/**` | Third-party scaffolding, not merge material |
| `System-Prompt-Builder-updated.zip`'s `docs/` | Byte-identical to the older package's docs and describes a 9-stage pipeline the code no longer has |

Every exclusion is a superseded revision, a verified duplicate, or third-party code. Nothing is excluded on judgment about whether it will be needed.

## Layout

```
sources/
  MANIFEST.json
  v5/              # from Prompt-Nexus.zip and files_4.zip
  catalog/         # from filesZ.zip → nested tarball
  pipeline/        # from files_3.zip
  hosted/          # from systempromptbuilder.zip
```

Each file keeps its path within its origin archive below the lineage directory, so `promptnexus-v5/tests/test_server.py` becomes `sources/v5/promptnexus-v5/tests/test_server.py`. Preserving the internal path means a reader can match an extracted file to its position in the original tree without consulting the manifest.

Two lineages need an explicit rule:

- **`v5/` draws from two archives.** Files from `files_4.zip` sit at the archive root, so `prompt_lint.py` becomes `sources/v5/prompt_lint.py`; files from `Prompt-Nexus.zip` are nested, so `promptnexus-v5/tests/test_server.py` becomes `sources/v5/promptnexus-v5/tests/test_server.py`. No collision occurs, because the superseded `promptnexus-v5/prompt_lint.py` is not extracted.
- **`catalog/` drops the tarball's single top-level directory.** `promptnexus-catalog/data/` becomes `sources/catalog/data/`. This is the only path rewriting performed, and the manifest records both the original and rewritten paths.

**Size.** Approximately 6.2 MB committed: 5.7 MB catalog, 372 KB v5, 169 KB pipeline and hosted. The catalog dominates because it ships the same 172 records in two shapes — `data/` as consolidated JSON/XML/YAML (2.9 MB) and `techniques/json/` as one file per technique (2.0 MB). Both are kept: the hygiene toolchain reads the consolidated files, while the per-technique files are what the catalog's own CI validates. The superseded `data/prompt_technique_catalog.168.json` snapshot is **not** extracted.

## MANIFEST.json

One record per extracted file. All hashes are SHA-256, computed at extraction time.

```json
{
  "frozen_at": "2026-08-16",
  "note": "Complete source set. No further drops expected.",
  "archives": [
    {
      "archive_id": "files_4",
      "original_path": "~/Downloads/Compressed/files_4.zip",
      "archive_sha256": "<computed>",
      "mtime": "2026-08-16T02:10:00",
      "supersedes": ["files", "prompt-nexus:prompt_lint.py"]
    }
  ],
  "files": [
    {
      "manifest_id": "v5/prompt_lint",
      "archive_id": "files_4",
      "path_in_archive": "prompt_lint.py",
      "extracted_to": "sources/v5/prompt_lint.py",
      "sha256": "<computed>",
      "bytes": 31744,
      "feeds": ["core/gates"],
      "notes": "16 gates in one lint() function; decomposition required"
    }
  ]
}
```

`archives[].supersedes` records which earlier drops a given archive replaces. This is what makes the freeze auditable: a reader can see that `files_4` supersedes `files`, and why the older revision was excluded.

`feeds` is the link between a source file and the package that will port it. It is not enforced at freeze time — it becomes checkable once the target packages exist.

## Verification

`pnpm run verify:sources` re-hashes every file listed in `MANIFEST.json` and compares against the recorded SHA-256.

- **Exit 0:** every file present and matching.
- **Exit non-zero:** any file missing, or any hash mismatch. The output names the file, the expected hash, and the actual hash.

It runs in CI as the first step of the Core stage, before gate tests. A modified source file must break the build rather than silently alter ported behavior. The check is pure filesystem and hashing — no network, and fast enough to run on every invocation.

The command does **not** consult the original archives. Once frozen, `sources/` is the authority; the archives are historical.

## Provenance in ported code

Every module ported from a frozen source carries a header comment:

```
// Ported from sources/v5/prompt_lint.py (manifest: v5/prompt_lint)
// sha256:<first 12 chars> — see sources/MANIFEST.json
// Gate: SECRET_LEAK_SCAN. Behavioral parity asserted against sources/v5/fixtures.json
```

Three properties follow:

1. A reviewer reading a gate can find the code it came from without searching.
2. `execution_provenance.core_build_hash` on a stored `RevisionEntry` becomes meaningful — the build hash identifies Core, and Core's modules identify their sources, so a revision is traceable to the source revision that judged it.
3. If `verify:sources` fails, the modules affected are identifiable by manifest id rather than by guesswork.

The header is convention, not tooling. A lint rule to enforce its presence on files under `core/` is possible later and is not part of this work.

## Acceptance criteria

1. `sources/` contains every file in the extraction set, at its specified path.
2. `MANIFEST.json` has one record per extracted file, with a computed SHA-256, and one record per contributing archive.
3. `pnpm run verify:sources` exits 0 against a clean extraction.
4. Corrupting one byte of any extracted file causes it to exit non-zero and name that file.
5. Deleting one extracted file causes it to exit non-zero and name that file.
6. The gate count in `sources/v5/prompt_lint.py` is 16, and the stage count in `sources/pipeline/SystemPromptBuilderPipeline.tsx` is 11 — the two counts that changed during verification, re-asserted against the frozen copies.
7. `Documentation/SOURCE_VERIFICATION.md` cites manifest ids rather than archive paths for the claims it evidences.

Criteria 4 and 5 are the ones worth testing deliberately; a verification command that cannot fail is worse than none, because it produces false confidence.

## Risks

| Risk | Response |
|---|---|
| An archive is deleted before extraction runs | Extract before any cleanup. The three newest artifacts are in `~/Downloads`, which is routinely emptied. This is the reason to do this work first |
| A file is needed later that was not extracted | Archives remain at their current paths; re-extract and add a manifest record. Accepted tradeoff of extracting only the port set |
| The freeze captures a revision that is itself superseded | Mitigated by hashing and comparing all seven drops before freezing. Two supersessions were found this way; a third would have been found the same way |
| `sources/` is edited to make a failing port pass | `verify:sources` fails in CI. The sources are inputs, not working files |
