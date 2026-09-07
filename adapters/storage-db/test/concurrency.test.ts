import { describe, it, expect, afterEach, vi } from "vitest";
import { version } from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The check-then-act race a repository audit found: `append` and `commitManifest` each
 * checked "does the other mode already exist for this run?" as a bare `SELECT`, then wrote in
 * a SEPARATE statement (or, for `commitManifest`, a transaction opened only after the checks).
 * Two bare autocommit statements are two separate SQLite transactions — WAL readers are never
 * blocked by a writer, so a concurrent `commitManifest()` for the same run_id could start, run
 * to completion, and COMMIT entirely inside the gap between `append`'s own SELECT and its
 * INSERT. The header's claim ("SQLite's WAL mode provides serialised writes... across
 * processes") did not hold for this specific gap.
 *
 * ## Why this file cannot force the historical race directly
 *
 * `append`/`commitManifest`/`markStale` have no `await` between their check and their write —
 * deliberately, so the whole thing is one synchronous unit from Node's perspective. That means
 * there is no point a test can pause a REAL call at to interleave another call's effects into
 * the middle of it, in-process. Two `worker_threads`, each hammering a real file-backed store
 * at high volume (thousands of iterations), were tried and did not reproduce a single
 * corruption even against the UNFIXED code — the individual statements complete in
 * microseconds, faster than cross-core scheduling drift reliably lines two operations up
 * against the same run_id at the exact wrong instant. That absence is not evidence the race is
 * safe; it is evidence the window is narrow, which is a reason to fix it by construction
 * rather than a reason it needs no fix.
 *
 * What CAN be shown deterministically, with no timing dependency at all, is the mechanism
 * itself: two real connections to the same file, with the exact statements each method issues,
 * called in a chosen order. That is not a simulation of concurrency — cross-connection SQLite
 * locking is enforced by the library and the OS regardless of which thread or process issued a
 * statement, so two `DatabaseSync` handles on one file reproduce the real locking behaviour
 * exactly. Choosing the order is what a real race does by chance; here it is done on purpose,
 * once, to show what the fix closes.
 */

const NODE_MAJOR = Number(version.split(".")[0].replace("v", ""));

if (NODE_MAJOR < 22) {
  describe.skip("storage-db concurrency (requires Node 22+)", () => {
    it(`skipped - current Node ${version} does not have node:sqlite`, () => {});
  });
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { DbRevisionStore } = await import("../src/index.js");
  type RevisionEntry = import("../../../contracts/index.js").RevisionEntry;

  const T0 = 1_760_000_000_000;

  function entry(run_id: string, revision_id: string, minute = 0): RevisionEntry {
    return {
      revision_id, run_id, stage_id: "compile", parent_revision_ids: [],
      timestamp: new Date(T0 + minute * 60_000).toISOString(),
      stage_attempt: 1, input_hash: "a".repeat(64), output_hash: "b".repeat(64),
      input_ref: null, output_ref: null, gate_results: [], freshness: "FRESH",
      status: "SUCCEEDED", provider_used: null,
      execution_provenance: {
        core_build_hash: "test", contract_versions: { "revision-entry": "2.0.0" },
        provider_model_fingerprint: null, config_fingerprint: null,
      },
      retention_scope: "DB",
    } as RevisionEntry;
  }

  const insertRevisionSql = `
    INSERT INTO revisions
      (revision_id, run_id, stage_id, parent_ids, timestamp, stage_attempt,
       feedback_round, input_hash, output_hash, input_ref, output_ref,
       gate_results, freshness, status, provider_used, provenance, retention_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  function insertRevision(db: InstanceType<typeof DatabaseSync>, e: RevisionEntry): void {
    db.prepare(insertRevisionSql).run(
      e.revision_id, e.run_id, e.stage_id, JSON.stringify(e.parent_revision_ids), e.timestamp,
      e.stage_attempt ?? null, null, e.input_hash, e.output_hash, e.input_ref, e.output_ref,
      JSON.stringify(e.gate_results), e.freshness, e.status, e.provider_used,
      JSON.stringify(e.execution_provenance), e.retention_scope,
    );
  }

  const temps: string[] = [];
  afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "pnx-storagedb-"));
    temps.push(dir);
    return join(dir, "race.db");
  }

  describe("the mechanism a bare check-then-write race exploits", () => {
    it("two bare autocommit statements let a concurrent commit land in between them", () => {
      // Manually replays exactly the two statements the UNFIXED append() issued — a SELECT,
      // then an INSERT, each its own autocommit transaction — with a full, real, committed
      // commitManifest()-shaped sequence from a SECOND connection landing in the gap between
      // them. This is the defect this file's fix closes; kept as a permanent record of why the
      // fix is necessary; it does not exercise DbRevisionStore directly, since the point is
      // that no wrapping call is what made this possible.
      const path = tempDbPath();
      const run_id = "race-1";

      const a = new DatabaseSync(path);
      a.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      a.exec(`CREATE TABLE revisions (revision_id TEXT PRIMARY KEY, run_id TEXT, stage_id TEXT,
        parent_ids TEXT, timestamp TEXT, stage_attempt INTEGER, feedback_round INTEGER,
        input_hash TEXT, output_hash TEXT, input_ref TEXT, output_ref TEXT, gate_results TEXT,
        freshness TEXT, status TEXT, provider_used TEXT, provenance TEXT, retention_scope TEXT);
        CREATE TABLE manifests (run_id TEXT PRIMARY KEY, manifest_ver TEXT, created_at TEXT,
        committed_at TEXT, content_refs TEXT);`);

      const b = new DatabaseSync(path);
      b.exec("PRAGMA busy_timeout=5000;");

      // A's check (as append()'s bare SELECT would): correctly sees no manifest, at this instant.
      expect(a.prepare("SELECT 1 FROM manifests WHERE run_id = ?").get(run_id)).toBeUndefined();

      // B's ENTIRE commitManifest() for the SAME run_id completes and commits, in full, before
      // A's write — exactly what a second process could do in the gap a bare check-then-write
      // leaves open.
      b.exec("BEGIN IMMEDIATE");
      insertRevision(b, entry(run_id, "manifest-rev"));
      b.prepare(
        "INSERT INTO manifests (run_id, manifest_ver, created_at, committed_at, content_refs) VALUES (?, ?, ?, ?, ?)",
      ).run(run_id, "1.0.0", new Date(T0).toISOString(), new Date(T0 + 1000).toISOString(), "[]");
      b.exec("COMMIT");

      // A now writes on its stale decision — the bare INSERT append() would have issued next.
      insertRevision(a, entry(run_id, "append-rev"));

      // Corrupt: the run has a manifest AND a revision the manifest never declared.
      expect(a.prepare("SELECT 1 FROM manifests WHERE run_id = ?").get(run_id)).toBeDefined();
      const revisionIds = (a.prepare("SELECT revision_id FROM revisions WHERE run_id = ? ORDER BY revision_id").all(run_id) as { revision_id: string }[]).map((r) => r.revision_id);
      expect(revisionIds).toEqual(["append-rev", "manifest-rev"]);

      a.close();
      b.close();
    });

    it("BEGIN IMMEDIATE makes that same interleaving impossible to construct", () => {
      // The fixed pattern: the check moves inside a transaction opened with BEGIN IMMEDIATE,
      // which takes the RESERVED lock before the check runs. A second writer's own BEGIN
      // IMMEDIATE for the same file cannot even START until this one commits or rolls back —
      // so there is no window left for B's full cycle to land inside.
      const path = tempDbPath();
      const run_id = "race-2";

      const a = new DatabaseSync(path);
      a.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;");
      a.exec(`CREATE TABLE revisions (revision_id TEXT PRIMARY KEY, run_id TEXT, stage_id TEXT,
        parent_ids TEXT, timestamp TEXT, stage_attempt INTEGER, feedback_round INTEGER,
        input_hash TEXT, output_hash TEXT, input_ref TEXT, output_ref TEXT, gate_results TEXT,
        freshness TEXT, status TEXT, provider_used TEXT, provenance TEXT, retention_scope TEXT);
        CREATE TABLE manifests (run_id TEXT PRIMARY KEY, manifest_ver TEXT, created_at TEXT,
        committed_at TEXT, content_refs TEXT);`);

      const b = new DatabaseSync(path);
      b.exec("PRAGMA busy_timeout=100;");

      a.exec("BEGIN IMMEDIATE");
      expect(a.prepare("SELECT 1 FROM manifests WHERE run_id = ?").get(run_id)).toBeUndefined();

      // B cannot even acquire the floor to begin its own check-and-write while A holds it —
      // the exact gap the previous test walked through by hand no longer exists to walk through.
      expect(() => b.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);

      insertRevision(a, entry(run_id, "append-rev"));
      a.exec("COMMIT");

      // Only now can B proceed, and its check correctly finds A's revision and would refuse.
      b.exec("BEGIN IMMEDIATE");
      const n = (b.prepare("SELECT COUNT(*) AS n FROM revisions WHERE run_id = ?").get(run_id) as { n: number }).n;
      expect(n).toBe(1);
      b.exec("ROLLBACK");

      a.close();
      b.close();
    });
  });

  describe("the mechanism evict()'s own bare check-then-delete exploited", () => {
    // `evict()` used to run AFTER append()'s transaction committed: a bare SELECT deciding
    // which runs are oldest, then bare DELETEs acting on that decision -- the exact
    // check-then-write shape the rest of this file exists to warn about, in the one place
    // that runs after every single append. A second connection's real, correctly-protected
    // append() to one of the "doomed" runs could land and commit entirely inside the gap
    // between evict()'s SELECT and its DELETE, and evict() would then destroy that
    // freshly-committed revision along with the one that was actually stale.
    const schema = `CREATE TABLE revisions (revision_id TEXT PRIMARY KEY, run_id TEXT, stage_id TEXT,
      parent_ids TEXT, timestamp TEXT, stage_attempt INTEGER, feedback_round INTEGER,
      input_hash TEXT, output_hash TEXT, input_ref TEXT, output_ref TEXT, gate_results TEXT,
      freshness TEXT, status TEXT, provider_used TEXT, provenance TEXT, retention_scope TEXT);
      CREATE TABLE manifests (run_id TEXT PRIMARY KEY, manifest_ver TEXT, created_at TEXT,
      committed_at TEXT, content_refs TEXT);`;
    const evictSelectSql = "SELECT run_id FROM revisions GROUP BY run_id ORDER BY MAX(timestamp) ASC";

    it("a concurrent append to a doomed run is destroyed when eviction runs after commit", () => {
      const path = tempDbPath();
      const a = new DatabaseSync(path);
      a.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      a.exec(schema);
      insertRevision(a, entry("old-1", "old-1-rev", 0));

      const b = new DatabaseSync(path);
      b.exec("PRAGMA busy_timeout=5000;");

      // A's evict(), as it ran before the fix: a bare SELECT deciding which run is oldest,
      // separate from the DELETE that acts on the decision.
      const doomed = (a.prepare(evictSelectSql).all() as { run_id: string }[]).map((r) => r.run_id);
      expect(doomed).toEqual(["old-1"]);

      // B's ENTIRE append() to that same run completes and commits, in full, before A's
      // DELETE -- exactly what a second process's real, BEGIN-IMMEDIATE-protected append()
      // could do in the gap the old evict()-after-commit left open.
      b.exec("BEGIN IMMEDIATE");
      insertRevision(b, entry("old-1", "fresh-from-b", 5));
      b.exec("COMMIT");

      // A now deletes on its stale decision -- the bare DELETE the old evict() would issue.
      const ph = doomed.map(() => "?").join(", ");
      a.prepare(`DELETE FROM revisions WHERE run_id IN (${ph})`).run(...doomed);

      // B's freshly-committed revision is gone, silently, along with the one that was
      // genuinely stale -- B has no way to know its successful write vanished.
      const remaining = a.prepare("SELECT COUNT(*) AS n FROM revisions WHERE run_id = ?").get("old-1") as { n: number };
      expect(remaining.n).toBe(0);

      a.close();
      b.close();
    });

    it("running eviction inside the write's own transaction makes that same interleaving impossible", () => {
      const path = tempDbPath();
      const a = new DatabaseSync(path);
      a.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;");
      a.exec(schema);
      insertRevision(a, entry("old-1", "old-1-rev", 0));

      const b = new DatabaseSync(path);
      b.exec("PRAGMA busy_timeout=100;");

      // The fixed shape: eviction's SELECT and its DELETE both run inside the same BEGIN
      // IMMEDIATE as the write that triggered it, exactly as `append()` now does.
      a.exec("BEGIN IMMEDIATE");
      const doomed = (a.prepare(evictSelectSql).all() as { run_id: string }[]).map((r) => r.run_id);

      // B cannot even acquire the floor to append to "old-1" while A holds it -- the exact
      // window the previous test walked through by hand no longer exists to walk through.
      expect(() => b.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);

      const ph = doomed.map(() => "?").join(", ");
      a.prepare(`DELETE FROM revisions WHERE run_id IN (${ph})`).run(...doomed);
      a.exec("COMMIT");

      // Only now can B proceed, appending to what eviction left as a clean slate.
      b.exec("BEGIN IMMEDIATE");
      insertRevision(b, entry("old-1", "fresh-from-b", 5));
      b.exec("COMMIT");
      const n = (b.prepare("SELECT COUNT(*) AS n FROM revisions WHERE run_id = ?").get("old-1") as { n: number }).n;
      expect(n).toBe(1); // B's write survives -- nothing could land in the gap to destroy it.

      a.close();
      b.close();
    });
  });

  describe("a failed write leaves the store usable and leaves no partial state", () => {
    it("append: a duplicate revision_id rolls back and does not wedge the connection", async () => {
      const store = new DbRevisionStore(":memory:");
      await store.append(entry("r1", "dup"));
      await expect(store.append(entry("r1", "dup"))).rejects.toThrow();
      // The failed call must not leave the connection stuck inside an open transaction --
      // proven by a completely unrelated subsequent call succeeding normally.
      await store.append(entry("r2", "fine"));
      expect(await store.getRun("r2")).toHaveLength(1);
      store.close();
    });

    it("append: a failure inside eviction rolls back the revision that triggered it too", async () => {
      // Exercises the real class, unlike the two mechanism tests above: proves eviction runs
      // INSIDE append()'s transaction rather than after it, by forcing eviction's own query to
      // throw and checking that the revision which triggered it never got committed either. If
      // evict() were ever moved back to running after COMMIT, this revision WOULD survive the
      // eviction failure, and this assertion would fail.
      const store = new DbRevisionStore(":memory:", 1); // max=1, so a second run triggers eviction
      await store.append(entry("old", "old-rev", 0));

      const db = (store as unknown as { db: { prepare: (sql: string) => unknown } }).db;
      const real = db.prepare.bind(db);
      const evictionFailure = new Error("simulated eviction failure");
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("GROUP BY run_id") && sql.includes("ORDER BY MAX(timestamp)")) {
          throw evictionFailure;
        }
        return real(sql);
      });

      await expect(store.append(entry("new", "new-rev", 1))).rejects.toThrow(evictionFailure);
      spy.mockRestore();

      // The revision that triggered the failing eviction must not have been committed either.
      expect(await store.getRun("new")).toEqual([]);
      // And the transaction was cleanly rolled back, not left open.
      await store.append(entry("r6", "fine"));
      expect(await store.getRun("r6")).toHaveLength(1);
      store.close();
    });

    it("commitManifest: a duplicate revision_id mid-manifest rolls back every row, not just the failing one", async () => {
      const store = new DbRevisionStore(":memory:");
      await store.append(entry("prior", "dup"));
      await expect(store.commitManifest({
        manifest_version: "1.0.0",
        run_id: "m1",
        created_at: new Date(T0).toISOString(),
        committed_at: new Date(T0 + 1000).toISOString(),
        // "dup" collides with the PRIMARY KEY already used above; it is the SECOND row, so a
        // working transaction must undo the FIRST row's insert too, not only refuse the second.
        revisions: [entry("m1", "m1-first"), entry("m1", "dup")],
        content_refs: [],
      })).rejects.toThrow();
      expect(await store.getRun("m1")).toEqual([]);
      // And the store is still usable.
      await store.append(entry("r3", "fine"));
      expect(await store.getRun("r3")).toHaveLength(1);
      store.close();
    });

    it("markStale: an unlineaged-bundle refusal does not wedge the connection", async () => {
      const store = new DbRevisionStore(":memory:");
      const unlineaged = { ...entry("u1", "rev-1") };
      delete (unlineaged as { parent_revision_ids?: unknown }).parent_revision_ids;
      await store.append(unlineaged as RevisionEntry);
      await expect(store.markStale("u1", "rev-1")).rejects.toThrow(/unlineaged/);
      await store.append(entry("r4", "fine"));
      expect(await store.getRun("r4")).toHaveLength(1);
      store.close();
    });
  });
}
