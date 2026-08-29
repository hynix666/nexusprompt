import assert from "node:assert/strict";
import { jsonSchemaMalformed } from "../core/src/gates/json-schema-malformed.js";
import { descendantsOfRevision, markStale, type RevisionEntry } from "../core/src/stages/staleness.js";

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
};

console.log("── staleness.ts: edge cases surfaced by the audit ──");

check("empty allRevisions never throws, returns empty descendant set", () => {
  assert.deepEqual(descendantsOfRevision("r1", []), []);
  assert.deepEqual([...markStale("r1", [])], ["r1"]);
});

check("querying an unknown revisionId (not present in allRevisions) is safe", () => {
  const lineage: RevisionEntry[] = [{ revision_id: "r1" }, { revision_id: "r2", parent_revision_ids: ["r1"] }];
  assert.deepEqual(descendantsOfRevision("ghost", lineage), []);
  assert.deepEqual([...markStale("ghost", lineage)], ["ghost"]);
});

check("a direct self-reference terminates (does not infinite-loop) — SAME guard SPB's descendantsOf has", () => {
  // SPB's STAGE_DEPS is a hardcoded acyclic table, so this input shape can
  // never occur there. NexusPrompt's real per-revision data is not
  // structurally guaranteed acyclic the way SPB's table is, so this is worth
  // an explicit, checked answer rather than an assumption.
  const selfReferential: RevisionEntry[] = [{ revision_id: "r1", parent_revision_ids: ["r1"] }];
  const result = descendantsOfRevision("r1", selfReferential);
  // Documents actual behavior: a self-referential entry IS included in its
  // own descendant set. This mirrors exactly what SPB's algorithm would do
  // given the same (SPB-impossible) input — same visited-set guard, so it's
  // not a defect introduced by porting. Whether a revision store should ever
  // be able to produce this shape is a contracts-level question, not
  // something this function should silently paper over.
  assert.deepEqual(result, ["r1"]);
});

check("a 2-cycle (r1 <-> r2) terminates safely and both end up in each other's descendant set", () => {
  const cyclic: RevisionEntry[] = [
    { revision_id: "r1", parent_revision_ids: ["r2"] },
    { revision_id: "r2", parent_revision_ids: ["r1"] },
  ];
  assert.deepEqual(descendantsOfRevision("r1", cyclic).sort(), ["r1", "r2"]);
  assert.deepEqual(descendantsOfRevision("r2", cyclic).sort(), ["r1", "r2"]);
});

console.log("\n── json-schema-malformed.ts: exact WELL_FORMED fidelity ──");

// The literal embedded schema block from SPB's real WELL_FORMED fixture
// (pipeline.test.ts:145-177), not just an equivalent standalone block —
// closes the one fidelity gap the audit found: json-schema-malformed.test.ts
// covered the *pattern* (colon inside a string value) with a similar but not
// textually identical block. This is the actual text.
const WELL_FORMED_SCHEMA_BLOCK =
  "```json\n" +
  "{\n" +
  '  "ticket_id": "string",\n' +
  '  "note": "fields like a, b: c appear inside this string value",\n' +
  '  "escalate": false\n' +
  "}\n" +
  "```";

check("the exact embedded schema block from SPB's real WELL_FORMED fixture passes", () => {
  const r = jsonSchemaMalformed(WELL_FORMED_SCHEMA_BLOCK);
  assert.equal(r.verdict, "PASS");
});

console.log(`\n${passed}/${passed} checks passed`);
