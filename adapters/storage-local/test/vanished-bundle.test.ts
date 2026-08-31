import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRevisionStore } from "../src/index.js";
import type { RevisionEntry } from "../../../contracts/index.js";

/**
 * The bundle that disappears under a run that is still writing to it.
 *
 * `append` was read → parse → push → write, and the read was
 * `existsSync(path) ? JSON.parse(read) : []`. That `: []` answers two different
 * questions with one value: "this run has never been written" and "this run was
 * written and its bundle is gone". The second is data loss, and it returned
 * normally — no throw, no event, no exit code.
 *
 * Measured on a real run before the fix. A twelve-minute local-model pipeline
 * (`--model qwen3.8:27b --timeout 900`) held one revision at 01:08:30 —
 * `deconstruct SUCCEEDED`, fingerprint `ollama-local:qwen3.8:27b`. The completed
 * bundle held five revisions beginning at `calibrate`. The run reported success
 * and exit 3 (a gate WARN). Two further bundles in the same directory show the
 * same signature: a run that lost `deconstruct` and `calibrate` and resumes at
 * `compile`, and a second that resumes at `calibrate`. Seven-stage runs that
 * complete in ~50 ms are all intact — only a run slow enough for the file to
 * vanish underneath it is exposed.
 *
 * Two different deleters produce it, which is why the guard is on the READ and
 * not on either deleter:
 *
 *   - `evict()` is directory-wide. It sorts by `last_timestamp` and deletes the
 *     oldest above `MAX_BUNDLES`. A stalled run's `last_timestamp` does not
 *     advance between stages, so the longest-running bundle becomes the oldest
 *     and is evicted FIRST — exactly inverted from what retention wants. Any
 *     unrelated run finishing in another process is enough; `check:examples`
 *     runs the CLI with `cwd: root`, so `npm run verify` appends to this
 *     repository's own `.nexusprompt/runs/`.
 *   - Anything else that removes the file: the runs directory being moved
 *     aside mid-run, an antivirus quarantine, a manual `rm`.
 *
 * An in-process live set would have covered neither: the eviction that kills a
 * long run comes from a DIFFERENT process, which has no way to know the bundle
 * is live. Sorting eviction by creation instead of last write is worse — the
 * long run was created first, so it is still the first to go.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), "pnx-vanish-")); temps.push(d); return d; };

const T0 = 1_760_000_000_000;

const entry = (run_id: string, stage_id: string, minute: number): RevisionEntry => ({
  revision_id: `${run_id}-${stage_id}`,
  run_id,
  stage_id,
  parent_revision_ids: [],
  input_ref: null,
  output_ref: null,
  timestamp: new Date(T0 + minute * 60_000).toISOString(),
  stage_attempt: 1,
  input_hash: "a".repeat(64),
  output_hash: "b".repeat(64),
  gate_results: [],
  status: "SUCCEEDED",
  freshness: "FRESH",
  execution_provenance: {
    core_build_hash: "test",
    contract_versions: { "revision-entry": "2.0.0" },
    provider_model_fingerprint: null,
    config_fingerprint: null,
  },
  retention_scope: "LOCAL_BUNDLE",
  provider_used: null,
}) as RevisionEntry;

describe("a bundle that vanishes under an open run is never silently recreated", () => {
  it("refuses to extend a bundle deleted underneath it", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);

    await store.append(entry("live", "deconstruct", 0));
    expect(await store.getRun("live")).toHaveLength(1);

    // Whatever the deleter is, this is what the store sees.
    unlinkSync(join(root, "live.json"));

    const second = store.append(entry("live", "calibrate", 12));
    await expect(second, "the second append resolved as though the run were new").rejects.toThrow(
      /vanished/i,
    );
    // The refusal must name the run, or an operator cannot act on it.
    await expect(second).rejects.toThrow(/live/);
  });

  it("does not report a one-revision bundle after the loss", async () => {
    // The property, stated without reference to HOW it is kept: two revisions
    // were appended, so the store may not answer "one" and call that success.
    const root = mkroot();
    const store = new LocalRevisionStore(root);

    await store.append(entry("live", "deconstruct", 0));
    unlinkSync(join(root, "live.json"));

    let resolved = false;
    try {
      await store.append(entry("live", "calibrate", 12));
      resolved = true;
    } catch {
      /* refusing is one acceptable outcome; silently truncating is not */
    }

    if (resolved) {
      const kept = await store.getRun("live");
      expect(kept.map((e) => e.stage_id), "append resolved but dropped a revision").toEqual([
        "deconstruct",
        "calibrate",
      ]);
    }
  });

  it("refuses when EVICTION is the deleter — the field case", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);

    // A long run lands one stage, then the model thinks for twelve minutes.
    await store.append(entry("live", "deconstruct", 0));

    // Eight unrelated short runs complete in the meantime. The ninth bundle
    // pushes the directory over MAX_BUNDLES and the oldest — the live one — goes.
    for (let i = 0; i < 8; i++) await store.append(entry(`short${i}`, "compile", i + 1));
    expect(existsSync(join(root, "live.json")), "eviction did not remove the live bundle").toBe(false);

    await expect(store.append(entry("live", "calibrate", 12))).rejects.toThrow(/vanished/i);
  });

  it("still starts a bundle for a run it has never written", async () => {
    // The must-not-break half: a genuinely new run has no prior write to lose.
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.append(entry("fresh", "deconstruct", 0));
    expect(await store.getRun("fresh")).toHaveLength(1);
    expect(readdirSync(root).filter((f) => f.endsWith(".json"))).toEqual(["fresh.json"]);
  });

  it("says nothing about a run this instance never wrote", async () => {
    // The boundary, stated honestly. A store object that never appended to a run
    // cannot know a bundle ever existed — that would need a lock file or a real
    // database, which is `storage-db`'s job. A second CLI invocation resuming a
    // run id it did not write still starts a bundle, and this test pins that so
    // the guard is not mistaken for a cross-process one.
    const root = mkroot();
    await new LocalRevisionStore(root).append(entry("earlier", "deconstruct", 0));
    unlinkSync(join(root, "earlier.json"));

    const fresh = new LocalRevisionStore(root);
    await fresh.append(entry("earlier", "calibrate", 12));
    expect(await fresh.getRun("earlier")).toHaveLength(1);
  });
});
