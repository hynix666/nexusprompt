# Capability Matrix

<!-- GENERATED FILE — do not edit by hand.
     Produced by `npm run docs:matrix`; `npm run docs:matrix -- --check` fails the build
     when this file differs from what the repository currently produces. -->

Generated from the repository by `scripts/generate-capability-matrix.mjs`. Every number
below is read from the tree at generation time; none is asserted by hand. This file was
hand-written until 22 August 2026 and carried a banner saying so, because the generator
named in `IMPLEMENTATION_PLAN.md` did not exist.

## Contracts

`Validated` means `test/contract-conformance.test.ts` compiles that schema's validator and
checks a value the running system produced against it — the same signal the coverage test
enforces, so this table and that test cannot disagree.

| Contract | Version | Status |
|---|---|---|
| `baseline` | 2.0.0 | validated |
| `comparison` | 2.2.0 | validated |
| `configuration` | 1.2.0 | validated |
| `eval-case` | 1.2.0 | validated |
| `eval-run` | 1.1.0 | validated |
| `eval-suite` | 2.0.1 | validated |
| `gate-result` | 1.3.0 | validated |
| `judge-verdict` | 1.1.0 | validated |
| `observability-event` | 1.2.0 | validated |
| `pipeline-outcome` | 1.0.0 | validated |
| `promotion` | 1.0.0 | validated |
| `provider-failure` | 1.0.0 | validated |
| `revision-entry` | 1.3.0 | validated |
| `technique-record` | 1.3.0 | validated |

**14 of 14** schemas are validated against a value the system produced.

### Columns this table does not have

`Producers` and `Consumers` were columns in the hand-written version and are absent here.
Deriving them needs a `CapabilityRegistration` record that nothing writes, and guessing
them from imports would be wrong the first time something was re-exported. The hand-written
draft got exactly this wrong — it listed pure Core modules under "Implementing Adapters"
— which is the argument for omitting a column rather than filling it approximately.

## Adapters

Ports have swappable implementations; this is what is present in the tree.

- `adapters/evidence-local`
- `adapters/provider-local-proxy`
- `adapters/storage-local`

## Evidence plane

What the system has actually retained. These are counts of records on disk, not claims
about capability — a zero here means the capability exists and has never been exercised,
which is a different statement from the capability being absent.

| Record | Count |
|---|---|
| `eval-run` | 0 |
| `comparison` | 0 |
| `baseline` | 0 |
| `promotion` | 0 |

**No promotion has ever been recorded.** The release gate exists, is tested against each
of its five conditions, and has never been run against a real evaluation — because no
run here has ever called a model. The gate being armed is not the same as it having fired.

## What this file cannot tell you

That a contract is validated says a value matching it was produced and checked. It does not
say the value was *correct*, that a model was involved, or that anything was measured against
a provider. Those questions are answered by `EvalRun` records and by
`npm run check:fingerprint`, which reports "not armed" until a run reaches a provider.
