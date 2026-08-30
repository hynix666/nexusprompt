# Atomic Run Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an immutable, atomically published run-manifest format that makes semantic revision graphs and content references recoverable as one unit while keeping legacy `<run_id>.json` bundles readable and never mixing the two formats.

**Architecture:** Extend the contracts with a `RunManifest` value and an optional `RevisionStore.commitManifest(manifest)` capability. `LocalRevisionStore` will keep legacy append-only JSON bundles unchanged, store semantic runs in `<run_id>.manifest.json`, detect both files as an error, route manifest publication through the same per-root serialisation chain that guards `append`, and finalize publication with an exclusive `link` from a temporary sibling file - never `rename`, which silently replaces an existing destination on POSIX. This plan deliberately stops at the storage boundary; pipeline accumulation/wiring and migration tooling are a separate follow-up plan.

**Tech Stack:** TypeScript 5.9, Node `node:fs/promises`, Vitest 3, existing `RevisionStore` and `LocalRevisionStore` patterns, JSON Schema/Ajv contract tests.

**Spec:** `docs/superpowers/specs/2026-08-29-artifact-reference-lineage-design.md`; refined manifest contract from the approved design discussion in this thread.

## Global Constraints

- Legacy `<run_id>.json` bundles remain readable without conversion.
- A run must use exactly one storage mode; if both legacy and manifest files exist, refuse with `mixed-lineage`.
- Semantic manifests are immutable after publication; there is no overwrite or in-place mutation.
- The final manifest must never be partially visible; publication occurs only after the complete temporary file is closed.
- Final publication uses `link`, which fails with `EEXIST` when the destination exists; `rename` must never publish the final manifest because POSIX `rename` silently replaces.
- `commitManifest` runs inside the same per-root serialisation chain as `append`, so publication, appends, and eviction never interleave.
- `append` refuses a run that already has a semantic manifest (`mixed-lineage`).
- Eviction counts legacy and manifest runs together as whole bundles and deletes the file matching each doomed run's mode; `.tmp.*` files are never counted or evicted.
- `RunManifest.content_refs` contains every non-null revision `input_ref` and `output_ref`, with no duplicates.
- `RunManifest` contains no content bodies.
- Temporary manifest files are ignored by readers.
- `markStale` may retain legacy behavior but must refuse semantic manifests because changing a committed manifest would violate immutability.
- Do not change the pre-existing untracked `AGENTS.md`.
- Do not add a package dependency; use the repository’s existing Node and Vitest stack.

## File Map

- **Modify:** `contracts/index.ts` — define `RunManifest` and add the optional manifest capability to `RevisionStore`.
- **Modify:** `contracts/CHANGELOG.md` — document the additive contract change and legacy/semantic mode rule.
- **Modify:** `adapters/storage-local/src/index.ts` — implement manifest path selection, validation, atomic publication, conflict detection, manifest reads, and semantic immutability behavior.
- **Modify:** `test/contract-conformance.test.ts` — include a valid manifest shape in contract-level coverage if the repository’s schema coverage requires it.
- **Modify:** `application/test/acceptance.test.ts` — add local adapter integration tests for legacy readability and manifest mode.
- **Create:** `test/run-manifest.test.ts` — focused atomicity, conflict, validation, and cleanup tests for `LocalRevisionStore`.
- **Modify:** `contracts/run-manifest.schema.json` — add the manifest schema if contract conformance requires every new contract to have a schema.
- **Modify:** `package.json` only if an existing test/check script must explicitly include the new focused suite; prefer existing Vitest discovery.

---

### Task 1: Add the manifest contract and schema

**Files:**
- Modify: `contracts/index.ts` near `RevisionStore` and `RunBundleSummary`
- Modify: `contracts/CHANGELOG.md`
- Create or modify: `contracts/run-manifest.schema.json`
- Test: `test/contract-conformance.test.ts`

**Interfaces:**
- Consumes: existing `RevisionEntry`, `ContentStore` ref strings, `RevisionStore`.
- Produces:
  ```ts
  export interface RunManifest {
    manifest_version: "1.0.0";
    run_id: string;
    created_at: string;
    committed_at: string;
    revisions: RevisionEntry[];
    content_refs: string[];
  }

  export interface RevisionStore {
    append(entry: RevisionEntry): Promise<void>;
    getRun(run_id: string): Promise<RevisionEntry[]>;
    listRecent(limit: number): Promise<RunBundleSummary[]>;
    markStale(run_id: string, from_revision_id: string): Promise<void>;
    commitManifest?(manifest: RunManifest): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing contract test**

Add a valid manifest fixture with two revisions, one `input_ref`, and one `output_ref`. Assert that the fixture validates against the new schema and that invalid variants are rejected:

```ts
it("accepts a complete immutable run manifest", () => {
  const manifest = {
    manifest_version: "1.0.0",
    run_id: "run-manifest",
    created_at: "2026-08-30T12:00:00.000Z",
    committed_at: "2026-08-30T12:01:00.000Z",
    revisions: [revisionWithRefs("run-manifest", "r1"), revisionWithRefs("run-manifest", "r2")],
    content_refs: ["npx:stage-output:" + "a".repeat(64) + ":local-bundle"],
  };
  expect(validate("run-manifest", manifest)).toBe(true);
});

it("rejects a manifest with a wrong run id or duplicate content ref", () => {
  const manifest = validManifest();
  expect(validate("run-manifest", { ...manifest, revisions: [{ ...manifest.revisions[0], run_id: "other" }] })).toBe(false);
  expect(validate("run-manifest", { ...manifest, content_refs: [manifest.content_refs[0], manifest.content_refs[0]] })).toBe(false);
});
```

Use the existing validator/fixture helpers in `test/contract-conformance.test.ts`; do not introduce a second validation framework.

- [ ] **Step 2: Run the focused contract test and verify it fails**

Run:

```bash
npx vitest run --project contracts test/contract-conformance.test.ts
```

Expected: FAIL because the manifest schema and contract entry do not exist yet.

- [ ] **Step 3: Add the minimal schema and types**

The schema must require all six manifest fields, reject additional properties, require `manifest_version` to equal `1.0.0`, validate ISO timestamps, require a non-empty revisions array, and validate non-empty unique content refs. It should not duplicate the entire `RevisionEntry` schema unless the existing conformance structure requires embedded validation; use the repository’s established schema composition style.

Add `RunManifest` and the optional `commitManifest` method exactly as specified above. Add a changelog entry stating that legacy bundles remain readable, semantic manifests are immutable, and both files under one run ID are rejected.

- [ ] **Step 4: Run the focused contract test and typecheck**

Run:

```bash
npx vitest run --project contracts test/contract-conformance.test.ts
npx tsc --noEmit
```

Expected: PASS with the new manifest cases and no type errors.

- [ ] **Step 5: Commit the contract-only change**

```bash
git add contracts/index.ts contracts/CHANGELOG.md contracts/run-manifest.schema.json test/contract-conformance.test.ts
git commit -m "Add immutable run-manifest contract"
```

Do not stage `AGENTS.md` or unrelated working-tree files.

---

### Task 2: Add mode detection and atomic manifest publication to `LocalRevisionStore`

**Files:**
- Modify: `adapters/storage-local/src/index.ts`
- Test: `test/run-manifest.test.ts`

**Interfaces:**
- Consumes: `RunManifest`, `RevisionStore.commitManifest?`, existing run-id validation.
- Produces:
  ```ts
  class LocalRevisionStore implements RevisionStore {
    async commitManifest(manifest: RunManifest): Promise<void>;
    async getRun(run_id: string): Promise<RevisionEntry[]>;
  }
  ```

- [ ] **Step 1: Write failing atomic publication tests**

Create reusable fixtures and test the externally observable behavior:

```ts
it("publishes a complete manifest and reloads its revisions", async () => {
  const store = new LocalRevisionStore(root);
  const manifest = validManifest("run-manifest");

  await store.commitManifest(manifest);

  expect(await store.getRun("run-manifest")).toEqual(manifest.revisions);
  expect(readdirSync(root).filter((name) => name.includes(".tmp.")).length).toBe(0);
});

it("does not overwrite an existing manifest", async () => {
  const store = new LocalRevisionStore(root);
  await store.commitManifest(validManifest("run-manifest"));
  await expect(store.commitManifest(validManifest("run-manifest"))).rejects.toThrow(/immutable|exists/i);
});

it("refuses to mix legacy and semantic lineage", async () => {
  const store = new LocalRevisionStore(root);
  await store.append(revisionWithRefs("run-manifest", "legacy-r1"));
  await expect(store.commitManifest(validManifest("run-manifest"))).rejects.toThrow(/mixed-lineage/i);
});

it("refuses append to a run that already has a semantic manifest", async () => {
  const store = new LocalRevisionStore(root);
  await store.commitManifest(validManifest("run-manifest"));
  await expect(store.append(revisionWithRefs("run-manifest", "r1"))).rejects.toThrow(/mixed-lineage/i);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npx vitest run --project contracts test/run-manifest.test.ts
```

Expected: FAIL because `commitManifest` is not implemented, `getRun` has no manifest mode, and appends to semantic runs are not yet refused.

- [ ] **Step 3: Implement path helpers and validation**

Add a manifest path beside the legacy path:

```ts
private manifestPath(run_id: string): string {
  return join(this.root, `${this.bundlePath(run_id)}.manifest.json`);
}
```

Avoid composing the full filename from the already suffixed bundle path; instead use a shared validated stem so the actual paths are exactly:

```text
<root>/<run_id>.json
<root>/<run_id>.manifest.json
```

Validate before touching disk:

- manifest version is `1.0.0`;
- manifest `run_id` is valid and matches every revision;
- revision IDs are unique;
- revisions are non-empty;
- each `content_refs` value is unique;
- every non-null revision `input_ref` and `output_ref` appears in `content_refs`;
- no extra refs are present;
- timestamps are parseable ISO timestamps.

Throw errors containing stable phrases: `invalid manifest`, `mixed-lineage`, and `immutable manifest`.

- [ ] **Step 4: Implement atomic publication**

Use `mkdir`, `writeFile`, `link`, and `rm` from `node:fs/promises`, plus a random temporary suffix following the store’s existing `<final>.<uuid>.tmp` convention so readers ignore one pattern. `commitManifest` must enter the same `serialise(this.root, ...)` chain `append` uses — that chain exists because the critical section is the DIRECTORY (append also runs eviction, which reads every bundle), and publication has exactly the same directory-wide footprint. The algorithm must be:

```ts
await mkdir(this.root, { recursive: true });
await serialise(this.root, async () => {
  // Mode checks INSIDE the chain: an append that won the race before us must
  // be visible here, and a manifest we publish must be seen by later appends.
  if (existsSync(legacyPath)) throw new Error("mixed-lineage...");
  if (existsSync(manifestPath)) throw new Error("immutable manifest...");

  const tempPath = `${manifestPath}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
  try {
    // Exclusive final publication: link fails with EEXIST if the final path
    // appeared after the check above (e.g. another process), and - unlike
    // rename - never replaces an existing destination on ANY platform.
    // Immutability is enforced by the kernel, not by a check-then-act race.
    await link(tempPath, manifestPath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
  await rm(tempPath, { force: true });
});
```

Why `link` and not the store’s existing `renameWithRetry`: `rename` silently replaces an existing destination on POSIX, so check-then-rename leaves a window in which a second `commitManifest` destroys the first manifest. `link(2)` is exclusive by construction — it fails with `EEXIST` when the destination exists, on POSIX and Windows alike — so immutability holds even across processes. `renameWithRetry` stays on the legacy bundle write path, where replacement is the point. Import `link` alongside the other `node:fs/promises` helpers.

- [ ] **Step 5: Implement mode-aware `getRun`**

Resolve exactly one mode:

```ts
const legacy = existsSync(legacyPath);
const semantic = existsSync(manifestPath);
if (legacy && semantic) throw new Error("mixed-lineage...");
if (semantic) return readManifest(manifestPath).revisions;
if (legacy) return readLegacyBundle(legacyPath);
return [];
```

Ignore files matching `<run_id>.manifest.json.<uuid>.tmp`.

- [ ] **Step 6: Run the focused adapter tests and typecheck**

Run:

```bash
npx vitest run --project contracts test/run-manifest.test.ts
npx tsc --noEmit
```

Expected: PASS with no type errors.

- [ ] **Step 7: Commit the adapter change**

```bash
git add adapters/storage-local/src/index.ts test/run-manifest.test.ts
 git commit -m "Publish run manifests atomically"
```

---

### Task 3: Preserve legacy behavior and enforce semantic immutability

**Files:**
- Modify: `adapters/storage-local/src/index.ts`
- Modify: `test/run-manifest.test.ts`
- Modify: `application/test/acceptance.test.ts`

**Interfaces:**
- Consumes: the mode-aware `LocalRevisionStore` from Task 2.
- Produces: unchanged legacy `append`, `listRecent`, and `markStale` behavior; semantic manifests readable but immutable.

- [ ] **Step 1: Write failing compatibility tests**

Add these focused cases:

```ts
it("keeps legacy bundles readable", async () => {
  const store = new LocalRevisionStore(root);
  const entry = revisionWithRefs("legacy-run", "r1");
  await store.append(entry);
  expect(await store.getRun("legacy-run")).toEqual([entry]);
});

it("refuses markStale for a semantic manifest", async () => {
  const store = new LocalRevisionStore(root);
  await store.commitManifest(validManifest("semantic-run"));
  await expect(store.markStale("semantic-run", "r1")).rejects.toThrow(/immutable manifest/i);
});

it("lists both legacy and semantic runs without reading temporary files", async () => {
  const store = new LocalRevisionStore(root);
  await store.append(revisionWithRefs("legacy-run", "legacy-r1"));
  await store.commitManifest(validManifest("semantic-run"));
  writeFileSync(join(root, "ignored.manifest.json.tmp777.crash"), "partial");

  const ids = (await store.listRecent(10)).map((summary) => summary.run_id);
  expect(ids).toEqual(expect.arrayContaining(["legacy-run", "semantic-run"]));
  expect(ids).not.toContain("ignored");
});

it("evicts whole runs across both modes and never touches temp files", async () => {
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
```

- [ ] **Step 2: Run the focused tests and verify the new cases fail**

Run:

```bash
npx vitest run --project contracts test/run-manifest.test.ts application/test/acceptance.test.ts
```

Expected: FAIL for semantic `markStale`, manifest-aware listing, and cross-mode eviction until those paths are implemented.

- [ ] **Step 3: Update `listRecent` and `markStale` minimally**

Make `readAll()` recognize only legacy `.json` files and manifest `.manifest.json` files. Parse each through its corresponding reader and derive `RunBundleSummary` from the manifest’s revisions. Do not scan or parse `.tmp.*` files.

At the start of `markStale`, detect semantic mode. If a manifest exists, throw `immutable manifest`; if both files exist, throw `mixed-lineage`; otherwise preserve the current legacy cascade exactly.

**Mode-aware eviction (the gap):** the current `evict()` sorts `readAll()` output and deletes `this.bundlePath(b.run_id)` — always `<run_id>.json`. Once manifests exist that is wrong twice: `.manifest.json` ends with `.json`, so semantic runs are counted toward the bound, yet eviction deletes their (nonexistent) legacy file and the manifest survives — the bound is silently exceeded. Fix in this task:

- Tag each `RunBundleSummary` internally with its mode (legacy vs semantic).
- `evict()` deletes `manifestPath` for semantic runs and `bundlePath` for legacy runs.
- A run with both files present (mixed) is removed in both modes rather than retained.
- `.tmp.*` files are never counted or evicted.

Do not add manifest mutation, delete-migration, or pipeline integration in this task.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx vitest run --project contracts test/run-manifest.test.ts application/test/acceptance.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit the compatibility behavior**

```bash
git add adapters/storage-local/src/index.ts test/run-manifest.test.ts application/test/acceptance.test.ts
 git commit -m "Keep legacy bundles separate from manifests"
```

---

### Task 4: Full validation and handoff to pipeline integration

**Files:**
- No source changes expected.
- Review: `docs/superpowers/specs/2026-08-29-artifact-reference-lineage-design.md`

**Interfaces:**
- Consumes: committed `RunManifest` contract and `LocalRevisionStore.commitManifest`.
- Produces: verified storage boundary ready for a separate Application integration plan.

- [ ] **Step 1: Run the complete targeted suite**

```bash
npx vitest run --project contracts test/run-manifest.test.ts application/test/acceptance.test.ts
npx tsc --noEmit
```

Expected: all targeted tests pass and typecheck exits 0.

- [ ] **Step 2: Run repository verification**

```bash
npm run verify
```

Expected: all repository gates pass. If generated artifacts such as `build-hash.json` change, inspect the diff and update only derived files caused by this plan; never stage `AGENTS.md`.

- [ ] **Step 3: Check migration boundary explicitly**

Confirm the implementation has no code path that:

- upgrades a legacy bundle on read;
- appends to a semantic manifest;
- merges legacy and semantic records;
- mutates a committed semantic manifest;
- treats a temporary manifest as readable.

- [ ] **Step 4: Commit verification-only derived updates if required**

```bash
git status --short
git diff --stat
```

Stage only derived artifacts directly produced by this implementation and the files listed by the plan. Leave unrelated or pre-existing files untouched.

## Self-Review Checklist

- **Spec coverage:** The content references remain manifest metadata, no bodies are embedded, legacy bundles remain readable, atomic publication is explicit, mixed lineage is refused in both directions (append to semantic and commit to legacy), and mode-aware eviction keeps the eight-bundle bound honest across both storage modes. Pipeline accumulation, ContentStore lifecycle/deletion, and migration tooling are intentionally outside this plan and require a second plan.
- **Placeholder scan:** Every task names files, interfaces, test behavior, commands, and expected outcomes; no `TBD`, `TODO`, or unspecified “handle errors” step remains.
- **Type consistency:** `RunManifest` and `commitManifest?(manifest: RunManifest): Promise<void>` are defined before adapter tasks consume them; all tests use `revisionWithRefs`, `validManifest`, `validManifestWithTime`, and `LocalRevisionStore` fixtures that must be defined in Task 1/2 test setup.
- **Concurrency caveat:** Final publication is `link`, which is exclusive by construction (`EEXIST` on an existing destination, POSIX and Windows); `rename` is never used for the final manifest because POSIX `rename` silently replaces. `commitManifest` shares `append`'s per-root chain, so publication cannot interleave with appends or eviction.
- **Scope boundary:** This plan creates the storage primitive only. A follow-up plan must accumulate pipeline revisions, collect refs, select semantic mode, and define crash behavior when a run fails before commit.
