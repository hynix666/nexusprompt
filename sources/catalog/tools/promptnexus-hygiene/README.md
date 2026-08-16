# promptnexus-hygiene

Normalization and validation tooling for the **PromptNexus Prompt-Technique
Catalog** (schema 1.2.0).

Two commands:

| Command | Purpose |
| --- | --- |
| `normalize_catalog.py` | Rewrite a catalog into canonical 1.2.0 form, emit an auditable ledger of every edit, and optionally emit source-of-truth JSON |
| `validate_catalog.py` | Fail a build on any defect class the normalizer repairs, so the drift cannot reappear silently |
| `compare_exports.py` | Fail a build when the parallel exports stop describing the same catalog |
| `patch_catalog.py` | Remediate a catalog and emit it as a reviewable patch against the JSON source of truth |
| `verify_sources.py` | Resolve every `primary_source` against the live arXiv API and rewrite the verified-source table |
| `bundle_catalog.py` | Write every data serialization — JSON, XML, YAML, per-technique split — from one model |

Python 3.11+. **No third-party dependencies** — standard library only, so it
runs anywhere the builder runs.

---

## The problem this addresses

The v1.19.0 XML export contains 170 entries: the original 130, plus a
contiguous block of 40 appended by a code path that did not go through
`scripts/build_catalog.py`. That block violates the catalog's own invariants in
four independent, mutually-confirming ways — the *same 40 ids* are flagged by
each of these signals:

* no `<id>` child element (only the `@id` attribute)
* `<corpus_file>` emitted empty rather than omitted
* empty elements without the `empty="true"` / `nil="true"` markers
* no pretty-printing — each entry is a single unindented line

It also introduced four unregistered categories, seven new
`verification_status` values, two `determinism` synonyms, a third `status`
value, and two duplicated entries (`hyde` / `flare`, each appended twice).

Running the validator on the export as received:

```
TOTAL: 180 error(s), 62 warning(s)
RESULT: FAIL
```

After normalization, under `--strict`:

```
TOTAL: 0 error(s), 0 warning(s), 31 waived (reviewed, never fails a build)
RESULT: PASS
```

170 entries in → **172 out**: two duplicate pairs merged, four entries authored
to close cross-references that pointed at nothing. 243 recorded changes.

---

## Install and run

```bash
cd promptnexus-hygiene
python3 -m unittest discover -s tests -v     # 123 tests

./validate_catalog.py path/to/prompt_technique_catalog.xml

./normalize_catalog.py path/to/prompt_technique_catalog.xml \
    --output    dist/prompt_technique_catalog.xml \
    --ledger-md dist/NORMALIZATION_LEDGER.md \
    --ledger-json dist/normalization_ledger.json \
    --check
```

Equivalent module form: `python -m promptnexus_hygiene {normalize|validate} ...`

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Pass |
| `1` | Validation failed (errors present, or warnings present under `--strict`) |
| `2` | Usage error, or input that cannot be parsed at all |

### Useful flags

| Flag | Effect |
| --- | --- |
| `--strict` | Warnings fail the build too |
| `--allow-dangling` | Downgrade unresolved `related_techniques` targets to warnings while the missing entries are being authored |
| `--only C001 C006` | Run a subset of checks — how you waive a finding in CI without editing the checks |
| `--format json\|github` | Machine-readable report, or GitHub Actions annotations on the PR diff |
| `--dry-run` | Compute the ledger without writing XML |
| `--strip-dangling` | Delete unresolved references. **Off by default** — a reference that resolves to nothing is either a mis-typed id or a missing entry, and both deserve a decision rather than deletion |
| `--status-policy remap` | Fold `practitioner-guide` into `verified-external` (see below) |
| `--show-waived` | Also report findings the policy has already reviewed and accepted |
| `--no-add-entries` | Do not append the four authored entries |
| `--keep-template-ids` | Leave `template_id` values alone (the rename is a breaking change for external consumers) |

---

## What normalization does

Passes run in a fixed order; they are not commutative (merging must precede
reference rewriting, metadata is synchronised last).

1. **Serialization** — one serializer, one format. Adds the missing `<id>`
   elements, omits empty `<corpus_file>`, restores emptiness markers, applies
   canonical element order and two-space indent.
2. **Merge duplicates** — `hyde-hypothetical-document-embeddings` → `hyde`,
   `flare-forward-looking-active-retrieval` → `flare`. List fields are unioned,
   the survivor wins every scalar, the absorbed id is retained as an alias so
   existing lookups still resolve, and inbound references are redirected.
   170 entries → **168 distinct techniques**.
3. **Entries** — append four authored entries (`chain-of-symbol`,
   `knn-prompting`, `query2doc`, `self-edit-code`) whose absence left existing
   citations dangling. Sources verified against arXiv and the publisher record;
   see `additions.py`.
4. **Cross-references** — redirect merged ids, apply five explicit rewrites,
   drop one unsatisfiable reference, remove self-references and duplicates.
   Four of the nine "missing" targets turned out to exist under longer ids
   (`raptor` → `raptor-recursive-tree-retrieval`, `oprompt-optimization` →
   `opro`, and two more) — those are rewrites, not gaps.
5. **Sources** — 15 field-level corrections to four wrong or placeholder
   records, each carrying what was checked to verify it.
6. **Templates** — declare the one placeholder used but never declared;
   rename 15 `template_id`s onto the `<technique-id>--<slug>` convention.
7. **Categories** — register `prompt-compression-context-engineering`
   (3 members; answers the gap analysis's context-engineering recommendation);
   fold the three singleton categories into their existing peers.
8. **Vocabularies** — map the drifted `verification_status` and `determinism`
   values back onto the closed sets.
9. **Schema stamp** — per-entry `schema_version` set to the catalog's.
10. **Metadata** — root attributes and `<catalog_metadata>` reconciled; entry
    count and the category register are *derived from the entries*, so they
    cannot drift again.

Output is **deterministic and idempotent**: same input plus same policy yields
byte-identical XML, and normalizing an already-normalized catalog produces zero
changes. Both properties are asserted in the test suite.

### Where the judgement calls live

Every editorial decision is one line in `promptnexus_hygiene/policy.py`, with a
recorded rationale. Disagree with a mapping by editing that line — not by
reverse-engineering the normalizer. The remapping choices worth arguing about:

* `verification_status` answers *what can decide whether the output was
  correct?* The drifted values (`enforced-at-runtime`, `enforced-at-decode-time`,
  `enforced-by-dsl-compiler`, `classifier-dependent`, `self-verifying`) answer a
  different question — *where* enforcement happens — which is design detail
  belonging in `description`. All five map to `verifier-checkable`;
  `implementation-dependent` and `task-dependent` map to `unverifiable-by-text`.
* `deterministic` → `deterministic-at-temperature-zero`, because unqualified
  "deterministic" overclaims and the other 86 templates use the qualified form.
* `non-deterministic` → `stochastic-by-design`: exact synonyms.

**`practitioner-guide` is registered, not remapped, by default.** Folding vendor
documentation into `verified-external` would silently upgrade three entries'
evidence tier — the catalog would then claim they were verified against
literature that does not exist. `--status-policy remap` is available for
consumers that hard-code the original two-value enum, and the ledger records
the loss.

---

## Validation checks

| ID | Check | Fires on |
| --- | --- | --- |
| C001 | metadata/root consistency | root attributes disagreeing with `<catalog_metadata>` |
| C002 | declared entry count | `entry_count` ≠ number of techniques |
| C003 | id element present | `@id` without a matching `<id>` |
| C004 | id uniqueness and form | duplicate or non-slug ids |
| C005 | category registration | category in use but undeclared (error) / declared but empty (warning) |
| C006 | controlled vocabularies | `status`, `verification_status`, `cost_profile`, `determinism` outside their closed sets |
| C007 | single canonical serialization | empty optional elements, missing emptiness markers, unindented entries |
| C008 | per-entry schema stamp | entry `schema_version` ≠ catalog's |
| C009 | duplicate entries | shared name, arXiv id, title or `template_id` |
| C010 | referential integrity | dangling, self- or duplicated `related_techniques` |
| C011 | alias resolution | one alias resolving to two entries, unless allowlisted |
| C012 | template variable agreement | `{{placeholder}}` undeclared, unused declaration, off-convention `template_id` |
| C013 | corpus_file consistency | `corpus-present` without a file, or a file without the status |
| C014 | source completeness | missing source fields, malformed arXiv id, unreproducible "verified" claim, placeholder author strings |
| C015 | mandatory content | empty required prose, no usage template |
| C016 | author-string format | `"X et al."` standing in for a short author list rather than truncating a long one |
| C017 | relationship-graph connectivity | a record with no `related_techniques` — the signature of an entry added to satisfy a citation rather than authored into the catalog |
| C018 | render-label coverage | a vocabulary value the Markdown/PDF label maps cannot present |
| C019 | prose audit labelling | a record with no `source_audit`, or an audit value outside its vocabulary |

### Three severities

`ERROR` fails the build. `WARNING` fails it only under `--strict`. `WAIVED` is a
finding the policy has already reviewed and accepted: it never fails a build,
and it is printed only under `--show-waived`.

The third one is what makes `--strict` reachable without lying. Two things are
waived today: the real acronym collisions `BoT` and `DSP` (declared in
`policy.ALIAS_COLLISION_ALLOWLIST`), and 29 entries whose author strings still
read `"X et al."` (`policy.ABBREVIATED_AUTHOR_BACKLOG`). Backfilling those 29
means opening 29 papers. Leaving them as warnings would mean a build that is
never green, which trains everyone to ignore the output; deleting the check
would mean the problem silently spreads. Waiving them ratchets instead: the
known 29 stay listed and tracked, and the thirtieth fails `--strict`.

---

## Corrections made, and what was checked

Four source records were wrong, not merely inconsistent. Each correction in
`policy.SOURCE_CORRECTIONS` carries a `verified_via` field naming what was
actually consulted, so the verification is re-runnable rather than trusted:

* **`medprompt-framework`** conflated two papers — it carried the title of
  Moor et al.'s Nature *Generalist Medical AI* with Nori et al.'s authorship,
  and named Nature Medicine as the venue for what is an arXiv preprint.
  Corrected to Nori et al. 2023, *Can Generalist Foundation Models Outcompete
  Special-Purpose Tuning? Case Study in Medicine*, arXiv 2311.16452, with the
  full 18-author list.
* **`hierarchical-chain-of-thought`** listed `Various` as authors and a
  paraphrased title. Corrected to Huang, Li, Nikpour, Omidi and the real title.
  arXiv 2604.00130 was already right.
* **`confidence-informed-self-consistency`** listed `Various`. Corrected to
  Taubenfeld, Sheffer, Ofek, Feder, Goldstein, Gekhman, Yona.
* **`co-star-framework`** listed `Practitioner Taxonomies` as author under an
  invented title. CO-STAR originates with GovTech Singapore's Data Science and
  AI team; the citable artifact is Teo's December 2023 write-up, now linked.
* **`zero-shot-prompting`** claimed `verified-external` with nothing to verify
  against; the GPT-2 technical report's canonical URL was added.

## Residual: what the normalizer will *not* do

A tool that silently "fixes" a wrong citation is worse than one that leaves the
error visible — so the line is *verified* versus *invented*, not *fixable*
versus *hard*. What is left is listed in `policy.KNOWN_MANUAL_ACTIONS` and
reproduced in the Markdown ledger:

* **Port it upstream.** This policy, the authored entries and the ledger's edits
  have to reach `data/prompt_technique_catalog.json` and
  `scripts/build_catalog.py`. Until then the next build re-emits everything.
* **29 abbreviated author strings**, tracked as the waived C016 backlog. One of
  them (`structured-cot-code-generation`) predates the appended block, so this
  is not purely a v1.19.0 problem.
* **The 15 `template_id` renames are breaking** for anything citing a template
  by id. Every old → new pair is in the ledger; `--keep-template-ids` opts out.
* **`chain-of-symbol` keeps the arXiv title's typo** (`Langauge`). Fidelity to
  the record beat a silent correction; revisit if the catalog adopts a title
  normalisation rule.
* **`graphrag` → `knowledge-graph-enhanced-prompting` was dropped**, not
  satisfied. It names a research direction, not a technique with a citable
  source, and authoring an entry to justify a citation is backwards. If a
  specific method was meant, author it and restore the link.

---

## Wiring it into the build

**The XML is not the source of truth.** Normalizing the export fixes one
artifact; the JSON and the builder still emit the same drift on the next run.
The intended sequence:

1. Run the normalizer on the export to get a correct target state and a ledger.
2. Port `policy.py`'s decisions into `scripts/build_catalog.py` and apply the
   ledger to `data/prompt_technique_catalog.json`.
3. Keep `validate_catalog.py` as the gate that proves step 2 worked, on every
   export, forever. Import `promptnexus_hygiene.schema` in the builder so the
   builder and the validator cannot disagree about what 1.2.0 means.

`ci/catalog.yml` is ready to drop into `.github/workflows/`, and
`ci/pre-commit-hook.sh` refuses a commit that stages a generated export
directly — the local half of the same guarantee.

```yaml
# .github/workflows/catalog.yml
- name: Validate catalog exports
  run: |
    python scripts/build_catalog.py
    xmllint --noout --schema prompt_technique_catalog_1.3.0.xsd \
      data/prompt_technique_catalog.xml
    python validate_catalog.py data/prompt_technique_catalog.xml \
      --format github --strict
    python compare_exports.py data/prompt_technique_catalog.xml \
      --per-technique-dir techniques --markdown PROMPT_TECHNIQUE_CATALOG.md
```

Both steps are required. `prompt_technique_catalog_1.3.0.xsd` (shipped here)
replaces `prompt_technique_catalog_staging.xsd`, whose `techniqueType` is
`<xs:any processContents="lax"/>` — it accepts a record containing nothing at
all, which is why six of its nine complexTypes are unreachable from the root
element and why a green result from it certifies only well-formedness, unique
`@id`, and the metadata block's types. The replacement enforces element order,
the controlled vocabularies, slug and arXiv formats, and `@id` == `<id>`.

Even so, XSD cannot express reference resolution, entry-count reconciliation
against the *root attribute*, duplicate detection across records, or category
registration. A green schema is necessary for release and never sufficient;
`validate_catalog.py` is what covers the rest.

`--strict` passes today, so wire it in from the start — that is the whole point
of the waiver mechanism. Add `--show-waived` locally when you want to see the
tracked backlog.

---

## Source verification

`verified_sources.json` holds the `authors`, `title`, `year`, `arxiv_id` and
`url` of every arXiv-backed record, read from the live arXiv API rather than
transcribed. Regenerate it with `verify_sources.py`; the file carries its own
provenance block saying what was queried and how.

It exists because transcription failures in this catalog were not rare. Of the
35 arXiv-backed records added by the v1.20.0 patch, **five cited an id belonging
to a completely unrelated paper** — a Spanish-language economics paper, a
percolation-theory paper, `SparQ Attention`, an egocentric-vision survey, and a
GPT-4V hallucination study. All five ids are well-formed and era-plausible,
which is the signature of fabrication rather than typos, and no schema check can
catch it: only comparing against the publisher can.

**Field ownership is exclusive.** Anything arXiv can state authoritatively is
owned by `verified_sources.json`; `policy.SOURCE_CORRECTIONS` holds only what a
publisher API cannot settle — venue, and records with no arXiv presence. A test
asserts the two never write the same field, because two writers on one field
means the correction that survives is whichever pass ran last.

## Export consistency

The catalog ships in six formats; five are renderings of one dataset, so they
can only disagree if something wrote to one and not the others. That is what
happened: the XML reached 177 records while `PROMPT_TECHNIQUE_CATALOG.md` and
the per-technique export stayed at the 130 of v1.17.0 — even though the
Markdown's own header states the dataset and the human-readable catalog "can
never drift apart". Nothing in the release gate compared them.

```bash
python3 compare_exports.py data/prompt_technique_catalog.xml \
    --per-technique-dir techniques \
    --markdown PROMPT_TECHNIQUE_CATALOG.md
```

Checks id-set equality, field-level equality for shared records, header stamps,
and `INDEX.json` ↔ `json/` ↔ `markdown/` file-set agreement. Comparison is on
content, not encoding: `2024` and `"2024"` are the same year, and an omitted
optional field is the same as an explicit `null`.

### Patching the source of truth

`data/prompt_technique_catalog.json` is the only file the builder reads, and it
is clean: run `validate_catalog.py` on it directly (JSON input is supported) and
it reports zero errors across its 130 records. Everything this package has been
finding lives in records that only ever existed in the XML export.

```bash
python3 patch_catalog.py data/prompt_technique_catalog.json export.xml \
    --json-out data/prompt_technique_catalog.json \
    --manifest-md PATCH_MANIFEST.md \
    --catalog-version 1.20.0
```

The emitted JSON is byte-compatible with the shipped file: same top-level shape,
two-space indent, unescaped non-ASCII, no trailing newline, and `null` rather
than `""` for absent optional values. Round-tripping the shipped file through it
changes no value at all — the only difference is that record keys land in one
canonical order instead of the six the file currently mixes.

The manifest is what makes the patch reviewable: every record added, modified
and removed, with per-field before/after, descending into nested objects so a
changed URL reads as `primary_source.url` rather than two truncated blobs.
Anything in the modified list you did not ask for is a bug.

### Regeneration belongs to the builder

`normalize_catalog.py --json-out` writes the catalog as source-of-truth JSON in
the record shape the per-technique export already uses — verified by rendering
the 130 shared records from the XML and diffing them against the shipped files
(zero content differences). Feed that JSON to `scripts/build_catalog.py` and let
it regenerate all six renderings.

This package deliberately does **not** render the Markdown. A second generator
is precisely what caused the exports to diverge; adding another would be the
same mistake with different code.

## Bundles

```bash
python3 bundle_catalog.py data/prompt_technique_catalog.json --out dist/ --check
```

Writes, from a single in-memory model so the formats cannot disagree:

```
prompt_technique_catalog.json     source-of-truth shape, drop-in
prompt_technique_catalog.xml      canonical 1.3.0, validates against the XSD
prompt_technique_catalog.yaml     same records, block style, no anchors
techniques/INDEX.json
techniques/INDEX.md
techniques/json/<id>.json         one record per file
techniques/yaml/<id>.yaml
README.md                         what the bundle is, how to read source_audit
```

`--check` refuses to write from a catalog that fails `--strict`. The output is
byte-reproducible — regenerating from the same input yields identical files —
and a test asserts it, because that is what makes the "generated exports differ
from committed" step in CI mean anything.

**It does not emit the Markdown catalog or the PDF.** Those need the display
labels and layout in `scripts/build_catalog.py`, and a second copy of that logic
is what let the exports drift apart in the first place. `labels.py` holds the
maps that builder needs, including the two values v1.20.0 introduces.

## Prose audit labels (schema 1.3.0)

Every record carries what has been checked about its prose:

```json
"source_audit": { "description": "verified-against-abstract", "pitfalls": "unverified" }
```

Two axes, because they are settled by different evidence: an abstract confirms
what a technique does and almost never states how it fails. `unverified` means
nobody checked — **not** that the record is wrong; the sampled pre-existing
records were unverified and turned out clean. C019 fails the build on a value
outside the vocabulary, and a test asserts the display wording cannot drift into
implying falsity.

The bump to 1.3.0 is deliberate. Adding an element without one is the silent
drift this package exists to catch — and it has a consequence: **a pre-1.3.0
catalog fails validation until it is regenerated**, so the schema bump and the
content merge have to land in the same commit.

## Layout

```
promptnexus_hygiene/
  schema.py     canonical 1.2.0: element order, closed vocabularies, lexical rules
  model.py      typed model, strict parse (trust boundary), deterministic emit
  policy.py     every judgement call, with rationale — the file to review
  additions.py  the four authored entries, with their verified sources
  normalize.py  pure passes, each returning (catalog, ledger)
  validate.py   check registry
  exports.py    source-of-truth JSON emission and cross-export comparison
  labels.py     slug -> display-name maps for the Markdown/PDF renderings
  verified_sources.json   arXiv-verified source records, with provenance
  patch.py      record-level diff between two catalogs, rendered as a manifest
  bundle.py     JSON / XML / YAML and the per-technique split, from one model
  verify.py     arXiv resolution for every primary_source
  claim_corrections.py    unsupported claims, removed by anchored substring edit
  content_corrections.py  records whose prose described a different technique
  report.py     text / JSON / GitHub / Markdown renderers
  cli.py        argument parsing, I/O, exit codes
tests/
  test_catalog_hygiene.py    123 tests, planted-defect pair per check
```

Design constraints held throughout: frozen dataclasses and pure transforms (no
in-place mutation, no clock reads, no hidden state); parsing is the only trust
boundary and it raises with the offending technique id attached; every emitted
change carries a rationale — asserted by a test.

### Operational notes

* Input is assumed to be a first-party build artifact. `xml.etree.ElementTree`
  does not resolve external entities; a 64 MiB input cap guards against
  expansion attacks. If untrusted catalogs ever become a scenario, swap the
  parser for `defusedxml` — it is confined to `model.py`.
* Memory is O(catalog); the real file is under 1 MiB and normalizes in well
  under a second. No streaming path is warranted and none is provided.
* The normalizer never writes in place. Diff the output against the input
  before replacing anything.
