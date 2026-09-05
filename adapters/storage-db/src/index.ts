/**
 * storage-db — a RevisionStore backed by SQLite (node:sqlite, built-in since Node 22).
 *
 * Why SQLite instead of the filesystem:
 *   storage-local serialises appends with an in-process promise chain, which protects
 *   concurrent callers WITHIN one process but not across processes. Two CLI invocations
 *   sharing the same store can still interleave reads and writes. SQLite's WAL mode
 *   provides serialised writes with shared reads across processes at the OS level, which
 *   is the guarantee storage-local's header names as beyond its reach.
 *
 * Schema: two tables.
 *   revisions — one row per RevisionEntry regardless of mode (legacy or committed manifest).
 *   manifests — one row per run that has been commitManifest'd; its presence marks the run
 *               immutable. A run appears in revisions via EITHER append OR commitManifest,
 *               never both. That one-mode-per-run invariant is enforced on every write path.
 *
 * Eviction: oldest MAX_BUNDLES runs by last_timestamp are kept; excess runs are deleted
 * whole. Same bound and policy as storage-local, now enforced by a SQL DELETE.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  RevisionEntry,
  RevisionStore,
  RunBundleSummary,
  RunManifest,
} from "../../../contracts/index.js";

const MAX_BUNDLES = 8;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS revisions (
  revision_id     TEXT NOT NULL PRIMARY KEY,
  run_id          TEXT NOT NULL,
  stage_id        TEXT NOT NULL,
  parent_ids      TEXT,
  timestamp       TEXT NOT NULL,
  stage_attempt   INTEGER,
  feedback_round  INTEGER,
  input_hash      TEXT NOT NULL,
  output_hash     TEXT NOT NULL,
  input_ref       TEXT,
  output_ref      TEXT,
  gate_results    TEXT NOT NULL,
  freshness       TEXT NOT NULL,
  status          TEXT NOT NULL,
  provider_used   TEXT,
  provenance      TEXT NOT NULL,
  retention_scope TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rev_run_id    ON revisions (run_id);
CREATE INDEX IF NOT EXISTS idx_rev_timestamp ON revisions (timestamp DESC);

CREATE TABLE IF NOT EXISTS manifests (
  run_id       TEXT NOT NULL PRIMARY KEY,
  manifest_ver TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  content_refs TEXT NOT NULL
);
`;

type DbRow = Record<string, string | number | null>;

function pack(e: RevisionEntry): DbRow {
  return {
    revision_id:     e.revision_id,
    run_id:          e.run_id,
    stage_id:        e.stage_id,
    parent_ids:      Array.isArray(e.parent_revision_ids) ? JSON.stringify(e.parent_revision_ids) : null,
    timestamp:       e.timestamp,
    stage_attempt:   e.stage_attempt ?? null,
    feedback_round:  e.feedback_round ?? null,
    input_hash:      e.input_hash,
    output_hash:     e.output_hash,
    input_ref:       e.input_ref ?? null,
    output_ref:      e.output_ref ?? null,
    gate_results:    JSON.stringify(e.gate_results),
    freshness:       e.freshness,
    status:          e.status,
    provider_used:   e.provider_used ?? null,
    provenance:      JSON.stringify(e.execution_provenance),
    retention_scope: e.retention_scope,
  };
}

function unpack(r: DbRow): RevisionEntry {
  return {
    revision_id:          r.revision_id as string,
    run_id:               r.run_id as string,
    stage_id:             r.stage_id as string,
    parent_revision_ids:  r.parent_ids != null ? JSON.parse(r.parent_ids as string) as string[] : undefined as unknown as string[],
    timestamp:            r.timestamp as string,
    stage_attempt:        r.stage_attempt as number | undefined,
    feedback_round:       r.feedback_round as number | undefined,
    input_hash:           r.input_hash as string,
    output_hash:          r.output_hash as string,
    input_ref:            r.input_ref as string | null,
    output_ref:           r.output_ref as string | null,
    gate_results:         JSON.parse(r.gate_results as string) as unknown[],
    freshness:            r.freshness as "FRESH" | "STALE",
    status:               r.status as RevisionEntry["status"],
    provider_used:        r.provider_used as string | null,
    execution_provenance: JSON.parse(r.provenance as string) as object,
    retention_scope:      r.retention_scope as RevisionEntry["retention_scope"],
  } as RevisionEntry;
}

export class DbRevisionStore implements RevisionStore {
  private readonly db: DatabaseSync;
  private readonly max: number;

  constructor(dbPath: string, maxBundles = MAX_BUNDLES) {
    this.db = new DatabaseSync(dbPath);
    this.max = maxBundles;
    this.db.exec(SCHEMA);
  }

  async append(entry: RevisionEntry): Promise<void> {
    if (this.db.prepare("SELECT 1 FROM manifests WHERE run_id = ?").get(entry.run_id)) {
      throw new Error(
        `mixed-lineage: run "${entry.run_id}" is a committed manifest; append is refused.`,
      );
    }
    const r = pack(entry);
    this.db.prepare(`
      INSERT INTO revisions
        (revision_id, run_id, stage_id, parent_ids, timestamp, stage_attempt,
         feedback_round, input_hash, output_hash, input_ref, output_ref,
         gate_results, freshness, status, provider_used, provenance, retention_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.revision_id, r.run_id, r.stage_id, r.parent_ids, r.timestamp,
      r.stage_attempt, r.feedback_round, r.input_hash, r.output_hash,
      r.input_ref, r.output_ref, r.gate_results, r.freshness, r.status,
      r.provider_used, r.provenance, r.retention_scope,
    );
    this.evict();
  }

  async getRun(run_id: string): Promise<RevisionEntry[]> {
    const rows = this.db.prepare(
      "SELECT * FROM revisions WHERE run_id = ? ORDER BY timestamp ASC",
    ).all(run_id) as DbRow[];
    return rows.map(unpack);
  }

  async listRecent(limit: number): Promise<RunBundleSummary[]> {
    const rows = this.db.prepare(`
      SELECT
        run_id,
        MIN(timestamp) AS first_timestamp,
        MAX(timestamp) AS last_timestamp,
        COUNT(*)       AS entries
      FROM revisions
      GROUP BY run_id
      ORDER BY MAX(timestamp) DESC
      LIMIT ?
    `).all(limit) as { run_id: string; first_timestamp: string; last_timestamp: string; entries: number }[];
    return rows.map((r) => ({
      run_id:          r.run_id,
      first_timestamp: r.first_timestamp,
      last_timestamp:  r.last_timestamp,
      entries:         Number(r.entries),
    }));
  }

  async markStale(run_id: string, from_revision_id: string): Promise<void> {
    if (this.db.prepare("SELECT 1 FROM manifests WHERE run_id = ?").get(run_id)) {
      throw new Error(
        `immutable manifest: run "${run_id}" is committed; markStale would mutate history.`,
      );
    }

    const bundle = await this.getRun(run_id);
    if (!bundle.some((e) => e.revision_id === from_revision_id)) return;

    const unlineaged = bundle.filter((e) => !Array.isArray(e.parent_revision_ids));
    if (unlineaged.length > 0) {
      throw new Error(
        `unlineaged bundle: run "${run_id}" has ${unlineaged.length} of ${bundle.length} revision(s) ` +
        `with no parent_revision_ids. Written before contract 1.3.1; cascade cannot be computed.`,
      );
    }

    const stale = new Set<string>([from_revision_id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of bundle) {
        if (stale.has(e.revision_id)) continue;
        if (e.parent_revision_ids.some((p) => stale.has(p))) {
          stale.add(e.revision_id);
          grew = true;
        }
      }
    }

    const ids = [...stale];
    const ph = ids.map(() => "?").join(", ");
    this.db.prepare(
      `UPDATE revisions SET freshness = 'STALE' WHERE run_id = ? AND revision_id IN (${ph})`,
    ).run(run_id, ...ids);
  }

  async commitManifest(manifest: RunManifest): Promise<void> {
    validateManifest(manifest);

    if (this.db.prepare("SELECT 1 FROM manifests WHERE run_id = ?").get(manifest.run_id)) {
      throw new Error(`immutable manifest: run "${manifest.run_id}" is already published.`);
    }
    const { n } = this.db.prepare(
      "SELECT COUNT(*) AS n FROM revisions WHERE run_id = ?",
    ).get(manifest.run_id) as { n: number };
    if (n > 0) {
      throw new Error(
        `mixed-lineage: run "${manifest.run_id}" already has revisions; commitManifest is refused.`,
      );
    }

    const insertRev = this.db.prepare(`
      INSERT INTO revisions
        (revision_id, run_id, stage_id, parent_ids, timestamp, stage_attempt,
         feedback_round, input_hash, output_hash, input_ref, output_ref,
         gate_results, freshness, status, provider_used, provenance, retention_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertManifest = this.db.prepare(
      "INSERT INTO manifests (run_id, manifest_ver, created_at, committed_at, content_refs) VALUES (?, ?, ?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      for (const e of manifest.revisions) {
        const r = pack(e);
        insertRev.run(
          r.revision_id, r.run_id, r.stage_id, r.parent_ids, r.timestamp,
          r.stage_attempt, r.feedback_round, r.input_hash, r.output_hash,
          r.input_ref, r.output_ref, r.gate_results, r.freshness, r.status,
          r.provider_used, r.provenance, r.retention_scope,
        );
      }
      insertManifest.run(
        manifest.run_id,
        manifest.manifest_version,
        manifest.created_at,
        manifest.committed_at,
        JSON.stringify(manifest.content_refs),
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private evict(): void {
    const bundles = this.db.prepare(`
      SELECT run_id FROM revisions
      GROUP BY run_id
      ORDER BY MAX(timestamp) ASC
    `).all() as { run_id: string }[];

    if (bundles.length <= this.max) return;

    const doomed = bundles.slice(0, bundles.length - this.max).map((b) => b.run_id);
    const ph = doomed.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM revisions WHERE run_id IN (${ph})`).run(...doomed);
    this.db.prepare(`DELETE FROM manifests WHERE run_id IN (${ph})`).run(...doomed);
  }
}

function validateManifest(manifest: RunManifest): void {
  if (manifest.manifest_version !== "1.0.0") {
    throw new Error(`invalid manifest: unsupported manifest_version "${manifest.manifest_version}".`);
  }
  if (!Array.isArray(manifest.revisions) || manifest.revisions.length === 0) {
    throw new Error("invalid manifest: revisions must be a non-empty array.");
  }
  if (!Number.isFinite(Date.parse(manifest.created_at)) || !Number.isFinite(Date.parse(manifest.committed_at))) {
    throw new Error("invalid manifest: created_at/committed_at must be ISO timestamps.");
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const r of manifest.revisions) {
    if (!r || typeof r.revision_id !== "string" || r.revision_id.length === 0) {
      throw new Error("invalid manifest: every revision needs a revision_id.");
    }
    if (r.run_id !== manifest.run_id) {
      throw new Error(
        `invalid manifest: revision "${r.revision_id}" carries run_id "${r.run_id}", expected "${manifest.run_id}".`,
      );
    }
    if (ids.has(r.revision_id)) {
      throw new Error(`invalid manifest: duplicate revision_id "${r.revision_id}".`);
    }
    ids.add(r.revision_id);
    if (!Number.isFinite(Date.parse(r.timestamp))) {
      throw new Error(`invalid manifest: revision "${r.revision_id}" has a non-ISO timestamp.`);
    }
    for (const ref of [r.input_ref, r.output_ref]) {
      if (ref !== null && ref !== undefined) refs.add(ref);
    }
  }
  if (!Array.isArray(manifest.content_refs)) {
    throw new Error("invalid manifest: content_refs must be an array.");
  }
  const declared = new Set(manifest.content_refs);
  if (declared.size !== manifest.content_refs.length) {
    throw new Error("invalid manifest: content_refs contains duplicates.");
  }
  for (const ref of refs) {
    if (!declared.has(ref)) {
      throw new Error(`invalid manifest: referenced content "${ref}" is missing from content_refs.`);
    }
  }
  for (const ref of declared) {
    if (!refs.has(ref)) {
      throw new Error(`invalid manifest: content_refs entry "${ref}" is cited by no revision.`);
    }
  }
}
