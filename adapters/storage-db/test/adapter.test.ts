import { describe, it, expect } from "vitest";
import { DbRevisionStore } from "../src/index.js";
import type { RevisionEntry, RunManifest } from "../../../contracts/index.js";

/**
 * Tests for DbRevisionStore.
 *
 * All tests use ":memory:" databases — each store is independent and
 * collected by GC when the test ends. No temp directory management needed.
 *
 * Key invariants proved here:
 *   1. append + getRun is a faithful roundtrip — all fields survive JSON packing.
 *   2. listRecent returns runs ordered by last_timestamp DESC.
 *   3. Eviction keeps exactly MAX_BUNDLES runs, oldest first.
 *   4. markStale cascades along parent_revision_ids to a fixed point.
 *   5. markStale refuses an unlineaged bundle (pre-1.3.1 data).
 *   6. commitManifest publishes atomically; append then refuses (mixed-lineage).
 *   7. append after commitManifest is refused (mixed-lineage in the other direction).
 *   8. commitManifest is idempotent-free — a second call is refused (immutable).
 *   9. markStale on a committed manifest is refused (immutable).
 *  10. Concurrent appends to one store keep every revision (SQLite serialises them).
 */

const T0 = 1_760_000_000_000;

function entry(run_id: string, revision_id: string, minute = 0, parent_ids: string[] = []): RevisionEntry {
  return {
    revision_id,
    run_id,
    stage_id: "compile",
    parent_revision_ids: parent_ids,
    timestamp: new Date(T0 + minute * 60_000).toISOString(),
    stage_attempt: 1,
    input_hash: "a".repeat(64),
    output_hash: "b".repeat(64),
    input_ref: null,
    output_ref: null,
    gate_results: [],
    freshness: "FRESH",
    status: "SUCCEEDED",
    provider_used: null,
    execution_provenance: {
      core_build_hash: "test",
      contract_versions: { "revision-entry": "2.0.0" },
      provider_model_fingerprint: null,
      config_fingerprint: null,
    },
    retention_scope: "DB",
  } as RevisionEntry;
}

function manifest(run_id: string, revisions: RevisionEntry[]): RunManifest {
  return {
    manifest_version: "1.0.0",
    run_id,
    created_at: new Date(T0).toISOString(),
    committed_at: new Date(T0 + 1000).toISOString(),
    revisions,
    content_refs: [],
  };
}

describe("DbRevisionStore — append / getRun roundtrip", () => {
  it("stores and retrieves a single entry faithfully", async () => {
    const store = new DbRevisionStore(":memory:");
    const e = entry("r1", "rev-1");
    await store.append(e);
    const got = await store.getRun("r1");
    expect(got).toHaveLength(1);
    expect(got[0].revision_id).toBe("rev-1");
    expect(got[0].run_id).toBe("r1");
    expect(got[0].parent_revision_ids).toEqual([]);
    expect(got[0].gate_results).toEqual([]);
    expect(got[0].freshness).toBe("FRESH");
    expect(got[0].status).toBe("SUCCEEDED");
    expect(got[0].retention_scope).toBe("DB");
    store.close();
  });

  it("preserves append order via timestamp", async () => {
    const store = new DbRevisionStore(":memory:");
    for (let i = 0; i < 5; i++) await store.append(entry("r1", `rev-${i}`, i));
    const got = await store.getRun("r1");
    expect(got.map((e) => e.revision_id)).toEqual(["rev-0", "rev-1", "rev-2", "rev-3", "rev-4"]);
    store.close();
  });

  it("getRun returns empty array for unknown run", async () => {
    const store = new DbRevisionStore(":memory:");
    expect(await store.getRun("unknown")).toEqual([]);
    store.close();
  });
});

describe("DbRevisionStore — listRecent", () => {
  it("returns runs sorted by last_timestamp DESC", async () => {
    const store = new DbRevisionStore(":memory:");
    await store.append(entry("old", "rev-old", 0));
    await store.append(entry("mid", "rev-mid", 5));
    await store.append(entry("new", "rev-new", 10));
    const recent = await store.listRecent(3);
    expect(recent.map((r) => r.run_id)).toEqual(["new", "mid", "old"]);
    store.close();
  });

  it("respects the limit parameter", async () => {
    const store = new DbRevisionStore(":memory:");
    for (let i = 0; i < 5; i++) await store.append(entry(`r${i}`, `rev-${i}`, i));
    expect(await store.listRecent(2)).toHaveLength(2);
    store.close();
  });

  it("entries field counts revisions in the run", async () => {
    const store = new DbRevisionStore(":memory:");
    for (let i = 0; i < 3; i++) await store.append(entry("r1", `rev-${i}`, i));
    const [summary] = await store.listRecent(1);
    expect(summary.entries).toBe(3);
    store.close();
  });
});

describe("DbRevisionStore — eviction", () => {
  it("keeps exactly maxBundles runs after overflow", async () => {
    const store = new DbRevisionStore(":memory:", 3);
    for (let i = 0; i < 5; i++) await store.append(entry(`r${i}`, `rev-${i}`, i));
    const recent = await store.listRecent(10);
    expect(recent).toHaveLength(3);
    // Oldest two (r0, r1) were evicted; newest three remain.
    expect(recent.map((r) => r.run_id)).toContain("r4");
    expect(recent.map((r) => r.run_id)).toContain("r3");
    expect(recent.map((r) => r.run_id)).toContain("r2");
    store.close();
  });

  it("evicts the oldest run, not the most recently written", async () => {
    // Mutation proof: if eviction sorted by last_timestamp DESC instead of ASC,
    // the newest run would be deleted and this assertion would fail.
    const store = new DbRevisionStore(":memory:", 1);
    await store.append(entry("old", "rev-old", 0));
    await store.append(entry("new", "rev-new", 10));
    const remaining = await store.listRecent(10);
    expect(remaining.map((r) => r.run_id)).toEqual(["new"]);
    store.close();
  });
});

describe("DbRevisionStore — markStale", () => {
  it("marks the named revision STALE", async () => {
    const store = new DbRevisionStore(":memory:");
    await store.append(entry("r1", "rev-1", 0));
    await store.markStale("r1", "rev-1");
    const [e] = await store.getRun("r1");
    expect(e.freshness).toBe("STALE");
    store.close();
  });

  it("cascades to children through parent_revision_ids", async () => {
    // rev-1 → rev-2 → rev-3 (a linear chain)
    const store = new DbRevisionStore(":memory:");
    await store.append(entry("r1", "rev-1", 0, []));
    await store.append(entry("r1", "rev-2", 1, ["rev-1"]));
    await store.append(entry("r1", "rev-3", 2, ["rev-2"]));
    await store.markStale("r1", "rev-1");
    const got = await store.getRun("r1");
    expect(got.map((e) => e.freshness)).toEqual(["STALE", "STALE", "STALE"]);
    store.close();
  });

  it("does not stale revisions outside the cascade", async () => {
    // rev-a and rev-b are independent roots; staling rev-a must not touch rev-b.
    const store = new DbRevisionStore(":memory:");
    await store.append(entry("r1", "rev-a", 0, []));
    await store.append(entry("r1", "rev-b", 1, []));
    await store.markStale("r1", "rev-a");
    const got = await store.getRun("r1");
    const byId = Object.fromEntries(got.map((e) => [e.revision_id, e.freshness]));
    expect(byId["rev-a"]).toBe("STALE");
    expect(byId["rev-b"]).toBe("FRESH");
    store.close();
  });

  it("is a no-op when the revision does not exist in the run", async () => {
    const store = new DbRevisionStore(":memory:");
    await store.append(entry("r1", "rev-1", 0));
    await expect(store.markStale("r1", "nonexistent")).resolves.toBeUndefined();
    const [e] = await store.getRun("r1");
    expect(e.freshness).toBe("FRESH");
    store.close();
  });

  it("refuses an unlineaged bundle", async () => {
    // An entry with no parent_revision_ids field (pre-1.3.1 data).
    const store = new DbRevisionStore(":memory:");
    const e = entry("r1", "rev-1", 0);
    // Simulate a pre-1.3.1 entry by removing the field after packing — we inject
    // it directly via a second store on the same DB. Because the DB stores it as
    // JSON, we write it as null and let unpack produce undefined.
    const e2 = { ...e, parent_revision_ids: undefined as unknown as string[] };
    await store.append(e2);
    await expect(store.markStale("r1", "rev-1")).rejects.toThrow(/unlineaged/);
    store.close();
  });

  it("refuses on a committed manifest", async () => {
    const store = new DbRevisionStore(":memory:");
    const e = entry("r1", "rev-1", 0);
    await store.commitManifest(manifest("r1", [e]));
    await expect(store.markStale("r1", "rev-1")).rejects.toThrow(/immutable/);
    store.close();
  });
});

describe("DbRevisionStore — commitManifest", () => {
  it("publishes revisions and makes them visible via getRun", async () => {
    const store = new DbRevisionStore(":memory:");
    const revisions = [entry("r1", "rev-1", 0), entry("r1", "rev-2", 1, ["rev-1"])];
    await store.commitManifest(manifest("r1", revisions));
    const got = await store.getRun("r1");
    expect(got).toHaveLength(2);
    expect(got.map((e) => e.revision_id)).toEqual(["rev-1", "rev-2"]);
    store.close();
  });

  it("refuses a second commitManifest for the same run (immutable)", async () => {
    const store = new DbRevisionStore(":memory:");
    const e = entry("r1", "rev-1", 0);
    await store.commitManifest(manifest("r1", [e]));
    await expect(store.commitManifest(manifest("r1", [e]))).rejects.toThrow(/immutable/);
    store.close();
  });

  it("refuses if the run already has appended revisions (mixed-lineage)", async () => {
    const store = new DbRevisionStore(":memory:");
    await store.append(entry("r1", "rev-1", 0));
    await expect(store.commitManifest(manifest("r1", [entry("r1", "rev-2", 1)]))).rejects.toThrow(/mixed-lineage/);
    store.close();
  });

  it("is atomic — a bad revision rolls back all inserts", async () => {
    const store = new DbRevisionStore(":memory:");
    const good = entry("r1", "rev-good", 0);
    // A duplicate revision_id forces a PRIMARY KEY violation on the second insert.
    const bad: RunManifest = {
      ...manifest("r1", [good, { ...good, timestamp: new Date(T0 + 1000).toISOString() }]),
    };
    await expect(store.commitManifest(bad)).rejects.toThrow();
    // The first (good) revision must not have been committed either.
    expect(await store.getRun("r1")).toHaveLength(0);
    store.close();
  });
});

describe("DbRevisionStore — mixed-lineage guard", () => {
  it("refuses append to a committed manifest", async () => {
    const store = new DbRevisionStore(":memory:");
    await store.commitManifest(manifest("r1", [entry("r1", "rev-1", 0)]));
    await expect(store.append(entry("r1", "rev-2", 1))).rejects.toThrow(/mixed-lineage/);
    store.close();
  });
});

describe("DbRevisionStore — concurrent appends", () => {
  it("loses no revisions when appends overlap in the same process", async () => {
    // SQLite serialises concurrent writes at the file level; within one process this
    // is guaranteed. Thirty is here to match the same probe count as storage-local.
    for (const n of [2, 11, 30]) {
      const store = new DbRevisionStore(":memory:");
      await Promise.all(
        Array.from({ length: n }, (_, i) => store.append(entry("r", `rev-${i}`, i))),
      );
      const kept = await store.getRun("r");
      expect(kept, `${n} concurrent appends`).toHaveLength(n);
      expect(new Set(kept.map((e) => e.revision_id)).size).toBe(n);
      store.close();
    }
  });
});
