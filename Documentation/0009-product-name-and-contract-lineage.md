# ADR-0009: The Product Is NexusPrompt; the Contract Lineage Stays PromptNexus

## Status
Accepted — 22 August 2026. Constrains `package.json` names, the CLI binary, the runtime
directory, and every future contract `$id`. Amends nothing; extends the versioning rule in
ADR-0002.

**Deciders:** whoever owns the published package and the contract set.

*(Follows the section convention of ADR-0001 through ADR-0008.)*

## Context

The product is being named **NexusPrompt**. The string `promptnexus` appears throughout the
tree, and it does not all mean the same thing:

| Where it appears | What it is | Count |
|---|---|---|
| `package.json` names, CLI binary, `.promptnexus/` runtime directory | the product's identity | 8 packages + 1 directory |
| Contract `$id` hosts — `https://promptnexus.dev/contracts/<name>/<version>` | versioned identities of a schema lineage | 15 schemas |
| `sources/**` | frozen, SHA-256-pinned historical artifacts | 52 files |
| `Documentation/` references to `promptnexus-v5/...`, `promptnexus-catalog-...` | paths into those frozen archives | most doc hits |

Only the first row is the product's name. The rest are either identifiers with a versioning
contract attached, or history.

A global find-and-replace would have been one command and three separate mistakes.

## Decision

**Rename the product surface. Leave the contract lineage and the archives alone.**

Renamed: the root package (`promptnexus` → `nexusprompt`), all seven workspace packages
(`@promptnexus/*` → `@nexusprompt/*`), the CLI binary and its usage text, and the runtime
directory (`.promptnexus/` → `.nexusprompt/`, which is gitignored and held one throwaway run
bundle).

Unchanged: every contract `$id`, everything under `sources/`, and every documentation
reference that names a path inside a frozen archive.

## Options considered

### Option A — Rename the product surface only *(chosen)*

| Dimension | Assessment |
|---|---|
| Blast radius | 8 package names, 1 directory, ~9 bare product mentions in docs |
| Version cost | none |
| Consistency | imperfect: the package says NexusPrompt, the schemas say promptnexus.dev |
| Reversibility | high |

**Pros:** costs nothing in schema versions; leaves the frozen inputs frozen; the boundary is
explainable in one sentence.
**Cons:** a reader meeting `promptnexus.dev/contracts/...` inside a package called
`nexusprompt` will wonder, which is why this ADR exists to be the answer.

### Option B — Full rename including contract `$id` hosts

| Dimension | Assessment |
|---|---|
| Blast radius | everything in A, plus 15 schemas |
| Version cost | **15 major bumps and 15 changelog entries, in one commit** |
| Consistency | total |
| Reversibility | low — the version history keeps the churn permanently |

Rejected. ADR-0002 makes a major bump mean *"a consumer reading the old shape breaks."* A
rebrand breaks no consumer. Spending fifteen majors on one would make the version number stop
meaning what ADR-0002 says it means, and every schema's lineage would restart at a boundary
that carries no technical information. The cost is not the fifteen commits; it is that
`comparison` would go from 2.2.0 to 3.0.0 for a reason no reader could infer from the diff.

`$id` is also a URI — an identifier, not an address. Nothing resolves it over the network, so
it is not required to match a brand any more than a Java package name is.

### Option C — Extract a standalone package and rename it there

Rejected for now. The differential oracle needs `sources/v5/prompt_lint.py` and its frozen
fixtures; an extraction that leaves them behind loses the one mechanism that catches defects
the port *shares* with its source — which is the entire argument of ADR-0007. An extraction
that takes them is not an extraction.

## Consequences

**Easier:** the published artifact has one name; `npm install` and the CLI agree.

**Harder:** two names coexist, and someone will eventually propose "fixing" it. This document
is the answer to that proposal, not a note that it is untidy.

**To revisit:** if the contract set ever gains an external consumer, or the schemas are
published at a resolvable URL, the `$id` host becomes a real address and the calculus
changes. Until then it is a name inside a file.

**Not a precedent for partial renames generally.** The split works here because the boundary
is principled — product identity versus versioned identifier versus frozen input — and each
side of it is checkable. `verify:sources` fails if the frozen side moves;
`contracts/CHANGELOG.md` records it if the schema side does.

## Action items

1. [x] Rename root and workspace package names.
2. [x] Rename the CLI binary, its usage text, and the runtime directory.
3. [x] Record the split in `README.md` under **Naming**, so a reader meets the explanation
       before the inconsistency.
4. [ ] Revisit if the contracts acquire an external consumer.
