# SPB audit, August 2026 — proposed, NOT integrated

**Nothing in this directory runs.** It is not imported by any module, not covered by
`npm run verify`, not typechecked (`tsconfig.json` includes named directories and this is not
one), and not part of the artifact hash. It is a draft, kept because the reasoning in it is
worth reading, and moved here from `SystemPromptBuilderPipeline/New folder/` — a name that gave
a browsing reader no way to tell any of that.

The files were written in a session with **no access to this repository**, which they say
themselves. `staleness.ts` opens with *"Path assumed… not confirmed against source (no repo
access this session)"* and *"`RevisionEntry` below is a MINIMAL PLACEHOLDER, not the real
contract."* `json-schema-malformed.ts` says the same of `GateResult`'s field names. Read the
types here as sketches of contracts, never as the contracts — `contracts/` is authoritative and
its schemas are versioned.

## What is here, and what state each part is in

### `core/src/stages/staleness.ts` — **superseded, do not merge**

A `markStale` implementation cascading by parent lineage rather than array position, written
against the open-register entry *"markStale has zero callers and zero tests; cascades by array
position where the design says lineage."*

That entry closed on 25 August 2026. `markStale(run_id, from_revision_id)` landed with the
gate-feedback loop as its first caller, `parent_revision_ids` is populated, and the interface
change is recorded in `contracts/CHANGELOG.md`. The problem this file solves is solved, against
the real contract instead of a placeholder. It is kept only as a record of an independent
reading of the same defect.

### `core/src/gates/json-schema-malformed.ts` — **unported, and a real decision if adopted**

A seventeenth gate. `JSON_SCHEMA_MALFORMED` appears in **neither** `core/src/gates/registry.ts`
**nor** `sources/v5/prompt_lint.py`, which makes adopting it more than a file copy:

- The differential oracle compares sixteen ported gates against the frozen linter. A gate with
  no counterpart there has no oracle, so ADR-0007's terms have to be met some other way — an
  ADR saying why, at minimum.
- `gates.ported` is a pinned count. Adding one moves numbers `check:counts`, `check:plan`,
  `check:matrix` and the truth boundary all re-derive, and each pin is a sentence that has to
  be re-read rather than incremented.

The behaviour it proposes is sound and worth keeping in view: `JSON.parse` is authoritative and
a block that parses is never flagged, with heuristics running **only** in the catch branch to
make an opaque `SyntaxError` actionable. That ordering is the fix — SPB's regression was
heuristics running *before* the parse and false-positiving on valid, pretty-printed JSON whose
string values contained a colon. It is the same shape as ADR-0010 and ADR-0011: a matcher that
fires on a conforming artifact.

### `verification/*.mts` — standalone, `node:assert`-based

Three scripts that exercise the two proposals above. They are not vitest tests and no project
glob picks them up; run them directly with `tsx` if you want to see the drafts execute.

### `../AUDIT.md`

Stays where it is, one level up. It is the audit these files came from and it is about the
**SPB pipeline component**, not about this repository — four of the five false positives it
reports are findings against that codebase. Two of them, `RUNTIME_KEY_UNDECLARED` and
`QUTM_CEILING`, were independently reached here and are the two entries in
`scripts/divergence-allowlist.json` carrying ADR-0010 and ADR-0011.

## If you want to adopt any of this

Take it through the ordinary path, not by moving files back: reconcile the placeholder types
against `contracts/`, land any schema change first (ADR-0002), and — for the gate — write the
ADR that says what stands in for the oracle. A draft merged because it was already written is
how a placeholder type becomes a contract.
