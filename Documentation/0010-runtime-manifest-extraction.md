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

- The heading matches with or without leading hashes.
- A declaration line **opens** with its key, optionally bulleted: `[[KEY]] — description`.
- Blank lines and fence delimiters do not end the list. The fence exemption is load-bearing —
  this function reads raw text precisely so a fenced manifest still declares, and treating
  ` ``` ` as prose would undo that on the first one.
- `1. Read [[PLAYER_TIER]] and branch.` is a **use**. It ends the section rather than
  extending it, so a use cannot declare itself.
- Every heading in the document is read, not only the first, so a prose mention cannot shadow
  the real section.

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

**Six regression tests, including the must-not-fire half.** Relaxing `#+` to `#*` widens what
counts as a heading, so the suite pins that a document merely *mentioning* runtime variables
does not thereby declare whatever follows it.

**The oracle stays live on this gate.** Only the two declared shapes are excused. Any other
`RUNTIME_KEY_UNDECLARED` disagreement is still a build failure.

## Alternatives rejected

**Reproduce the source and record it as a known defect.** This is what the allowlist exists to
make unnecessary. ADR-0007 names "reproduce the bug or delete the oracle" as the false choice.

**Bound the span at a blank line.** Simpler, and it fixes the reported case — but a manifest
written with a blank line after the heading would then declare nothing, which is the original
false positive in a new costume.

**Bound the span at `BLOCK` markers specifically.** Ties the gate to one framework's layout
vocabulary. The declaration-list rule needs no vocabulary at all.
