import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEvidenceStore } from "../adapters/evidence-local/src/index.js";
import type { EvidenceRecord, EvidenceStore } from "../contracts/index.js";

/**
 * One conformance suite, run against every `EvidenceStore` in the repository.
 *
 * The `RevisionStore` port has two implementations and no shared suite: each is exercised
 * incidentally, through tests aimed at something else, so "both stores behave the same"
 * has never been checked. This port starts with the suite instead of acquiring one later.
 *
 * **Coverage is asserted, not printed.** A suite that quietly skips when an implementation
 * is absent reports a green result for work it did not do — the pattern this repository has
 * now found seven times. The last test scans `adapters/` for implementations and fails if
 * one exists that this file does not exercise, so adding `evidence-db` without adding it
 * here breaks the build rather than silently narrowing the guard.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), "pnx-evidence-")); temps.push(d); return d; };

/** Every implementation under test. Adding one here is the whole cost of covering it. */
const IMPLEMENTATIONS: Array<[name: string, make: () => EvidenceStore]> = [
  ["evidence-local", () => new LocalEvidenceStore(mkroot())],
];

const record = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  kind: "eval-run",
  id: "run-1",
  created_at: "2026-08-22T10:00:00.000Z",
  body: { run_id: "run-1", aggregate: { cases: 14, passed: 14, score: 1 } },
  ...over,
});

describe.each(IMPLEMENTATIONS)("EvidenceStore conformance — %s", (_name, make) => {
  it("round-trips a record", async () => {
    const store = make();
    await store.put(record());
    expect(await store.get("eval-run", "run-1")).toEqual(record());
  });

  it("returns null for a record that was never written", async () => {
    expect(await make().get("eval-run", "absent")).toBeNull();
  });

  it("refuses a second write under the same id", async () => {
    // Evidence is immutable. This is the property the whole plane exists for: comparison
    // across time requires that yesterday's number cannot be edited.
    const store = make();
    await store.put(record());
    await expect(store.put(record({ body: { tampered: true } }))).rejects.toThrow(/immutable/i);
    expect((await store.get("eval-run", "run-1"))!.body).toEqual(record().body);
  });

  it("keeps kinds in separate namespaces", async () => {
    // A comparison and a run may legitimately share an id; they are different records.
    const store = make();
    await store.put(record({ kind: "eval-run", id: "shared" }));
    await store.put(record({ kind: "comparison", id: "shared" }));
    expect((await store.get("eval-run", "shared"))!.kind).toBe("eval-run");
    expect((await store.get("comparison", "shared"))!.kind).toBe("comparison");
  });

  it("lists newest first", async () => {
    const store = make();
    await store.put(record({ id: "old", created_at: "2026-08-01T00:00:00.000Z" }));
    await store.put(record({ id: "new", created_at: "2026-08-20T00:00:00.000Z" }));
    expect((await store.list("eval-run")).map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("filters by since and honours a limit", async () => {
    const store = make();
    await store.put(record({ id: "a", created_at: "2026-08-01T00:00:00.000Z" }));
    await store.put(record({ id: "b", created_at: "2026-08-10T00:00:00.000Z" }));
    await store.put(record({ id: "c", created_at: "2026-08-20T00:00:00.000Z" }));
    expect((await store.list("eval-run", { since: "2026-08-05T00:00:00.000Z" })).map((s) => s.id))
      .toEqual(["c", "b"]);
    expect((await store.list("eval-run", { limit: 1 })).map((s) => s.id)).toEqual(["c"]);
  });

  it("returns an empty list for a kind nothing was written under", async () => {
    expect(await make().list("baseline")).toEqual([]);
  });

  it("declares where it retains", async () => {
    // The Application reads this rather than hardcoding a scope, which is how
    // retention_scope stopped being a literal on every RevisionEntry.
    expect(["LOCAL_BUNDLE", "DB", "EXPORT"]).toContain(make().retention_scope);
  });

  it("refuses an id that is not a plain identifier", async () => {
    // Ids reach the store from commands and from run output, and become path components.
    const store = make();
    for (const bad of ["../escape", "a/b", "", "x".repeat(65)]) {
      await expect(store.put(record({ id: bad }))).rejects.toThrow();
    }
  });

  it("survives concurrent writes of distinct records", async () => {
    // No read-modify-write, so there is no cycle to interleave. storage-local does one per
    // append, eleven times a run, and two concurrent runs there already race.
    const store = make();
    await Promise.all(Array.from({ length: 32 }, (_, i) => store.put(record({ id: `r${i}` }))));
    expect(await store.list("eval-run")).toHaveLength(32);
  });

  it("lets exactly one writer win a concurrent race for the same id", async () => {
    const store = make();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.put(record({ id: "contested" }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("skips a torn file rather than reporting an unreadable record", async () => {
    // A half-written file is not evidence. Listing it would put an id whose body cannot be
    // read into a promotion's lineage.
    const root = mkroot();
    const store = new LocalEvidenceStore(root);
    await store.put(record());
    mkdirSync(join(root, "eval-run"), { recursive: true });
    writeFileSync(join(root, "eval-run", "torn.json"), '{"kind":"eval-run",');
    expect((await store.list("eval-run")).map((s) => s.id)).toEqual(["run-1"]);
  });
});

describe("EvidenceStore conformance covers every implementation", () => {
  it("exercises each adapter that implements the port", () => {
    const covered = new Set(IMPLEMENTATIONS.map(([name]) => name));
    const found = readdirSync("adapters", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => {
        try {
          return readFileSync(join("adapters", e.name, "src/index.ts"), "utf8")
            .includes("implements EvidenceStore");
        } catch { return false; }
      })
      .map((e) => e.name);

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((name) => !covered.has(name))).toEqual([]);
  });
});
