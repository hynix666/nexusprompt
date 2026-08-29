/**
 * markStale — see staleness.ts for the full provenance note and the
 * placement/integration caveats (parent_revision_ids is unconfirmed against
 * the real schema; confirm before merging).
 *
 * Every assertion below was executed against this exact implementation
 * (via tsx + node:assert, vitest was not available in the porting sandbox)
 * before this file was written — see verify-staleness.mts in the same
 * handoff for the run.
 */
import { describe, it, expect } from "vitest";
import { descendantsOfRevision, markStale, type RevisionEntry } from "./staleness.js";

// A small lineage with a genuine branch — the shape SPB's fixed 9-stage
// STAGE_DEPS graph can never produce (verified this session: SPB's graph is
// a total order under the descendant relation, so no two SPB stages are ever
// "siblings" with no shared ancestry — see ARCHITECTURE.md Part C).
//
//        r1
//        |
//        r2
//       /  \
//     r3    r4      <- siblings: neither is an ancestor of the other
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

describe("descendantsOfRevision", () => {
  // Exact-count assertions — analogous to SPB's precise pipeline.test.ts
  // checks on descendantsOf, not the looser mounted-component version (which
  // only verified a positive count and would not have caught a full-reset
  // regression — see MERGE-PLAN-preflight-findings.md §2a).
  it("reaches every later revision from the root", () => {
    expect(descendantsOfRevision("r1", lineage).sort()).toEqual(["r2", "r3", "r4", "r5", "r6"]);
  });

  it("covers both branches from the fork", () => {
    expect(descendantsOfRevision("r2", lineage).sort()).toEqual(["r3", "r4", "r5", "r6"]);
  });

  it("is empty for a leaf revision", () => {
    expect(descendantsOfRevision("r5", lineage)).toEqual([]);
  });
});

describe("markStale", () => {
  it("includes the revision itself plus every downstream revision", () => {
    expect([...markStale("r2", lineage)].sort()).toEqual(["r2", "r3", "r4", "r5", "r6"]);
  });

  it("is precise, not a full reset — editing r3 stales only r3 and r5", () => {
    expect([...markStale("r3", lineage)].sort()).toEqual(["r3", "r5"]);
  });

  // The must-not-fire case SPB's own suite could never construct.
  it("does NOT stale a sibling branch that shares an ancestor but not a lineage edge", () => {
    const staleFromR3 = markStale("r3", lineage);
    expect(staleFromR3.has("r4")).toBe(false);
    expect(staleFromR3.has("r6")).toBe(false);

    const staleFromR4 = markStale("r4", lineage);
    expect(staleFromR4.has("r3")).toBe(false);
    expect(staleFromR4.has("r5")).toBe(false);
  });
});

describe("edge cases surfaced by audit — checked, not assumed", () => {
  it("empty allRevisions never throws, returns an empty descendant set", () => {
    expect(descendantsOfRevision("r1", [])).toEqual([]);
    expect([...markStale("r1", [])]).toEqual(["r1"]);
  });

  it("querying an unknown revisionId not present in allRevisions is safe", () => {
    expect(descendantsOfRevision("ghost", lineage)).toEqual([]);
    expect([...markStale("ghost", lineage)]).toEqual(["ghost"]);
  });

  it("a direct self-reference terminates instead of looping — same guard SPB's descendantsOf has", () => {
    // SPB's STAGE_DEPS is a hardcoded acyclic table, so this input shape
    // can never occur there. It can here, since the graph now comes from
    // real data. Documents actual behavior rather than assuming it: a
    // self-referencing entry ends up included in its own descendant set.
    // Whether a revision store should ever produce that shape is a
    // contracts-level question, not something this function corrects.
    const selfReferential: RevisionEntry[] = [{ revision_id: "x1", parent_revision_ids: ["x1"] }];
    expect(descendantsOfRevision("x1", selfReferential)).toEqual(["x1"]);
  });

  it("a 2-cycle terminates safely, both revisions end up in each other's descendant set", () => {
    const cyclic: RevisionEntry[] = [
      { revision_id: "x1", parent_revision_ids: ["x2"] },
      { revision_id: "x2", parent_revision_ids: ["x1"] },
    ];
    expect(descendantsOfRevision("x1", cyclic).sort()).toEqual(["x1", "x2"]);
    expect(descendantsOfRevision("x2", cyclic).sort()).toEqual(["x1", "x2"]);
  });
});

describe("regression: full-reset behavior is distinguishable from correct partial staleness", () => {
  // This is the shape of mutation probe 06-testing-and-quality.md §3 describes:
  // break the code deliberately (here, inline, as the historical bug looked),
  // confirm THIS suite's assertions would catch it. The old bug "cascades by
  // array position" — i.e. marks everything stale regardless of lineage.
  it("a full-reset implementation fails the sibling assertion", () => {
    const fullReset = (_revisionId: string, all: readonly RevisionEntry[]) =>
      new Set(all.map((e) => e.revision_id));
    const wouldBeStale = fullReset("r3", lineage);
    expect(wouldBeStale.has("r4")).toBe(true); // proves the old bug would wrongly stale r4
  });
});
