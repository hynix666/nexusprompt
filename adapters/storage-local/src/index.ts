/**
 * storage-local — a RevisionStore that retains complete run bundles.
 *
 * The bound is eight *bundles*, not eight entries. The source counted entries
 * and capped at 8, which could not hold a nine-stage run; the pipeline is now
 * eleven stages. Any entry-based bound is a hostage to stage count, so a run is
 * retained or evicted whole.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type {
  RevisionEntry,
  RevisionStore,
  RunBundleSummary,
} from "../../../contracts/index.js";

const MAX_BUNDLES = 8;

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
    await mkdir(this.root, { recursive: true });
    const path = this.bundlePath(entry.run_id);
    const bundle = existsSync(path)
      ? (JSON.parse(await readFile(path, "utf8")) as RevisionEntry[])
      : [];
    bundle.push(entry);
    await writeFile(path, JSON.stringify(bundle, null, 2));
    await this.evict();
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
