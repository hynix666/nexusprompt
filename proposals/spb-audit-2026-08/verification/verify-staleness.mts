import assert from "node:assert/strict";
import { descendantsOfRevision, markStale, type RevisionEntry } from "../core/src/stages/staleness.js";

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
};

// A small lineage, deliberately shaped to include a branch — the thing SPB's
// fixed 9-stage STAGE_DEPS graph structurally cannot have (verified this
// session: SPB's graph is a total order under the descendant relation).
//
//        r1
//        |
//        r2
//       /  \
//     r3    r4      <- SIBLINGS: neither is an ancestor of the other
//      |     |
//     r5    r6
const lineage: RevisionEntry[] = [
  { revision_id: "r1" },
  { revision_id: "r2", parent_revision_ids: ["r1"] },
  { revision_id: "r3", parent_revision_ids: ["r2"] },
  { revision_id: "r4", parent_revision_ids: ["r2"] },
  { revision_id: "r5", parent_revision_ids: ["r3"] },
  { revision_id: "r6", parent_revision_ids: ["r4"] },
];

// ── exact-count / transitive-closure tests — analogous to SPB's precise
//    pipeline.test.ts assertions on descendantsOf, not the looser mounted-
//    component check ──

check("descendantsOfRevision(r1) reaches every later revision", () => {
  assert.deepEqual(descendantsOfRevision("r1", lineage).sort(), ["r2", "r3", "r4", "r5", "r6"]);
});

check("descendantsOfRevision(r2) covers both branches", () => {
  assert.deepEqual(descendantsOfRevision("r2", lineage).sort(), ["r3", "r4", "r5", "r6"]);
});

check("descendantsOfRevision(r5) is empty — a leaf has no descendants", () => {
  assert.deepEqual(descendantsOfRevision("r5", lineage), []);
});

check("markStale(r2) includes r2 itself plus all four downstream revisions", () => {
  assert.deepEqual([...markStale("r2", lineage)].sort(), ["r2", "r3", "r4", "r5", "r6"]);
});

// ── the sibling / must-not-fire case — this is the one SPB's suite could
//    never construct, and the one the action plan calls out as new, not
//    ported ──

check("editing r3's branch does NOT stale r4's branch (siblings, no shared descent)", () => {
  const staleFromR3 = markStale("r3", lineage);
  assert.equal(staleFromR3.has("r4"), false);
  assert.equal(staleFromR3.has("r6"), false);
  // and the reverse direction holds too
  const staleFromR4 = markStale("r4", lineage);
  assert.equal(staleFromR4.has("r3"), false);
  assert.equal(staleFromR4.has("r5"), false);
});

check("editing r3 stales r3 and r5 only — precise, not a full reset", () => {
  assert.deepEqual([...markStale("r3", lineage)].sort(), ["r3", "r5"]);
});

// ── mutation-probe-shaped check: simulate the exact old bug (full reset —
//    "cascades by array position") and confirm THIS suite would have caught
//    it, which is the actual point of porting the precise test over the
//    loose one ──

check("a full-reset implementation would fail the sibling assertion above", () => {
  const fullReset = (_revisionId: string, all: readonly RevisionEntry[]) =>
    new Set(all.map((e) => e.revision_id)); // the old bug: everything goes stale
  const wouldBeStale = fullReset("r3", lineage);
  assert.equal(wouldBeStale.has("r4"), true); // proves the buggy version WOULD wrongly stale r4
});

console.log(`\n${passed}/${passed} checks passed`);
