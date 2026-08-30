import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { LocalRevisionStore } from "../src/index.js";
import type { RevisionEntry } from "../../../contracts/index.js";

/**
 * Sweep fifteen — the race the knowledge base admitted and nothing measured.
 *
 * `append` is read → parse → push → write. Unserialised, that loses entries silently and can
 * observe a half-written file. Measured before the fix:
 *
 *   2 concurrent appends  ->  1 kept,  1 lost
 *   11 concurrent appends ->  3 kept,  8 lost, 3 threw (SyntaxError on a truncated file)
 *   30 concurrent appends ->  2 kept, 28 lost, 16 threw
 *
 * And it compounded: content reclamation computes its live set from what the bundles say, so a
 * revision lost to the race took its retained body with it — a transient concurrency bug became
 * permanent content loss.
 *
 * There were no tests for this adapter at all, which is why prose describing the defect could
 * sit in the knowledge base for weeks beside code that had it.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), "pnx-store-")); temps.push(d); return d; };

const entry = (run_id: string, n: number): RevisionEntry => ({
  revision_id: `${run_id}-${n}`,
  run_id,
  stage_id: "compile",
  parent_revision_ids: [],
  input_ref: null,
  output_ref: null,
  timestamp: new Date(1_760_000_000_000 + n * 1000).toISOString(),
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

describe("concurrent appends keep every revision", () => {
  it("loses nothing when appends to ONE run overlap", async () => {
    // Two was enough to drop one. Thirty is here because the loss got worse with load, which
    // is the signature of a read-modify-write rather than an off-by-one.
    for (const n of [2, 11, 30]) {
      const store = new LocalRevisionStore(mkroot());
      await Promise.all(Array.from({ length: n }, (_, i) => store.append(entry("same", i))));
      const kept = await store.getRun("same");
      expect(kept, `${n} concurrent appends`).toHaveLength(n);
      // Every one, not merely the right count.
      expect(new Set(kept.map((e) => e.revision_id)).size).toBe(n);
    }
  });

  it("loses nothing when appends to DIFFERENT runs overlap", async () => {
    // `append` also runs `evict`, which reads every bundle and deletes the oldest — so the
    // critical section is the directory, not one file. Serialising per bundle path left this
    // case broken, and on Windows loudly: 7 appends threw `EPERM ... rename` because a reader
    // in `readAll` held the target open.
    const store = new LocalRevisionStore(mkroot());
    const runs = ["r0", "r1", "r2", "r3", "r4", "r5"];
    await Promise.all(runs.flatMap((r) => Array.from({ length: 4 }, (_, i) => store.append(entry(r, i)))));
    let kept = 0;
    for (const r of runs) kept += (await store.getRun(r)).length;
    expect(kept).toBe(24);
  });

  it("never leaves a bundle another reader cannot parse", async () => {
    // `writeFile` truncates then writes, so a concurrent reader saw `Unexpected end of JSON
    // input`. The write goes to a temp name and renames over the target now, which is atomic.
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    const appends = Promise.all(Array.from({ length: 20 }, (_, i) => store.append(entry("busy", i))));
    // Read repeatedly while the writes are in flight.
    const reads: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) reads.push(store.getRun("busy"));
    await expect(Promise.all([appends, ...reads])).resolves.toBeDefined();

    for (const f of readdirSync(root).filter((n) => n.endsWith(".json"))) {
      expect(() => JSON.parse(readFileSync(join(root, f), "utf8")), f).not.toThrow();
    }
  });

  it("leaves no temporary files behind", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.append(entry("tidy", i))));
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("still evicts to eight bundles under concurrency", async () => {
    // The must-not-break half: serialising the writes must not disable the retention bound.
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await Promise.all(Array.from({ length: 14 }, (_, i) => store.append(entry(`ev${i}`, 0))));
    expect(readdirSync(root).filter((f) => f.endsWith(".json"))).toHaveLength(8);
  });

  it("sequential appends are unaffected — the baseline the fix must not change", async () => {
    const store = new LocalRevisionStore(mkroot());
    for (let i = 0; i < 11; i++) await store.append(entry("seq", i));
    const kept = await store.getRun("seq");
    expect(kept).toHaveLength(11);
    expect(kept.map((e) => e.revision_id)).toEqual(Array.from({ length: 11 }, (_, i) => `seq-${i}`));
  });
});

/**
 * The atomic write, tested where it actually matters: another PROCESS.
 *
 * In-process serialisation hides this — reads and writes never overlap once appends share a
 * chain — so reverting `writeAtomic` to a plain `writeFile` left every test above green. The
 * property it protects is cross-process: two CLI invocations against one `.nexusprompt/runs`
 * directory, which is an ordinary thing for a local-first tool. `writeFile` truncates and then
 * writes, so a reader in another process can observe an empty or half-written bundle;
 * `rename` cannot be observed partially.
 *
 * **A Windows caveat, measured rather than assumed.** `rename` onto a path another PROCESS has
 * open fails there with `EPERM`. A reader looping with no gap holds the handle essentially all
 * the time, and every append fails — the first version of this test did exactly that and could
 * not pass. That is the correct failure DIRECTION (a loud error, not a silent corruption) and
 * it is why `renameWithRetry` exists, but it means the guarantee on Windows is "never partial,
 * possibly refused" rather than "never partial, always written". On POSIX the rename simply
 * succeeds. The reader below polls the way a real consumer does.
 */
describe("a reader in another process never sees a partial bundle", () => {
  it("survives a foreign reader hammering the bundle during appends", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.append(entry("cross", 0));

    const reader = join(root, "reader.mjs");
    writeFileSync(reader, `
      import { readFileSync } from "node:fs";
      const path = process.argv[2];
      let bad = 0, reads = 0;
      const until = Date.now() + 3000;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // A real consumer polls; it does not hold the handle open continuously. See the note in
      // the describe block about what a zero-gap reader does on Windows.
      while (Date.now() < until) {
        try { JSON.parse(readFileSync(path, "utf8")); reads++; }
        catch (e) { if (e.code !== "ENOENT") bad++; }
        await sleep(1);
      }
      console.log(JSON.stringify({ reads, bad }));
    `);

    const child = spawn(process.execPath, [reader, join(root, "cross.json")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });

    let refused = 0;
    for (let i = 1; i <= 120; i++) {
      try { await store.append(entry("cross", i)); } catch { refused++; }
    }
    await new Promise<void>((res) => child.on("close", () => res()));

    const { reads, bad } = JSON.parse(out.trim()) as { reads: number; bad: number };
    // The reader must have actually read — otherwise this proves nothing.
    expect(reads, "the foreign reader never parsed the bundle").toBeGreaterThan(10);
    expect(bad, `${bad} of ${reads + bad} foreign reads saw a partial file`).toBe(0);
    // Refusals are acceptable on Windows and must stay rare; a silent corruption is not.
    expect(refused, `${refused} of 120 appends were refused`).toBeLessThan(20);
  }, 30_000);
});
