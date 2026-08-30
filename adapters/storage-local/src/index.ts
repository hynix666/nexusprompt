/**
 * storage-local — a RevisionStore that retains complete run bundles.
 *
 * The bound is eight *bundles*, not eight entries. The source counted entries
 * and capped at 8, which could not hold a nine-stage run; the pipeline is now
 * eleven stages. Any entry-based bound is a hostage to stage count, so a run is
 * retained or evicted whole.
 */

import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  RevisionEntry,
  RevisionStore,
  RunBundleSummary,
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

  async append(entry: RevisionEntry): Promise<void> {
    const path = this.bundlePath(entry.run_id); // validates the id before it reaches the chain
    return serialise(this.root, async () => {
      await mkdir(this.root, { recursive: true });
      const bundle = existsSync(path)
        ? (JSON.parse(await readFile(path, "utf8")) as RevisionEntry[])
        : [];
      bundle.push(entry);
      await this.writeAtomic(path, JSON.stringify(bundle, null, 2));
      await this.evict();
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
    if (!existsSync(path)) return [];
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
    const path = this.bundlePath(run_id);
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
    for (const b of doomed) await rm(this.bundlePath(b.run_id), { force: true });
  }

  private async readAll(): Promise<RunBundleSummary[]> {
    if (!existsSync(this.root)) return [];
    const files = (await readdir(this.root)).filter((f) => f.endsWith(".json"));
    const out: RunBundleSummary[] = [];
    for (const f of files) {
      const entries = JSON.parse(await readFile(join(this.root, f), "utf8")) as RevisionEntry[];
      if (!entries.length) continue;
      out.push({
        run_id: entries[0].run_id,
        entries: entries.length,
        first_timestamp: entries[0].timestamp,
        last_timestamp: entries[entries.length - 1].timestamp,
      });
    }
    return out;
  }
}
