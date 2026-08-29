# Artifact-Reference Lineage — Design

**Date:** 29 August 2026
**Status:** Approved for implementation
**Closes:** `[AUDIT B-4]` — "`input_ref`/`output_ref` documented, absent from the contract"
**Extends:** ADR-0002 (contract-first), ADR-0008 (evaluation-first), Part 2 of the production-environment SPEC (evidence plane), Part 8 (release gate)
**Method:** Same as the production-environment work — every defect cited below was verified in the tree before being designed against, and every pinned number in this document is re-derived from the repository.
**Sources read:** `REVISIONS_AND_EXPORTS.md`, `PRIVACY_AND_SECURITY.md`, `OBSERVABILITY.md`, `contracts/index.ts`, `contracts/revision-entry.schema.json` (1.3.1), `contracts/promotion.schema.json`, `contracts/baseline.schema.json`, `contracts/pending-implementation.json` (1 entry: `audit-report`), `contracts/CHANGELOG.md`, `adapters/storage-local`, `adapters/evidence-local`, `core/src/release/promote.ts`.

---

## 1. The problem, in the tree's own terms

Four documents promise behavior that the current shape cannot deliver:

| Document | Promise | What exists |
|---|---|---|
| `REVISIONS_AND_EXPORTS.md` | `input_ref`, `output_ref` are "pointers to retained content, so events and lineage never embed bodies" | No field on `RevisionEntry` (1.3.1), no store, no reader. Documented and absent — the exact text `[AUDIT B-4]` pinned |
| `PRIVACY_AND_SECURITY.md` | `delete(run_id, confirmation)` "removes the complete run bundle including retained `input_ref`/`output_ref` content" | There is nothing for deletion to reach: the content those fields would name is not retained anywhere |
| `REVISIONS_AND_EXPORTS.md` | Replay "depends on the retained response referenced by `output_ref` and on a stated retention policy — never on the hash alone" | Same absence. The sentence names a mechanism that has no referent |
| `core/src/release/promote.ts` | The `pointer-mismatch` precondition checks three pointers | All three are ids inside the evidence plane. A promotion can name a run whose content was evicted, and nothing notices — the gate validates the graph, not the reachability of what the graph points at |

The pattern is the one `[AUDIT]` named as "a guarantee written but not wired": the reference is
documented as a field, the retention is documented as a behavior, and neither has a contract, a
store, or a gate. This design supplies all three, and wires the existing checks to them rather
than adding a fourth unwritten promise.

### What this design is not

- **Not a rehash of revision lineage.** `parent_revision_ids` and the staleness cascade are
  built and tested (`adapters/storage-local/src/index.ts`, `markStale`). This design is about
  *content* references — pointers to retained bytes — not about which revision computed from
  which. The two compose: a revision's lineage says what it depended on; its refs say where the
  bytes it read and wrote live.
- **Not a migration of existing records.** Nothing has ever written an `input_ref`/`output_ref`
  (they do not exist in the contract), so there is no backfill. The first store to write a ref
  is the first producer, which is precisely what landing a schema before its producer is for —
  the same sequencing `baseline` 2.0.0 used when `supersedes` replaced `superseded_by`.

---

## 2. Design principles, each inherited from a decision already paid for

1. **Immutability is expressed by absence, not by convention.** `EvidenceStore` has no `update`
   and no `delete`; the comment in `contracts/index.ts` explains why. The content store inherits
   the same shape: content is written once, addressed by its own hash, and never edited. A
   corrected artifact is a new artifact.
2. **Content is addressed by content.** `configuration_id` is already "the content hash of
   everything else" (`configuration.schema.json`); `EvalRun` already carries
   `core_build_hash` and `configuration_id` as provenance. Extending the same discipline to
   retained content means a ref is *self-verifying*: anyone holding the bytes can confirm the
   pointer without consulting the store that issued it.
3. **A ref names a kind, not a location.** `RetentionScope` (`LOCAL_BUNDLE | DB | EXPORT`)
   already distinguishes where a record lives from what it is. A reference must survive an
   adapter swap — `storage-local` and `storage-db` are "swappable per deployment" — so the ref
   carries *what* was retained, and each adapter resolves *where*.
4. **The gate lands with the capability.** `[AUDIT]`'s rule, encoded as an entry criterion on
   every part of the production-environment SPEC: ship the check with the thing it checks. The
   integrity gate in §6 is part of this design, not a follow-up.
5. **Deletion is scoped and confirmed, or it does not exist.** The typed-DELETE confirmation
   rule already governs `storage-local`'s bundle clearing. Content deletion inherits it: a ref
   that cannot be resolved *because its content was deleted* is a distinct, honest state —
   not a silent miss.

---

## 3. The reference itself

### 3.1 Grammar

A ref is a string with four `:`-separated segments:

```
npx:<kind>:<content_hash>:<scope_hint>
```

| Segment | Form | Example |
|---|---|---|
| scheme | literal `npx` (NexusPrompt content) | `npx` |
| kind | `stage-input` \| `stage-output` \| `generation-response` | `stage-output` |
| content_hash | lowercase SHA-256, 64 hex chars — the same pattern `input_hash`/`output_hash` already pin | `9f2c…` (64 chars) |
| scope_hint | `local-bundle` \| `db` \| `export` — the scope the writer *believed* applied; advisory, resolved per deployment | `local-bundle` |

Why a string and not an object: `parent_revision_ids`, `supersedes`, and every pointer field in
`Promotion` are plain strings. A ref that is a string can live in any of them, survives JSON
round-trips without shape negotiation, and validates with one `pattern`. Why it carries the
hash: the existing `input_hash`/`output_hash` fields on `RevisionEntry` are bare digests with no
pointer; the ref *is* the digest plus the two facts a digest lacks — what kind of content, and
under what retention it was written.

**The hash inside the ref is unkeyed SHA-256.** The keyed-digest rule (`[AUDIT C-4]`,
`OBSERVABILITY.md`) applies to *observability* fingerprints, which must not be correlatable
across deployments. Content addressing is the opposite requirement: the whole point is that the
same bytes give the same ref everywhere, so a promotion's pointer can be verified by anyone
holding the artifact. The two live on different planes, and conflating them would break both —
a keyed content hash could not be verified by the reader of an export, and an unkeyed event
fingerprint would be dictionary-attackable. `PRIVACY_AND_SECURITY.md`'s deletion row already
draws this line: events retain only hashes (keyed) while content is retained and deletable
(unkeyed, addressed).

### 3.2 What a ref guarantees, and what it does not

| Claim | Backed by | Holds? |
|---|---|---|
| The ref names exactly one content item | Content address | Yes — same hash is the same bytes |
| The content exists where the writer left it | The store that wrote it | Only within the store's retention policy and lifetime |
| The content can be replayed | Retained response + stated policy | Only while retained; `REVISIONS_AND_EXPORTS.md` already says replay is never from the hash alone |
| The ref is private | Nothing | **No** — an unkeyed hash of prompt content is correlatable. Refs ride on records that already carry content or content hashes (`RevisionEntry`, exports); they must never be emitted to the observability sink, which rejects bodies and carries keyed hashes only |

That last row is the design's one genuine hazard, stated rather than buried: a ref is a *retention-plane*
identifier, and the observability plane's keyed-fingerprint rule exists precisely because identifiers
like it leak. The sink already rejects rather than truncates; this design adds `npx:`-shaped strings to
what the sink's redaction check treats as a body reference.

---

## 4. The content store

### 4.1 Contract

New port, deliberately narrow — the `EvidenceStore` shape, applied to content:

```ts
export interface ContentRef {
  readonly ref: string;          // the §3.1 grammar, validated once at the boundary
  readonly kind: ContentKind;
  readonly content_hash: string; // unkeyed SHA-256, uppercase-free
}

export type ContentKind = "stage-input" | "stage-output" | "generation-response";

export interface ContentStore {
  readonly retention_scope: RetentionScope;
  /** Writes once under the content address. A second put of the same bytes is a no-op success (same hash ⇒ same content); different bytes under a colliding address are impossible by construction. */
  put(ref: ContentRef, bytes: Uint8Array): Promise<void>;
  /** Resolves a ref to bytes, or null when the content is gone (evicted, deleted, or never written). Null is "not here", not "never was". */
  get(ref: string): Promise<Uint8Array | null>;
  /** Existence without the read — the integrity gate's need, and the deletion sweep's. */
  has(ref: string): Promise<boolean>;
}
```

No `update`. No `delete` on the interface — deletion is an adapter-level operation with its own
confirmation discipline (§7), because deleting content is a *retention* decision, not an
evidence decision, and the two planes keep their own rules (`PRIVACY_AND_SECURITY.md` already
splits event retention from content retention).

`put` is idempotent by content address: writing the same bytes twice succeeds, because the
second write is the same file under the same name. This differs deliberately from
`EvidenceStore.put`, which refuses a duplicate `(kind, id)` — evidence records are *events*
(distinct things that happened once), content is *material* (the same bytes re-derived are the
same material). `evidence-local`'s `wx` flag is still the write primitive here; the difference
is only that `EEXIST` with matching bytes resolves to success rather than error, which the
adapter checks by re-reading and hashing.

### 4.2 Adapter: `adapters/content-local`

One file per content item, path `<root>/<first-2-hex-chars>/<remaining-62>.bin`, written with
the `wx` flag — the same syscall-level immutability `evidence-local` uses, and the same
`SAFE_ID`-style validation at the boundary: a ref that fails the §3.1 grammar is refused, not
parsed leniently. Sharded directories keep any one directory small, which is the one concession
to scale a local store needs; `storage-db` will make its own choice when it exists.

**The bundle problem, and why content is not bundled.** `storage-local` retains run bundles
whole because a partially-evicted run is worse than no run. Content is the opposite case: each
item is independently addressed and independently cited, exactly like `evidence-local`'s
records. But eviction *policy* is inherited from the bundle rule, because the failure it guards
— citing something that no longer exists — is the same: content is evicted only when every
retained run bundle that references it has itself been evicted. §6's gate makes the residual
gap visible rather than pretending it is closed.

---

## 5. Wiring: where refs are written and read

### 5.1 `RevisionEntry` gains the fields

`revision-entry` **1.3.1 → 1.4.0** (minor: additive, optional, no existing instance breaks). Per
ADR-0002 the bump lands as its own reviewed PR with a `contracts/CHANGELOG.md` entry — the
changelog is a checked artifact now (the `audit-report` retroactive entry proved the rule
needs it):

```json
"input_ref":  { "type": ["string", "null"], "pattern": "^npx:(stage-input|stage-output|generation-response):[0-9a-f]{64}:(local-bundle|db|export)$" },
"output_ref": { "type": ["string", "null"], "pattern": "^npx:(stage-input|stage-output|generation-response):[0-9a-f]{64}:(local-bundle|db|export)$" }
```

Nullable, optional, both. Optional because eleven stages × two refs must not force a store that
cannot retain content to fabricate pointers — a `null` ref is the honest "not retained here",
and the export rule in §5.3 is what keeps that honest rather than silent. Nullable for the same
reason. The contract-first rule (ADR-0002) is honored: this schema change lands as its own
reviewed PR with a changelog entry, before any code writes the fields.

**The hashes stay.** `input_hash`/`output_hash` are required and remain the keyed-observability
and equality-comparison surface. A ref is a retention pointer, not a replacement for the digest
fields — a record with refs and no hashes would be unverifiable, and one with hashes and no refs
is exactly what every existing record is.

### 5.2 Who writes refs

The Application layer, at the two points it already owns effects:

- After a stage executes, the Application retains the stage's input assembly and output body
  through the `ContentStore`, and hands Core the reduced state with refs attached. Core never
  sees the store — it receives refs as data, which is `decide → invoke → reduce` unchanged:
  the refs are part of what is reduced.
- A `generation-response` ref is written when a provider response is retained for replay —
  the case `REVISIONS_AND_EXPORTS.md`'s replay row already anticipates.

**What Core does with a ref: nothing.** Core never resolves a ref. Resolving is an effect, so
it belongs to the Application; a Core function that needed content would receive the content as
an argument, not the pointer. This is stated because it is the invariant most likely to be
"conveniently" broken first.

### 5.3 Export and deletion rules that finally become implementable

- **Export:** an export includes a revision's content only when the ref resolves in the export's
  retention scope; a ref that does not resolve is rendered as the ref string plus an explicit
  `content-unavailable` marker — never silently dropped, never silently inlined. Stale entries
  keep their existing exclusion rule; refs do not change it.
- **Deletion:** `delete(run_id, confirmation)` on the revision store now has a referent: it
  removes the bundle and asks the `ContentStore` to drop every ref the bundle's entries name.
  Content shared with another retained run (identical bytes ⇒ identical ref) is *kept* —
  content addressing makes sharing visible and sharing-safe deletion free, which per-bundle
  content copies would have made impossible without a use-count.

---

## 6. The integrity gate: `refs-resolve`

The pointer-mismatch precondition in `promote.ts` already refuses a promotion whose three
pointers disagree. This design adds the check that pointer consistency alone cannot make: that
the artifacts the pointers name are still *reachable*.

**Rule (Core, pure, given an existence oracle):** every ref on every `RevisionEntry` of the
candidate run and the baseline run must resolve (`has() === true`) in the store that issued it,
or the promotion is refused with a new code:

```
dangling-ref
```

detail names the first unresolved ref and the entry that carries it.

**Why Core with an oracle, and not the Application alone:** the refusal is a *decision*, and
decisions belong in Core; the existence check is an effect, so it is injected as a predicate —
the same shape `JudgeAdmission` already uses in `PromotionRequest`. Core composes the decision;
the Application performs the lookups. No callback into generation, no I/O in Core, boundary
check unchanged.

**Refusals compose with the existing ones, in the existing order:** preconditions first
(`development-lineage`, then `pointer-mismatch`, then `dangling-ref`), then the five conditions.
A promotion certified against evidence whose content has been evicted is refused *before* its
conditions are evaluated, mirroring "instrument before measurement": the gate refuses to
evaluate a claim about artifacts it cannot see.

**The honest limit, stated:** content eviction (§4.2) can strand a ref that was valid when
written. The gate makes that visible at the moment it matters — promotion — rather than
pretending retention is unbounded. An operator who needs the promotion can re-run the baseline
against a suite that still resolves; what they cannot do is promote across a hole silently.

### 6.1 A second consumer: the conformance suite

`test/contract-conformance.test.ts` validates every schema against values the running system
produced. `pending-implementation.json` currently holds exactly one entry — `audit-report`
(ADR-0013), whose producer is a model following a prompt, outside this repository — and
`revision-entry` is not on it: it has a producer and a conformance case. So this change does
**not** re-open the pending seam. What it does do is tighten the existing case: the entry the
suite validates must now be one the pipeline produced *with refs populated*, so the new fields
cannot land as a schema no writer exercises — the condition ADR-0002's ordering exists to
prevent, and the one the pending file's own stale rule enforces per schema. The store adapter
gets the same parameterized conformance treatment `evidence-local` received: the suite scans
`adapters/` and fails if an implementation exists that it does not exercise.

---

## 7. Lifecycle: write, resolve, evict, delete

| Event | Behavior | Guard |
|---|---|---|
| Write | Application retains bytes via `put`; ref recorded on the entry; duplicate bytes no-op | `wx` + hash equality on `EEXIST` |
| Resolve | `get` returns bytes or null; null is rendered `content-unavailable`, never fabricated | §5.3 export rule |
| Evict | Content drops only when no *retained* run bundle references it | Bundle-eviction hook in the adapter; residual gap surfaced by `refs-resolve` |
| Delete | `delete(run_id, confirmation)` drops bundle + unreferenced content; shared content survives | Typed confirmation, unchanged from `PRIVACY_AND_SECURITY.md` |

The one deliberate asymmetry: **evidence is forever, content is not.** An `EvalRun` survives its
content. That is what makes the evidence plane's immutability meaningful — the *claim* outlives
the *material* — and it is why `refs-resolve` exists: to catch the moment a claim is asked to
certify something whose material is gone.

---

## 8. Threat model

| Threat | Mitigation |
|---|---|
| A promotion certifying evidence whose content was evicted | `refs-resolve` precondition; new refusal code `dangling-ref` |
| Refs leaking correlatable content identifiers into telemetry | Sink's redaction check extended to treat `npx:`-shaped strings as body references — rejected, not truncated |
| A lenient parser accepting a malformed ref as "good enough" | One grammar, validated at the boundary (`SAFE_ID` precedent); no leniency anywhere |
| Deletion silently breaking a still-cited export | Export renders `content-unavailable` explicitly; deletion keeps shared content |
| "Temporary" content store growing without bound | Eviction tied to bundle retention (8 bundles), not to a second arbitrary number |
| An adapter inventing its own ref shape | The grammar lives in the contract; conformance suite refuses non-conforming writers |

---

## 9. Tests, each proven by exit code

1. **Round-trip.** `put` → `get` returns identical bytes; `has` true; unknown ref → `get` null,
   `has` false.
2. **Idempotent put.** Same bytes twice → second `put` succeeds; different bytes, same ref →
   impossible by construction (asserted by attempting a hand-crafted collision of the grammar,
   which the boundary refuses).
3. **Malformed refs refused.** Wrong scheme, short hash, uppercase hash, unknown kind, unknown
   scope → `put` and `get` throw at the boundary.
4. **Entry validation.** `revision-entry` 1.4.0 accepts a real produced entry with refs; rejects
   a ref with an uppercase hex char; accepts `null` refs; validates unchanged against every
   existing fixture (additive). `CONTRACT_VERSIONS` gains the bumped version, which the
   conformance suite pins against the `$id` on disk.
5. **Producer-backed fields.** A pipeline run writes refs that the validator accepts, so
   `revision-entry` never needs a `pending-implementation.json` exemption; the file's single
   `audit-report` entry (ADR-0013) is untouched.
6. **`refs-resolve` fires.** Promotion whose candidate run's `output_ref` does not resolve →
   refused, `dangling-ref`, conditions unevaluated. Control: same promotion with content
   present → pointer precondition passes through to conditions.
7. **`refs-resolve` must-not-fire.** Promotion with all refs resolving → no `dangling-ref` in
   refusals. (The half that keeps the gate from being satisfiable by refusing everything.)
8. **Deletion keeps shared content.** Two runs referencing the same bytes; delete one bundle
   (confirmed) → `has(ref)` still true; delete the second → false.
9. **Sink rejects ref-shaped strings.** An event payload carrying an `npx:` ref in a free-text
   field is rejected by the redaction check.
10. **Conformance coverage assertion.** The parameterized suite fails when a `ContentStore`
    implementation exists that it does not exercise.

Mutation probes follow the established discipline: every probe must be *caught* by at least one
test, and any test that cannot fail under any probe is rewritten before landing — the rule four
phases of probes have enforced here.

---

## 10. Scope and non-goals

- **No `storage-db` content adapter.** The DB shape has no revision persistence yet (`ADR`
  register, open item); content persistence follows it and inherits the tenant-scoping rules
  then. The contract is written so the adapter can exist without schema change.
- **No compression, dedup beyond content addressing, or remote storage.** The local adapter is
  a directory of files. Content addressing already dedups; anything further is a deployment
  decision, not a contract one.
- **No retrofit of `EvalRun`/`Baseline`/`Promotion` with refs.** Evidence records name runs and
  configurations by id; their reachability is checked by `refs-resolve` through the *runs* they
  name. Adding refs to evidence records would duplicate what the graph already expresses.
- **No change to the staleness cascade.** `markStale` walks `parent_revision_ids`; refs do not
  participate in staleness. A revision whose content is gone is not stale — it is
  *unresolved*, and §6 is what says so.

---

## 11. As-built

Empty by design. This section records where the build departs from this text, per the convention
the detector-recall design set. It will be filled in when implementation lands, and any
departure is recorded there rather than quietly restated here.
