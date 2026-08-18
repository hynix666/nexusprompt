# Contract changelog

[ADR-0002](../Documentation/0002-contract-first-design.md) requires a version bump **and a
changelog entry** for every schema change. Versions have always lived in each schema's `$id`;
the changelog half had no artifact behind it until 2026-08-18. This file is that artifact.

Entries are newest first. A schema's version lives in its `$id` and is the authority — this
file records *why* a version moved, which the `$id` cannot.

Versioning, as applied here:

- **major** — a consumer reading the old shape breaks. Removing a field, tightening a type,
  making an optional field required.
- **minor** — additive. A new optional field; a widened enum.
- **patch** — wording only. Descriptions, examples, `$comment`. No shape change.

---

## 2026-08-18

### `comparison` 1.0.0 → **2.0.0** (major)

**Removed** `detectors_equalized` (boolean). **Added** `equalization` (object), now required.

The boolean was never computed. Every occurrence carrying a value was a test, hardcoded
`true`; the runner never set it at all. So the comparator's strongest guard — the one that
makes it refuse rather than report a number — was a field the caller filled in.

`equalization` is derived from both runs' measured recall blocks and carries the evidence:
`max_gap`, the derived `gap_bound`, `effective_recall`, `adjusted_resolution`, and the
per-detector figures.

The boolean was deleted rather than kept alongside. Retaining it would have made this an
additive minor bump and left **two sources of truth for one fact**, one of them a summary
readable without consulting the evidence. That property — readable without being checked —
is what let the guard go unverified. Preserving it for compatibility would have preserved
the defect. Nothing outside this repository consumes these schemas.

*Migration:* replace `detectors_equalized: true` with the `equalization` object emitted by
`compare()`. Callers no longer pass equalization in; they pass both runs' `detector_recall`
blocks and the comparator derives it.

### `eval-run` 1.0.0 → **1.1.0** (minor)

**Added** optional, nullable `detector_recall`: per-detector `substrates`, `probes_run`,
`probes_detected`, `recall`, plus `probe_corpus_version`.

Recall is a property of **(detector, configuration)**, not of a detector alone — the finding
this whole change exists to encode. `eval-run` is where it belongs because a run already pins
the configuration, which makes a stale pairing structurally impossible.

Optional and nullable rather than required, so the bump stays additive. A run may legitimately
exist without recall; it simply cannot be *compared*, and the comparator enforces that. The
wording follows `grader_health`: absence is a known-unknown, never a pass.

`recall` is nullable because `probes_run` can be 0 when a run offers no substrate. Null means
*not measurable*; 0 means *measured and dead*. They take different paths — one refuses the
comparison, the other fails the build — and collapsing them would fail the build for the
wrong reason.

---

## Before 2026-08-18

No entries. Thirteen schemas landed across the contract-first work with version bumps recorded
only in their `$id`s. Reconstructing those entries after the fact would produce a changelog
asserting things nobody verified at the time, which is the failure mode this repository keeps
finding in its own documentation. The gap is left visible instead.
