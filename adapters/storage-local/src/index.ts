/**
 * storage-local — a RevisionStore that retains complete run bundles.
 *
 * The bound is eight *bundles*, not eight entries. The source counted entries
 * and capped at 8, which could not hold a nine-stage run; the pipeline is now
 * eleven stages. Any entry-based bound is a hostage to stage count, so a run is
 * retained or evicted whole.
 */

import { mkdir, readFile, readdir, writeFile, rename, link } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  RevisionEntry,
  RevisionStore,
  RunBundleSummary,
  RunManifest,
} from "../../../contracts/index.js";

const MAX_BUNDLES = 8;

/**
 * One promise chain per run id, so appends to the same bundle cannot interleave.
 *
 * `append` is read → parse → push → write. Sweep fifteen measured what that costs without
 * serialisation: **two** concurrent appends kept one entry and silently dropped the other;
 * eleven kept three; thirty kept two. Revisions vanished with no error anywhere, and once
 * content retention landed those revisions took their bodies with them — the reclaim saw
 * nothing pointing at them and deleted the lot.
 *
 * This is a per-process guard and says so. It makes the API safe for concurrent callers in one
 * process, which is what `RevisionStore` promises to anyone holding one. It does NOT make two
 * OS processes sharing a directory safe — that needs a lock file or a real database, and
 * `storage-db` is where that belongs. The atomic write below is what keeps the cross-process
 * case from producing a CORRUPT bundle rather than merely a lost entry.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * The critical section is the DIRECTORY, not one bundle.
 *
 * Keying the chain on the bundle path was the obvious choice and it was wrong: `append` mutates
 * one file, but it also calls `evict`, which reads EVERY bundle and deletes the oldest. So two
 * appends to different runs still collide — and on Windows they collide loudly, because
 * `rename` over a file another handle has open fails with `EPERM`. Measured: per-path
 * serialisation turned 0 thrown appends into 7, all `EPERM: operation not permitted, rename`,
 * while a reader in `readAll` held the target open.
 *
 * Keying on the root serialises every append to one store within this process. That is the
 * correct scope for a store whose write path spans the directory, and it costs nothing here:
 * the pipeline awaits each append anyway, and the store is bounded to eight bundles.
 */

const serialise = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const prior = chains.get(key) ?? Promise.resolve();
  // `.catch` so one failed append does not poison every later one on the same run.
  const next = prior.catch(() => {}).then(work);
  chains.set(key, next.catch(() => {}));
  return next;
};

/**
 * `rename` over an existing file, retried briefly.
 *
 * On Windows a rename onto a path another handle has open fails with `EPERM`/`EBUSY` — a
 * reader in another PROCESS, or an antivirus scanner, is enough. The in-process chain removes
 * the cause this repository can control; this covers the one it cannot. Bounded and short: if
 * a handle is still held after these attempts the error is real and gets thrown, because a
 * silent give-up would leave the temp file and lose the write.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, i * 10));
    }
  }
}

/**
 * The storage MODE of a run on disk.
 *
 * A run is either a legacy append-only `<run_id>.json` bundle or a semantic
 * `<run_id>.manifest.json` manifest — never both. `mixed` exists only as a
 * defensive state for files that appeared outside this store (a run with both
 * files is refused on read and REMOVED in both modes on eviction, never kept).
 */
type RunMode = "legacy" | "semantic" | "mixed";

/** Internal summary that carries the mode so eviction deletes the right file. */
interface ModeBundleSummary extends RunBundleSummary {
  mode: RunMode;
}

export class LocalRevisionStore implements RevisionStore {
  constructor(private readonly root: string) {}

  private bundlePath(run_id: string): string {
    // run_id reaches here from a command. Refuse anything that isn't a plain
    // identifier rather than trusting it as a path component.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(run_id)) {
      throw new Error(`Refusing to use "${run_id}" as a run id — expected [A-Za-z0-9_-]{1,64}.`);
    }
    return join(this.root, `${run_id}.json`);
  }

  /**
   * The semantic manifest path, derived from the SAME validated stem as the
   * legacy bundle: `<root>/<run_id>.manifest.json`. Composed from the run id
   * (already validated by `bundlePath`) rather than from the suffixed legacy
   * path, so the two names can never drift apart.
   */
  private manifestPath(run_id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(run_id)) {
      throw new Error(`Refusing to use "${run_id}" as a run id — expected [A-Za-z0-9_-]{1,64}.`);
    }
    return join(this.root, `${run_id}.manifest.json`);
  }

  async append(entry: RevisionEntry): Promise<void> {
    const path = this.bundlePath(entry.run_id); // validates the id before it reaches the chain
    return serialise(this.root, async () => {
      await mkdir(this.root, { recursive: true });
      // One mode per run: a run that already has a semantic manifest can never
      // grow a legacy bundle beside it — the two formats must never be merged.
      if (existsSync(this.manifestPath(entry.run_id))) {
        throw new Error(
          `mixed-lineage: run "${entry.run_id}" already has a semantic manifest; append is refused.`,
        );
      }
      const bundle = existsSync(path)
        ? (JSON.parse(await readFile(path, "utf8")) as RevisionEntry[])
        : [];
      bundle.push(entry);
      await this.writeAtomic(path, JSON.stringify(bundle, null, 2));
      await this.evict();
    });
  }

  /**
   * Validate a manifest BEFORE anything touches disk.
   *
   * Checks: version pinned to 1.0.0, valid run id matching every revision,
   * unique revision ids, non-empty revisions, unique content refs that EXACTLY
   * cover every non-null input_ref/output_ref (no duplicates, no extras, no
   * missing), and parseable ISO timestamps. Everything else (shape of each
   * revision) is the contract's job, not the adapter's.
   */
  private validateManifest(manifest: RunManifest): void {
    if (manifest.manifest_version !== "1.0.0") {
      throw new Error(`invalid manifest: unsupported manifest_version "${manifest.manifest_version}".`);
    }
    try {
      this.bundlePath(manifest.run_id); // runs the run-id grammar
    } catch {
      throw new Error(`invalid manifest: run id "${manifest.run_id}" is not a valid run id.`);
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
        if (ref !== null) refs.add(ref);
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

  /**
   * Publish a semantic run manifest ATOMICALLY.
   *
   * Runs inside the same per-root chain as `append`: the critical section is the
   * DIRECTORY (append also runs eviction, which reads every bundle), and
   * publication has exactly the same directory-wide footprint. The mode checks
   * happen INSIDE the chain — an append that won the race before us must be
   * visible here, and a manifest we publish must be seen by later appends.
   *
   * Final publication is `link`, never `rename`: rename silently replaces an
   * existing destination on POSIX, so check-then-rename leaves a window in which
   * a second commitManifest destroys the first manifest. link(2) is exclusive by
   * construction (EEXIST when the destination exists, POSIX and Windows alike),
   * so immutability is enforced by the kernel, not by a check-then-act race.
   */
  async commitManifest(manifest: RunManifest): Promise<void> {
    this.validateManifest(manifest); // before the chain: fail fast, touch nothing
    const finalPath = this.manifestPath(manifest.run_id);
    const legacyPath = this.bundlePath(manifest.run_id);
    return serialise(this.root, async () => {
      await mkdir(this.root, { recursive: true });
      if (existsSync(legacyPath)) {
        throw new Error(
          `mixed-lineage: run "${manifest.run_id}" already has a legacy bundle; commitManifest is refused.`,
        );
      }
      if (existsSync(finalPath)) {
        throw new Error(
          `immutable manifest: run "${manifest.run_id}" is already published and cannot be overwritten.`,
        );
      }
      const tempPath = `${finalPath}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(tempPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
      try {
        // Exclusive final publication: link fails with EEXIST if the final path
        // appeared after the check above (e.g. another process), and — unlike
        // rename — never replaces an existing destination on ANY platform.
        await link(tempPath, finalPath);
      } catch (err) {
        await rm(tempPath, { force: true });
        throw err;
      }
      await rm(tempPath, { force: true });
    });
  }

  /**
   * Write to a temporary name, then rename over the target.
   *
   * `writeFile` truncates and then writes, so a concurrent reader can observe an empty or
   * half-written file — sweep fifteen saw `SyntaxError: Unexpected end of JSON input` thrown
   * out of `append` itself, and a `getRun` racing a write would fail the same way. `rename`
   * within one directory is atomic, so a reader sees either the old bundle or the new one and
   * never a partial one. That property holds across processes, which the in-process chain
   * above cannot give.
   *
   * The temp name carries a uuid so two writers cannot collide on it.
   */
  private async writeAtomic(path: string, contents: string): Promise<void> {
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, contents);
    try {
      await renameWithRetry(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async getRun(run_id: string): Promise<RevisionEntry[]> {
    const path = this.bundlePath(run_id);
    const mPath = this.manifestPath(run_id);
    const legacy = existsSync(path);
    const semantic = existsSync(mPath);
    if (legacy && semantic) {
      throw new Error(`mixed-lineage: run "${run_id}" has both a legacy bundle and a semantic manifest.`);
    }
    if (semantic) {
      const manifest = JSON.parse(await readFile(mPath, "utf8")) as RunManifest;
      return manifest.revisions;
    }
    if (!legacy) return [];
    return JSON.parse(await readFile(path, "utf8")) as RevisionEntry[];
  }

  async listRecent(limit: number): Promise<RunBundleSummary[]> {
    const bundles = await this.readAll();
    return bundles
      .sort((a, b) => b.last_timestamp.localeCompare(a.last_timestamp))
      .slice(0, limit);
  }

  /**
   * Staleness cascades along LINEAGE, not append order.
   *
   * The predecessor walked the bundle with a `seen` latch keyed on `stage_id`, which was
   * wrong three ways at once and had no caller and no test to notice. It marked entries
   * stale for sitting later in the array rather than for depending on anything. It never
   * staled the originating entry. And because a reflexive run appends `refine` and `lint`
   * twice, the latch RE-ARMED on the second occurrence of the named stage instead of
   * staling it — the one shape the feature exists to handle.
   *
   * Walking `parent_revision_ids` is the fix and the reason 1.3.1 populates the field.
   * Iterate to a fixed point rather than assuming the bundle is topologically ordered: a
   * feedback jump appends a child before entries it did not descend from, so one pass in
   * array order can miss a descendant.
   *
   * `freshness` is independent of `status` — an entry stays SUCCEEDED while becoming STALE.
   */
  async markStale(run_id: string, from_revision_id: string): Promise<void> {
    // Semantic immutability first: a committed manifest can never be mutated —
    // staling entries inside it would rewrite history. A run with BOTH files is
    // refused outright (mixed-lineage), never silently treated as legacy.
    const mPath = this.manifestPath(run_id);
    const legacyPath = this.bundlePath(run_id);
    if (existsSync(mPath) && existsSync(legacyPath)) {
      throw new Error(`mixed-lineage: run "${run_id}" has both a legacy bundle and a semantic manifest.`);
    }
    if (existsSync(mPath)) {
      throw new Error(
        `immutable manifest: run "${run_id}" is a semantic manifest; markStale would mutate committed history.`,
      );
    }

    const path = legacyPath;
    if (!existsSync(path)) return;
    const bundle = JSON.parse(await readFile(path, "utf8")) as RevisionEntry[];

    const stale = new Set<string>([from_revision_id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of bundle) {
        if (stale.has(e.revision_id)) continue;
        if ((e.parent_revision_ids ?? []).some((p) => stale.has(p))) {
          stale.add(e.revision_id);
          grew = true;
        }
      }
    }

    /**
     * A revision this bundle does not contain supersedes nothing in it.
     *
     * This matters only for a DANGLING parent — an entry naming a parent the bundle lacks,
     * which a partial write or a hand-edited file can produce. Without this line that
     * entry's descendants would be staled on the strength of an id nothing here can
     * account for. With it, the answer is "no such revision", which is the truth.
     *
     * It is deliberately not phrased as protecting against staling the whole bundle: it
     * does not do that, and a probe showed the difference. An id matching no entry and no
     * parent reference already cascades to nothing; all that is saved there is a pointless
     * rewrite of an unchanged file.
     */
    if (!bundle.some((e) => e.revision_id === from_revision_id)) return;
    for (const e of bundle) if (stale.has(e.revision_id)) e.freshness = "STALE";
    await writeFile(path, JSON.stringify(bundle, null, 2));
  }

  /** Evict whole bundles, oldest first, once the count exceeds the bound. */
  private async evict(): Promise<void> {
    const bundles = await this.readAll();
    if (bundles.length <= MAX_BUNDLES) return;
    const doomed = bundles
      .sort((a, b) => a.last_timestamp.localeCompare(b.last_timestamp))
      .slice(0, bundles.length - MAX_BUNDLES);
    for (const b of doomed) {
      // Delete the file that matches the run's MODE. The old code always deleted
      // the legacy path — once manifests exist that would count them toward the
      // bound but delete a file that does not exist, silently exceeding it.
      if (b.mode === "semantic") {
        await rm(this.manifestPath(b.run_id), { force: true });
      } else {
        await rm(this.bundlePath(b.run_id), { force: true });
      }
      if (b.mode === "mixed") {
        // A mixed run must never survive eviction half-deleted: remove both.
        await rm(this.manifestPath(b.run_id), { force: true });
        await rm(this.bundlePath(b.run_id), { force: true });
      }
    }
  }

  private async readAll(): Promise<ModeBundleSummary[]> {
    if (!existsSync(this.root)) return [];
    const out: ModeBundleSummary[] = [];
    const byRun = new Map<string, ModeBundleSummary>();
    for (const f of await readdir(this.root)) {
      // Readers ignore one temp pattern: `<final>.<uuid>.tmp` — both legacy and
      // manifest temp files match this and are never counted or parsed.
      if (f.includes(".tmp.")) continue;
      let parsed: ModeBundleSummary | null = null;
      if (f.endsWith(".manifest.json")) {
        const manifest = JSON.parse(await readFile(join(this.root, f), "utf8")) as RunManifest;
        const entries = manifest.revisions;
        if (!entries.length) continue;
        parsed = {
          run_id: manifest.run_id,
          entries: entries.length,
          first_timestamp: entries[0].timestamp,
          last_timestamp: entries[entries.length - 1].timestamp,
          mode: "semantic",
        };
      } else if (f.endsWith(".json")) {
        const entries = JSON.parse(await readFile(join(this.root, f), "utf8")) as RevisionEntry[];
        if (!entries.length) continue;
        parsed = {
          run_id: entries[0].run_id,
          entries: entries.length,
          first_timestamp: entries[0].timestamp,
          last_timestamp: entries[entries.length - 1].timestamp,
          mode: "legacy",
        };
      }
      if (!parsed) continue;
      // A run with BOTH files on disk (outside corruption — this store refuses
      // to create that state) collapses into ONE mixed summary: listed once,
      // and eviction removes both files rather than retaining either half.
      const existing = byRun.get(parsed.run_id);
      if (existing) {
        existing.mode = "mixed";
        existing.entries += parsed.entries;
        existing.first_timestamp = [existing.first_timestamp, parsed.first_timestamp].sort()[0];
        existing.last_timestamp = [existing.last_timestamp, parsed.last_timestamp].sort()[1];
      } else {
        byRun.set(parsed.run_id, parsed);
        out.push(parsed);
      }
    }
    return out;
  }
}
