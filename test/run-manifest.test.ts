import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRevisionStore } from "../adapters/storage-local/src/index.js";
import type { RevisionEntry, RunManifest } from "../contracts/index.js";

/**
 * Focused atomicity, conflict, validation, and cleanup tests for the semantic
 * manifest mode of `LocalRevisionStore`.
 *
 * The externally observable promises under test (from the implementation plan):
 * publication is invisible until complete, immutability holds across attempts,
 * mixed lineage is refused in both directions, temp files never survive a
 * failed publish and never influence reads or eviction.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), "pnx-manifest-")); temps.push(d); return d; };

const H = "a".repeat(64);

const revisionWithRefs = (run_id: string, revision_id: string): RevisionEntry => ({
  revision_id,
  run_id,
  stage_id: "compile",
  parent_revision_ids: [],
  stage_attempt: 1,
  timestamp: "2026-08-30T12:00:00.000Z",
  input_hash: H,
  output_hash: H,
  input_ref: `npx:stage-input:${H}:local-bundle`,
  output_ref: `npx:stage-output:${H}:local-bundle`,
  gate_results: [],
  freshness: "FRESH",
  status: "SUCCEEDED",
  provider_used: null,
  execution_provenance: {
    core_build_hash: "test",
    contract_versions: {},
    provider_model_fingerprint: null,
    config_fingerprint: null,
  },
  retention_scope: "LOCAL_BUNDLE",
});

const validManifest = (run_id = "run-manifest"): RunManifest => ({
  manifest_version: "1.0.0",
  run_id,
  created_at: "2026-08-30T12:00:00.000Z",
  committed_at: "2026-08-30T12:01:00.000Z",
  revisions: [revisionWithRefs(run_id, "r1"), revisionWithRefs(run_id, "r2")],
  content_refs: [
    `npx:stage-input:${H}:local-bundle`,
    `npx:stage-output:${H}:local-bundle`,
  ],
});

const validManifestWithTime = (run_id: string, at: string): RunManifest => ({
  ...validManifest(run_id),
  created_at: at,
  committed_at: at,
  revisions: [revisionWithRefs(run_id, "r1")].map((r) => ({ ...r, timestamp: at })),
});

describe("LocalRevisionStore manifest mode", () => {
  it("publishes a complete manifest and reloads its revisions", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    const manifest = validManifest("run-manifest");

    await store.commitManifest(manifest);

    expect(await store.getRun("run-manifest")).toEqual(manifest.revisions);
    expect(readdirSync(root).filter((name) => name.includes(".tmp.")).length).toBe(0);
  });

  it("does not overwrite an existing manifest", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.commitManifest(validManifest("run-manifest"));
    await expect(store.commitManifest(validManifest("run-manifest"))).rejects.toThrow(/immutable|exists/i);
  });

  it("refuses to mix legacy and semantic lineage", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.append(revisionWithRefs("run-manifest", "legacy-r1"));
    await expect(store.commitManifest(validManifest("run-manifest"))).rejects.toThrow(/mixed-lineage/i);
  });

  it("refuses append to a run that already has a semantic manifest", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.commitManifest(validManifest("run-manifest"));
    await expect(store.append(revisionWithRefs("run-manifest", "r1"))).rejects.toThrow(/mixed-lineage/i);
  });

  it("cleans up the temp file when publication fails", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.commitManifest(validManifest("run-manifest"));
    // Second publish fails on the immutable check inside the chain — but even a
    // link failure after a temp write must clean up, so assert the invariant by
    // provoking a link failure: pre-create the temp name is not possible from
    // outside, so instead assert no temp file survives a refused publish.
    await expect(store.commitManifest(validManifest("run-manifest"))).rejects.toThrow(/immutable/i);
    expect(readdirSync(root).filter((name) => name.includes(".tmp.")).length).toBe(0);
  });

  it("rejects a manifest whose revisions belong to another run id", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    const manifest = validManifest("run-manifest");
    (manifest.revisions[0] as { run_id: string }).run_id = "other";
    await expect(store.commitManifest(manifest)).rejects.toThrow(/invalid manifest/i);
  });

  it("rejects duplicate revision ids", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    const manifest = validManifest("run-manifest");
    manifest.revisions[1] = { ...manifest.revisions[1]!, revision_id: "r1" };
    await expect(store.commitManifest(manifest)).rejects.toThrow(/invalid manifest/i);
  });

  it("rejects content_refs that do not exactly cover the revision refs", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    // Missing ref: the output ref is cited but not declared.
    const missing = validManifest("run-manifest");
    missing.content_refs = [`npx:stage-input:${H}:local-bundle`];
    await expect(store.commitManifest(missing)).rejects.toThrow(/invalid manifest/i);

    // Extra ref: declared but cited by no revision.
    const extra = validManifest("run-manifest");
    extra.content_refs = [...extra.content_refs, `npx:generation-response:${H}:local-bundle`];
    await expect(store.commitManifest(extra)).rejects.toThrow(/invalid manifest/i);
  });

  it("rejects an unsupported manifest version", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    const manifest = { ...validManifest("run-manifest"), manifest_version: "2.0.0" } as unknown as RunManifest;
    await expect(store.commitManifest(manifest)).rejects.toThrow(/invalid manifest/i);
  });

  it("keeps legacy bundles readable", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    const entry = revisionWithRefs("legacy-run", "r1");
    await store.append(entry);
    expect(await store.getRun("legacy-run")).toEqual([entry]);
  });

  it("refuses markStale for a semantic manifest", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.commitManifest(validManifest("semantic-run"));
    await expect(store.markStale("semantic-run", "r1")).rejects.toThrow(/immutable manifest/i);
  });

  it("lists both legacy and semantic runs without reading temporary files", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    await store.append(revisionWithRefs("legacy-run", "legacy-r1"));
    await store.commitManifest(validManifest("semantic-run"));
    writeFileSync(join(root, "ignored.manifest.json.tmp777.crash"), "partial");

    const ids = (await store.listRecent(10)).map((summary) => summary.run_id);
    expect(ids).toEqual(expect.arrayContaining(["legacy-run", "semantic-run"]));
    expect(ids).not.toContain("ignored");
  });

  it("evicts whole runs across both modes and never touches temp files", async () => {
    const root = mkroot();
    const store = new LocalRevisionStore(root);
    for (let i = 0; i < 7; i++) await store.append(revisionWithRefs(`legacy-${i}`, "r1"));
    // Oldest run on disk is a semantic manifest (fixture overrides created_at,
    // committed_at, and its revision timestamps so it sorts oldest).
    await store.commitManifest(validManifestWithTime("semantic-old", "2026-08-30T00:00:00.000Z"));
    writeFileSync(join(root, "ignored.manifest.json.abc123.tmp"), "partial");
    await store.append(revisionWithRefs("legacy-new", "r1")); // 9 bundles -> evict the oldest

    const ids = (await store.listRecent(50)).map((s) => s.run_id);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain("semantic-old");
    expect(existsSync(join(root, "semantic-old.manifest.json"))).toBe(false);
    expect(existsSync(join(root, "ignored.manifest.json.abc123.tmp"))).toBe(true);
  });
});
