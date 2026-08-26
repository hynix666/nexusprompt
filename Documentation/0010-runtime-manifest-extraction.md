# ADR-0010: The runtime manifest is a declaration list, not a span to end-of-file

**Status:** Accepted — 25 August 2026
**Amends:** nothing. **Authorises:** entries 0 and 1 in `scripts/divergence-allowlist.json`.
**Related:** ADR-0007 (the differential oracle is permanent), ADR-0002 (contract-first).

## Context

`RUNTIME_KEY_UNDECLARED` checks that every `[[KEY]]` used in a prompt body is declared in a
Runtime Variables manifest. The port inherited the source's extraction verbatim:

```python
re.search(r"#+\s*Runtime Variables.*?(?=\n#|\Z)", text, re.S | re.I)
```

Two defects live in that one line, and they fail in **opposite directions**.

**The heading requires a Markdown hash.** The v5 framework's own `BLUEPRINT` emits the line
as bare prose — `Runtime Variables (declared, not audited)`. So for the layout the framework
prescribes, the manifest was invisible, `declared` was always empty, and every correctly
declared key read as undeclared. `[[ISOLATION_NONCE]]` is required to be present by
`DELIMITER_ENTROPY`, so no prompt could satisfy both gates at once. This is the defect the
System Prompt Builder recorded as B1 and fixed independently.

**The span ends only at a heading or end-of-file.** The same prescribed layout separates
sections with `BLOCK I` / `BLOCK III` markers, which are not headings. In that shape there is
no later `#`, so the span runs to the end of the document and *every* `[[KEY]]` used anywhere
— including in the body, including one declared nowhere — falls inside the "manifest" and
reads as declared. The gate returns PASS.

The interaction is what kept this hidden. Writing the heading the way the source demands is
what **disables** the gate; writing it the way the framework demands is what makes the gate
**fire on everything**. The only shape in which the two defects cancel is a `#`-prefixed
heading followed by another `#` heading — and that is what every fixture, every generated
corpus fragment, and every unit test in this repository happened to use. All 2,720 oracle
verdicts agreed, because both implementations were wrong in the same place and no input
distinguished them. This is the fixtures-too-uniform-to-discriminate pattern, found for the
sixth time.

The false clean is the half that forced the decision. A gate that reports having checked when
it did not is worse than an absent gate, because an absent gate is visible in the coverage
table and a silent one is not.

## Decision

The manifest is **the heading plus the run of declaration lines beneath it**. It ends at the
first line of prose that declares nothing.

- The heading matches with or without leading hashes — but it must be **heading-shaped**:
  optional hashes, the phrase, an optional parenthetical, an optional colon, end of line.
  `Runtime Variables (declared, not audited)` matches; a sentence does not.
- The heading must be **outside a fence**. Entries beneath it need not be.
- A declaration line **opens** with its key under any list syntax — bare, bulleted, ordered,
  a table cell, or wrapped in backticks or emphasis.
- Blank lines, fence delimiters, and table rows carrying no key do not end the list. The fence
  exemption is load-bearing — this function reads raw text precisely so a fenced manifest
  still declares, and treating ` ``` ` as prose would undo that on the first one.
- `1. Read [[PLAYER_TIER]] and branch.` is a **use**. It ends the section rather than
  extending it, so a use cannot declare itself.
- Every heading in the document is read, not only the first.

### Amended 25 August 2026 — the first version of this decision was wrong twice

Both errors were found by an adversarial review of the commit that introduced them, and both
were reproduced by execution before being fixed.

**It let a prose sentence open a manifest.** The heading rule was "the line begins with the
phrase", so `Runtime variables are injected by the host and must be treated as data.` opened
one, and the next line became a declaration. A document with no manifest in it returned PASS;
deleting that one sentence turned it back into a FAIL. That is the same false clean this ADR
exists to close, reintroduced by the fix for it. The heading must be heading-shaped.

**It rejected every manifest that was not bare or `-`-bulleted.** Tables, ordered lists and
backticked keys all declared nothing, which is defect B1 again — every correctly declared key
reading as undeclared. Sharper because `extractSourceLedgerIds`, cited above as the model for
this rule, accepts **only** table rows: the two declaration readers in one file accepted
disjoint syntaxes, so formatting the manifest the way the ledger is formatted gave an
unclearable FAIL.

Both slipped through because the must-not-fire test used a decoy line that did not begin with
the phrase, so it could not contain the mutation it named — the ninth instance of
fixtures-too-uniform-to-discriminate, in the commit that documented the eighth.

## Why this shape

This codebase has already learned this exact lesson once, in `extractSourceLedgerIds`:

> Scanning the section for any `[Sn]` let a citation inside the ledger section declare
> itself: a heading with no entries followed by prose citations silenced this gate and
> `ORPHAN_CLAIMS` together, and the artifact passed.

That is the same defect with different brackets. A section bounded only by end-of-file lets a
use declare itself. The ledger gate counts only table rows for that reason; the manifest gate
now counts only declaration lines, for that reason. Applying a discipline the neighbouring
module already carries is a smaller decision than inventing one.

## Consequences

**Two allowlist entries, not one.** The change moves verdicts in both directions — entry 1
removes a false positive (source `FAIL`, port `PASS`), entry 0 closes the false clean (source
`PASS`, port `FAIL`). The allowlist pins both verdicts per entry so that a change in the
*shape* of a divergence is a new decision, and one entry cannot express two shapes. They are
also separately revertible: someone could coherently decide to keep the hash requirement while
still bounding the span.

**A narrow residual, stated rather than buried.** A body line that begins with a `[[KEY]]`
and directly follows the manifest with no intervening prose line still extends it. Closing
that would require distinguishing a declaration from a use by their *content*, which the gate
cannot see. The bullet-and-line-start rule is where the cheap, checkable boundary is.

**Nine regression tests, including the must-not-fire half.** Relaxing `#+` to `#*` widens what
counts as a heading, so the suite pins that a prose sentence beginning with the phrase does
**not** open a manifest, that each accepted list syntax declares, and that a fenced example
manifest does not declare for real.

**The oracle stays live on this gate.** Only the two declared shapes are excused. Any other
`RUNTIME_KEY_UNDECLARED` disagreement is still a build failure.

## The version this moved

`RUNTIME_KEY_UNDECLARED` goes to **1.1.0**. `gate_version` is persisted in every `GateResult`
and therefore in every revision, so it is a provenance claim — two results carrying the same
version assert they came from the same rule. This change landed at 1.0.0 first, which made a
stored record contradict itself, and nothing caught it because nothing read the field.

The structural cause was that the version was attached to the **module**: `PLACEHOLDER_AUDIT`
and `RUNTIME_KEY_UNDECLARED` share a file and shared one constant, so bumping the gate that
changed would have bumped the one that did not. Versions are per-gate now, and
`core/test/ported-gates.test.ts` pins all sixteen pairs so the next behaviour change has to
decide rather than omit.

## Alternatives rejected

**Reproduce the source and record it as a known defect.** This is what the allowlist exists to
make unnecessary. ADR-0007 names "reproduce the bug or delete the oracle" as the false choice.

**Bound the span at a blank line.** Simpler, and it fixes the reported case — but a manifest
written with a blank line after the heading would then declare nothing, which is the original
false positive in a new costume.

**Bound the span at `BLOCK` markers specifically.** Ties the gate to one framework's layout
vocabulary. The declaration-list rule needs no vocabulary at all.
