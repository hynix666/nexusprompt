/**
 * markStale — ported from SPB's descendantsOf/invalidateFrom pattern
 * (SystemPromptBuilderPipeline.tsx:1379–1405, 2427–2461), adapted from SPB's
 * static 9-node STAGE_DEPS table to NexusPrompt's per-revision parent lineage.
 *
 * Origin: 08-known-issues-and-decisions.md open register —
 *   "markStale has zero callers and zero tests; cascades by array position
 *   where the design says lineage. Closes when: parent_revision_ids is
 *   populated and the cascade follows it."
 *
 * PLACEMENT / INTEGRATION NOTES — read before merging:
 *  - Path assumed: core/src/stages/. Not confirmed against source (no repo
 *    access this session) — adjust if the real location differs.
 *  - `RevisionEntry` below is a MINIMAL PLACEHOLDER, not the real contract.
 *    Confirmed by documentation: revision-entry is schema v1.3.0
 *    (02-data-models.md), and gained `feedback_round` at that version
 *    (04-business-logic.md). `parent_revision_ids` and `revision_id` are NOT
 *    independently confirmed — parent_revision_ids appears exactly once across
 *    all 11 docs, as this issue's own closing condition, and revision_id is
 *    inferred by convention. Run `grep -rn "parent_revision_ids" contracts/`
 *    against the real repo before merging; if the field is missing, add it to
 *    contracts/revision-entry/ first (schema → CHANGELOG → binding →
 *    conformance case → this code, per ADR-0002's order), then replace this
 *    placeholder with the generated type and delete the interface below.
 *  - This module is pure — no effects, no imports beyond the placeholder type.
 *    It has ZERO callers by design (same as SPB's descendantsOf): something in
 *    the Application layer must call markStale wherever a revision's input is
 *    edited or a stage is manually rerun. See the illustrative (non-runnable)
 *    sketch at the bottom of this file for the shape that caller needs — it is
 *    NOT a drop-in file, Application's actual state shape is unknown here.
 */

/** MINIMAL PLACEHOLDER — see notes above. Reconcile against the real schema. */
export interface RevisionEntry {
  revision_id: string;
  parent_revision_ids?: string[];
}

/**
 * All revision IDs reachable by following parent_revision_ids forward
 * (i.e. every revision that lists `revisionId`, directly or transitively, as
 * one of its parents). Pure BFS — same traversal shape as SPB's
 * descendantsOf (queue + visited-set), walking a lineage graph built from
 * `allRevisions` instead of a static stage table.
 *
 * A revision run/rerun more than once from the same parent produces sibling
 * revisions here — the case SPB's fixed 9-stage graph could never construct
 * (verified this session: SPB's STAGE_DEPS is a total order under the
 * descendant relation, so no two SPB stages are ever "siblings" with no
 * shared ancestry). That's exactly the shape the missing must-not-fire test
 * needs, and exactly what SPB's own suite could never exercise.
 *
 * DELIBERATE DEVIATION FROM A LITERAL TRANSLITERATION, disclosed here rather
 * than left implicit: SPB's version re-scans the entire STAGE_DEPS table at
 * every BFS step (O(V) per step, fine at V=9). This version precomputes a
 * parent→children index once up front, so each step is an O(1) lookup —
 * O(V+E) overall instead of O(V²). Same algorithm shape, same guard pattern,
 * provably the same output set (see staleness.test.ts); only the "who
 * depends on the current node" lookup moved from live-rescan to
 * precomputed-index, which matters once V is a real revision history instead
 * of a fixed 9-node table.
 *
 * CYCLE / SELF-REFERENCE, checked not assumed: this function's only
 * loop-safety mechanism is the same one SPB's descendantsOf has — a
 * visited-set (`result`) guarding re-entry into the queue. SPB's hardcoded,
 * acyclic STAGE_DEPS table means that guard is never actually exercised
 * there. Here, where the graph comes from real (potentially malformed) data
 * rather than a literal table, it can be. Verified (not just reasoned about)
 * this session: a direct self-reference and a 2-cycle both terminate safely
 * — no infinite loop, no crash — because the guard is identical either way.
 * A self-referencing entry ends up included in its own descendant set as a
 * result; whether a revision store should ever be able to produce that shape
 * is a contracts-level question, not something this function silently
 * corrects. See staleness.test.ts for the checked cases.
 */
export function descendantsOfRevision(revisionId: string, allRevisions: readonly RevisionEntry[]): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const entry of allRevisions) {
    for (const parentId of entry.parent_revision_ids ?? []) {
      const existing = childrenOf.get(parentId);
      if (existing) existing.push(entry.revision_id);
      else childrenOf.set(parentId, [entry.revision_id]);
    }
  }

  const result = new Set<string>();
  const queue: string[] = [revisionId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const childId of childrenOf.get(current) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        queue.push(childId);
      }
    }
  }
  return [...result];
}

/**
 * The set that must be marked stale when `revisionId`'s input changes:
 * itself plus every descendant. Mirrors SPB's `invalidateFrom`'s first line
 * (`new Set([id, ...descendantsOf(id)])`) exactly — only the traversal
 * underneath changed.
 */
export function markStale(revisionId: string, allRevisions: readonly RevisionEntry[]): Set<string> {
  return new Set([revisionId, ...descendantsOfRevision(revisionId, allRevisions)]);
}

/* ────────────────────────────────────────────────────────────────────────
 * ILLUSTRATIVE ONLY — not a drop-in file.
 *
 * This is the shape of caller SPB proves is necessary (editTemplate calling
 * invalidateFrom, SystemPromptBuilderPipeline.tsx:2455–2461). Application's
 * actual state container, effect model, and naming are unknown here, so this
 * is pseudocode to convey the pairing, not code to paste in:
 *
 *   function onRevisionInputEdited(revisionId, allRevisions, applicationState) {
 *     const invalidated = markStale(revisionId, allRevisions);
 *     applicationState.markRevisionsStale(invalidated);   // effect — Application's job, not Core's
 *   }
 *
 * The point being ported is the PAIRING: a pure decision (markStale) plus a
 * caller that acts on it at the moment of edit. A pure function with no
 * caller — which is the exact state of the current markStale — doesn't fix
 * anything by existing.
 * ──────────────────────────────────────────────────────────────────────── */
