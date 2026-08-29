# ADR-0013: The audit-report contract is accepted with no producer in this repository

**Status:** Accepted — 29 August 2026
**Authorises:** the `audit-report` entry in `contracts/pending-implementation.json`.
**Related:** ADR-0002 (contract-first design), ADR-0009 (product name and contract lineage).

## Context

`contracts/audit-report.schema.json` (1.0.0) and `prompts/nexus-audit-prompt.md` arrived
together in #38. The schema describes the output of a "Nexus Quality Audit Core": a status,
a violation list, a `determinism_score`, and a `silent_failure_risk` band.

Nothing in this repository produces one. The producer is a **language model following the
prompt**, and its output is a document a person reads, not a value any code here emits or
consumes. `grep` for `audit-report`, `audit_report` and `AuditReport` across every `.ts`,
`.mjs` and `.tsx` file returns nothing.

That is an unusual shape for this contracts directory. Every other schema here is written
by code — `freezeBaseline` writes a `baseline`, the judge adapter writes a `judge-verdict` —
and `test/contract-conformance.test.ts` holds each one to a value the running system
produced. `contracts/pending-implementation.json` was empty when #38 landed, and its comment
calls that "the intended terminal state rather than a milestone": every schema on disk
validated against something real.

Three checks fired on the merge, which is the mechanism working:

- `check:matrix` — the capability matrix is generated and was not regenerated.
- `check:truth` — the artifact-hash surface moved 75 → 76, and the truth boundary pins it.
- `test/contract-conformance.test.ts` — a schema that is neither validated nor declared
  pending fails the coverage rule.

None of them are about the schema's merits. They are about the paperwork a schema owes.

## Decision

Accept the contract, and record in `pending-implementation.json` that its producer is
outside this repository.

The alternative was to revert it. Rejected: the schema is coherent, `ajv` compiles it, and
the pending seam exists precisely so a contract can land before the thing that writes it —
that is what ADR-0002 asks for. Reverting would have punished the ordering rule the seam was
built to permit.

But the entry must not lie about what is coming. The other pending entries named a producer
that was going to be built here (`evaluation pipeline — expand step`). This one names a
producer that is not code, and says so, so a later reader does not go looking for a module
that was never planned.

## Consequences

**The exemption is not indefinite.** The stale rule already applies: the moment anything in
this repository validates an `audit-report`, the entry fails and must be removed. That is the
only automatic pressure on it, and it is enough — it makes the entry self-clearing rather
than self-renewing.

**A schema no code reads is a schema nothing keeps honest.** `additionalProperties: false`
and eight required fields constrain a document only if something checks the document against
them. Until a producer or a consumer exists, this contract's guarantees are aspirational, and
`CAPABILITY_MATRIX.md` will show it with no validator — which is the accurate picture, not a
gap to paper over.

**The prompt and the schema disagree, and the prompt is wrong.** `prompts/nexus-audit-prompt.md`
says "the 15 versioned JSON schemas". There are 16, and the sixteenth is the one that prompt
tells the model to conform to. Fixed in the same change as this ADR. It is a small error and
worth naming: the count was correct in the same PR's README and IMPLEMENTATION_PLAN edits and
stale in the prompt, which is the ordinary way a hand-maintained number drifts — `check:counts`
covers the documents, and did not know to look here.
