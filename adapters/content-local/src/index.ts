/**
 * content-local — a ContentStore backed by one file per content item.
 *
 * The artifact-reference lineage design
 * (docs/superpowers/specs/2026-08-29-artifact-reference-lineage-design.md) closes
 * [AUDIT B-4]: `input_ref`/`output_ref` were documented in REVISIONS_AND_EXPORTS.md as
 * "pointers to retained content, so events and lineage never embed bodies" and relied on
 * by the deletion and replay guarantees in PRIVACY_AND_SECURITY.md — while existing in no
 * contract, no store, and no gate. This adapter is the retention half of that fix.
 *
 * ── Immutability is enforced by the filesystem, not by a check ────────────────
 *
 * `put` opens with the `wx` flag, so a second write under the same address fails in the
 * syscall. Nothing reads-then-writes: the concurrency proposition in the corpus is
 * specifically that file-level locking serialises the write but not the
 * read-compute-write cycle, and `wx` has no cycle to interleave.
 *
 * ── Content is MATERIAL, not events ─────────────────────────────────────────
 *
 * This differs deliberately from `evidence-local`, which REFUSES a duplicate `(kind, id)`:
 * evidence records are events (distinct things that happened once), content is material
 * (the same bytes re-derived are the same material). So a second `put` of the SAME bytes
 * under the SAME ref is a no-op success — verified by re-reading and hashing, because an
 * `EEXIST` on a content address can only mean "already here" or "corrupt store", and
 * treating corruption as success would be the one silent lie this plane must never tell.
 *
 * ── One file per content item, sharded by hash prefix ────────────────────────
 *
 * Content is independently addressed and independently cited — exactly the case where
 * bundling would couple lifetimes that have no reason to be coupled (the same reasoning
 * `evidence-local` records). Sharded directories keep any one directory small; a
 * flat namespace with thousands of prompt bodies in it would make eviction scans and
 * debug listings equally miserable. `storage-db` will make its own choice when it exists.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ContentStore, RetentionScope } from "../../../contracts/index.js";

/**
 * The ref grammar lives in the contract (revision-entry 1.4.0 descriptions) and is
 * enforced here at the boundary. A ref that fails the grammar is refused, not parsed
 * leniently — the same rule, and the same spirit, as the SAFE_ID checks in
 * `storage-local` and `evidence-local`. Refs become path components; leniency here is
 * how a traversal or a silent miswrite gets built.
 */
const REF_PATTERN =
  /^npx:(stage-input|stage-output|generation-response):([0-9a-f]{64}):(local-bundle|db|export)$/;

/** One message for the one thing that must never be blessed: bytes that are not their address. */
const corruption = (hash: string): Error =>
  new Error(
    `Content store corruption at ${hash.slice(0, 12)}…: resident bytes do not hash to their ` +
      `own address. Refusing to treat them as the content this ref names — investigate the store.`,
  );

export class LocalContentStore implements ContentStore {
  readonly retention_scope: RetentionScope = "LOCAL_BUNDLE";

  constructor(private readonly root: string) {}

  /**
   * Content-addressed path: `<root>/<first-2-hex>/<remaining-62>.bin`.
   *
   * The scope_hint segment is deliberately NOT part of the path. The hint is what the
   * writer believed applied (advisory, per the design); two writers in different scopes
   * producing identical bytes must land on ONE file, because sharing-safe deletion and
   * free dedup are the whole point of content addressing. The hash is the identity; the
   * scope is a claim about retention, not a location.
   */
  private pathFor(ref: string): { path: string; hash: string } {
    const match = REF_PATTERN.exec(ref);
    if (!match) {
      throw new Error(
        `Refusing to use "${ref.slice(0, 80)}" as a content ref — expected ` +
          `npx:<stage-input|stage-output|generation-response>:<64 lowercase hex>:<local-bundle|db|export>.`,
      );
    }
    const hash = match[2];
    return { path: join(this.root, hash.slice(0, 2), `${hash.slice(2)}.bin`), hash };
  }

  async put(ref: string, bytes: Uint8Array): Promise<void> {
    const { path, hash } = this.pathFor(ref);

    // The ref's hash is the identity, so the bytes MUST hash to it. Refusing here —
    // rather than writing whatever arrived under whatever name — is what makes every
    // other promise in this store true: `get` returning bytes that verify, duplicate
    // puts resolving by hash equality, and the integrity gate's `has()` meaning
    // "the exact content this pointer names is present". A store that let a ref and
    // its bytes disagree would be a provenance lie one `put` at a time.
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) {
      throw new Error(
        `Content does not match its ref: ref names ${hash.slice(0, 12)}…, bytes hash to ` +
          `${actual.slice(0, 12)}…. A ref is a content address; pointing it at other bytes ` +
          `would make every promise this store makes false.`,
      );
    }

    await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true });
    try {
      // `wx` — fail if it exists. One syscall that cannot be interleaved; a concurrent
      // put of the same bytes loses the race and lands in the EEXIST handler below,
      // which re-verifies and returns success. Either way the invariant holds: the
      // resident bytes always hash to the address they live under.
      //
      // This is the ONLY existence test on the write path. There used to be an
      // `existsSync(path)` pre-check above carrying a byte-identical copy of the handler
      // below — which contradicted this file's own header ("Nothing reads-then-writes"),
      // because a check followed by a write is exactly that cycle, and left two copies of
      // the corruption message to keep in sync. `wx` needs no pre-check to be correct.
      await writeFile(path, bytes, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Already here. Content is material: verify the resident copy still hashes to the
        // address, then treat the write as a no-op success. An EEXIST whose bytes no
        // longer match is a corrupt store — fail loudly rather than bless it.
        if (await this.residentMatches(path, hash)) return;
        throw corruption(hash);
      }
      throw err;
    }
  }

  /**
   * Do the bytes on disk still hash to the address they live under?
   *
   * `null` when the file is gone. Shared by `put`, `get` and `has` so the three cannot
   * drift about what "present" means — `has` used to answer that question with a bare
   * `existsSync` and therefore reported a tampered file as present, which is the one
   * reading the integrity gate must never get wrong.
   */
  private async residentMatches(path: string, hash: string): Promise<boolean | null> {
    let resident: Buffer;
    try {
      resident = await readFile(path);
    } catch (err) {
      // Gone between our decision to read and the read itself. "Not here" is a real
      // answer; eviction is the whole scenario this plane exists to survive.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return createHash("sha256").update(resident).digest("hex") === hash;
  }

  async get(ref: string): Promise<Uint8Array | null> {
    // `hash` comes from `pathFor`, which already parsed and validated the ref. This used
    // to re-run `REF_PATTERN.exec(ref)![2]` a second time, with a non-null assertion whose
    // safety depended on that earlier parse having happened — a coupling nothing stated.
    const { path, hash } = this.pathFor(ref);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      // Null is "not here" (evicted, deleted, or never written) — never "here but wrong".
      // Read first and let ENOENT answer, rather than `existsSync` then read: content can
      // be evicted between the two, and the caller that correctly handles null would get
      // an ENOENT rejection instead.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    // If bytes exist under an address they must BE that address's content; a mismatch is
    // store corruption and gets thrown, not returned.
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw corruption(hash);
    return new Uint8Array(bytes);
  }

  /**
   * Present means present AND intact.
   *
   * This was `existsSync(path)` alone, which reported a tampered file as present — so the
   * `dangling-ref` promotion gate, the caller this method's own doc names, was the one
   * caller that could not detect corruption. `get` threw on exactly the same file.
   *
   * Corruption throws rather than returning false, matching `get` and matching what
   * `decidePromotion` requires of its oracle: "a present-but-failing oracle must throw
   * rather than return false, so a broken content store cannot masquerade as 'all content
   * gone'." False is reserved for genuinely absent content.
   *
   * The cost is a read where there used to be a stat. That is the correct trade for a
   * method whose answer gates a promotion: an existence check that cannot see corruption
   * is not checking the thing its caller needs.
   */
  async has(ref: string): Promise<boolean> {
    const { path, hash } = this.pathFor(ref);
    const matches = await this.residentMatches(path, hash);
    if (matches === null) return false;
    if (!matches) throw corruption(hash);
    return true;
  }
}
