/**
 * evidence-local — an EvidenceStore backed by one file per record.
 *
 * The evidence plane holds what the system knows: `EvalRun`s, `Comparison`s, `Baseline`s
 * and `Promotion`s. Until now those had schemas and no home — every run was computed and
 * thrown away, so "is this configuration better than the one we shipped in August?" had no
 * artifact to consult.
 *
 * ── Immutability is enforced by the filesystem, not by a check ────────────────
 *
 * `put` opens with the `wx` flag, so a second write under the same `(kind, id)` fails in
 * the syscall. Nothing reads-then-writes, which matters for two reasons:
 *
 *  - a check-then-write has a window between the two, and the concurrency proposition in
 *    the corpus is specifically that file-level locking serialises the write but not the
 *    read-compute-write cycle. `wx` has no cycle to interleave.
 *  - `storage-local` does read-modify-write per append, eleven times per run. Two
 *    concurrent runs there already race. This plane does not repeat that shape.
 *
 * ── One file per record, not one bundle ──────────────────────────────────────
 *
 * `storage-local` bundles a run because a partially-evicted run is worse than no run.
 * Evidence is the opposite case: each record is independently meaningful and independently
 * cited — a promotion names a run, a comparison names two — so bundling would couple
 * lifetimes that have no reason to be coupled.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  EvidenceFilter, EvidenceKind, EvidenceRecord, EvidenceStore, EvidenceSummary, RetentionScope,
} from "../../../contracts/index.js";

const KINDS: readonly EvidenceKind[] = ["eval-run", "comparison", "baseline", "promotion", "judgement"];

/**
 * Ids reach here from commands and from run output. Refuse anything that is not a plain
 * identifier rather than trusting it as a path component — the same rule, and the same
 * character class, `LocalRevisionStore` applies to `run_id`.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class LocalEvidenceStore implements EvidenceStore {
  readonly retention_scope: RetentionScope = "LOCAL_BUNDLE";

  constructor(private readonly root: string) {}

  private dirFor(kind: EvidenceKind): string {
    if (!KINDS.includes(kind)) {
      throw new Error(`Unknown evidence kind "${kind}" — expected one of ${KINDS.join(", ")}.`);
    }
    return join(this.root, kind);
  }

  private pathFor(kind: EvidenceKind, id: string): string {
    if (!SAFE_ID.test(id)) {
      throw new Error(`Refusing to use "${id}" as an evidence id — expected [A-Za-z0-9_-]{1,64}.`);
    }
    return join(this.dirFor(kind), `${id}.json`);
  }

  async put(record: EvidenceRecord): Promise<void> {
    const path = this.pathFor(record.kind, record.id);
    await mkdir(this.dirFor(record.kind), { recursive: true });
    try {
      // `wx` — fail if it exists. Not a check followed by a write; one syscall that cannot
      // be interleaved. Evidence is immutable, and this is where that stops being a promise.
      await writeFile(path, JSON.stringify(record, null, 2), { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Evidence ${record.kind}/${record.id} already exists and evidence is immutable. ` +
            `A re-run is a new run: give it a new id rather than overwriting the old one.`,
        );
      }
      throw err;
    }
  }

  async get(kind: EvidenceKind, id: string): Promise<EvidenceRecord | null> {
    const path = this.pathFor(kind, id);
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, "utf8")) as EvidenceRecord;
  }

  async list(kind: EvidenceKind, filter: EvidenceFilter = {}): Promise<EvidenceSummary[]> {
    const dir = this.dirFor(kind);
    if (!existsSync(dir)) return [];

    const summaries: EvidenceSummary[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
      let record: EvidenceRecord;
      try {
        record = JSON.parse(await readFile(join(dir, file), "utf8")) as EvidenceRecord;
      } catch {
        // A torn file is not evidence. Skipping it is right; reporting it as a record
        // whose body cannot be read would put an unreadable id into a promotion's lineage.
        continue;
      }
      if (filter.since && record.created_at < filter.since) continue;
      summaries.push({ kind: record.kind, id: record.id, created_at: record.created_at });
    }

    // Newest first, which is what every caller wants and what `listRecent` already does.
    summaries.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    return filter.limit === undefined ? summaries : summaries.slice(0, filter.limit);
  }
}
