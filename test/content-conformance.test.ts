import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalContentStore } from "../adapters/content-local/src/index.js";
import type { ContentStore } from "../contracts/index.js";

/**
 * One conformance suite, run against every `ContentStore` in the repository.
 *
 * Same discipline as `evidence-conformance.test.ts`: coverage is ASSERTED, not printed.
 * The last test scans `adapters/` for implementations and fails if one exists that this
 * file does not exercise, so adding `content-db` without adding it here breaks the build
 * rather than silently narrowing the guard.
 *
 * The invariants under test are the ones the artifact-reference lineage design promises:
 * a ref is a content address (bytes must hash to it), content is material (same bytes
 * again is a no-op, not an error), null is "not here" (never "here but wrong"), and the
 * grammar is enforced at the boundary because refs become path components.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
const mkroot = () => { const d = mkdtempSync(join(tmpdir(), "pnx-content-")); temps.push(d); return d; };

/** Every implementation under test. Adding one here is the whole cost of covering it. */
const IMPLEMENTATIONS: Array<[name: string, make: () => ContentStore]> = [
  ["content-local", () => new LocalContentStore(mkroot())],
];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Build a well-formed ref whose hash matches the given bytes. */
const refFor = (
  bytes: string,
  kind: "stage-input" | "stage-output" | "generation-response" = "stage-output",
  scope: "local-bundle" | "db" | "export" = "local-bundle",
) => `npx:${kind}:${sha256(bytes)}:${scope}`;

const BYTES_A = "the compiled prompt body — èàü 中文 🚀";
const BYTES_B = "a different stage output";

describe.each(IMPLEMENTATIONS)("ContentStore conformance — %s", (_name, make) => {
  it("round-trips bytes through a well-formed ref", async () => {
    const store = make();
    const ref = refFor(BYTES_A);
    await store.put(ref, new TextEncoder().encode(BYTES_A));
    const out = await store.get(ref);
    expect(new TextDecoder().decode(out!)).toBe(BYTES_A);
    expect(await store.has(ref)).toBe(true);
  });

  it("returns null and has=false for a ref that was never written", async () => {
    const store = make();
    const ref = refFor(BYTES_A);
    expect(await store.get(ref)).toBeNull();
    expect(await store.has(ref)).toBe(false);
  });

  it("treats a second put of the SAME bytes as a no-op success (content is material)", async () => {
    // The mirror image of evidence-local's "refuses a second write": the same bytes
    // re-derived are the same material, so the second put must succeed, not throw.
    const store = make();
    const ref = refFor(BYTES_A);
    const bytes = new TextEncoder().encode(BYTES_A);
    await store.put(ref, bytes);
    await expect(store.put(ref, bytes)).resolves.toBeUndefined();
    expect(new TextDecoder().decode((await store.get(ref))!)).toBe(BYTES_A);
  });

  it("refuses bytes that do not hash to the ref's address", async () => {
    // A ref is a content address. Letting bytes land under a hash they do not produce
    // would make `has()` and every export verification a lie.
    const store = make();
    const ref = refFor(BYTES_A); // address of A
    await expect(store.put(ref, new TextEncoder().encode(BYTES_B))).rejects.toThrow(/does not match/i);
    expect(await store.has(ref)).toBe(false);
  });

  it("refuses a malformed ref at the boundary (traversal, bad hash, unknown kind/scope)", async () => {
    const store = make();
    const bytes = new TextEncoder().encode(BYTES_A);
    const badRefs = [
      "",                                                          // empty
      "npx:stage-output:" + "a".repeat(64),                        // missing scope
      "npx:stage-output:" + "A".repeat(64) + ":local-bundle",      // uppercase hash
      "npx:stage-output:" + "a".repeat(63) + ":local-bundle",      // short hash
      "npx:prompt:" + "a".repeat(64) + ":local-bundle",            // unknown kind
      "npx:stage-output:" + "a".repeat(64) + ":everywhere",        // unknown scope
      "file:stage-output:" + "a".repeat(64) + ":local-bundle",     // wrong scheme
      "npx:stage-output:../../etc/passwd:local-bundle",            // traversal-shaped
    ];
    for (const bad of badRefs) {
      await expect(store.put(bad, bytes), bad).rejects.toThrow();
      await expect(store.get(bad)).rejects.toThrow();
      await expect(store.has(bad)).rejects.toThrow();
    }
  });

  it("dedups across kinds and scopes: same bytes land on ONE file", async () => {
    // The scope_hint is advisory; the hash is the identity. Two refs differing only in
    // kind/scope name the same material and must share one stored copy.
    const store = make();
    const a = new TextEncoder().encode(BYTES_A);
    await store.put(refFor(BYTES_A, "stage-output", "local-bundle"), a);
    await store.put(refFor(BYTES_A, "stage-input", "db"), a);
    expect(await store.has(refFor(BYTES_A, "stage-output", "local-bundle"))).toBe(true);
    expect(await store.has(refFor(BYTES_A, "stage-input", "db"))).toBe(true);
    expect(await store.has(refFor(BYTES_A, "stage-input", "local-bundle"))).toBe(true);
  });

  it("keeps different bytes under different addresses", async () => {
    const store = make();
    await store.put(refFor(BYTES_A), new TextEncoder().encode(BYTES_A));
    await store.put(refFor(BYTES_B), new TextEncoder().encode(BYTES_B));
    expect(new TextDecoder().decode((await store.get(refFor(BYTES_A)))!)).toBe(BYTES_A);
    expect(new TextDecoder().decode((await store.get(refFor(BYTES_B)))!)).toBe(BYTES_B);
  });

  it("survives concurrent puts of the same bytes (one wx winner, both succeed)", async () => {
    const store = make();
    const ref = refFor(BYTES_A);
    const bytes = new TextEncoder().encode(BYTES_A);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.put(ref, bytes)));
    // No writer may fail: the wx loser re-verifies and reports a no-op success.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await store.has(ref)).toBe(true);
  });

  it("survives concurrent puts of distinct content", async () => {
    const store = make();
    const refs = Array.from({ length: 32 }, (_, i) => refFor(`content-${i}`));
    await Promise.all(refs.map((r, i) => store.put(r, new TextEncoder().encode(`content-${i}`))));
    for (const [i, r] of refs.entries()) {
      expect(await store.has(r), r).toBe(true);
      expect(new TextDecoder().decode((await store.get(r))!)).toBe(`content-${i}`);
    }
  });

  it("shards content by the first two hash characters", async () => {
    const root = mkroot();
    const store = new LocalContentStore(root);
    const refs = Array.from({ length: 8 }, (_, i) => refFor(`shard-${i}`));
    for (const [i, r] of refs.entries()) {
      await store.put(r, new TextEncoder().encode(`shard-${i}`));
    }
    const shards = readdirSync(root);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.every((d) => /^[0-9a-f]{2}$/.test(d))).toBe(true);
  });

  it("declares where it retains", async () => {
    expect(["LOCAL_BUNDLE", "DB", "EXPORT"]).toContain(make().retention_scope);
  });

  it("get throws on a corrupted resident file instead of returning unverified bytes", async () => {
    // A store that returns bytes it cannot vouch for breaks the export verification
    // chain — corruption must surface, not ride along.
    const root = mkroot();
    const store = new LocalContentStore(root);
    const ref = refFor(BYTES_A);
    await store.put(ref, new TextEncoder().encode(BYTES_A));
    const hash = sha256(BYTES_A);
    const file = join(root, hash.slice(0, 2), `${hash.slice(2)}.bin`);
    writeFileSync(file, "tampered bytes");
    await expect(store.get(ref)).rejects.toThrow(/corruption/i);
  });

  it("has() reports a corrupted file as NOT intact, rather than merely present", async () => {
    /**
     * The gap this closes. `has` was `existsSync(path)` and nothing more, so a tampered
     * file answered `true` while `get` on the same file threw. `has` is the oracle behind
     * the `dangling-ref` promotion precondition, which means the gate built to stop a
     * promotion certifying unreachable evidence was the one caller that could not see
     * corrupt evidence.
     *
     * It throws rather than returning false, matching `get` and matching what
     * `decidePromotion` requires of its oracle: a broken store must not be able to
     * masquerade as "all content gone".
     */
    const root = mkroot();
    const store = new LocalContentStore(root);
    const ref = refFor(BYTES_A);
    await store.put(ref, new TextEncoder().encode(BYTES_A));
    expect(await store.has(ref)).toBe(true);

    const hash = sha256(BYTES_A);
    writeFileSync(join(root, hash.slice(0, 2), `${hash.slice(2)}.bin`), "tampered bytes");
    await expect(store.has(ref)).rejects.toThrow(/corruption/i);
  });

  it("has() still returns false for content that is simply absent", async () => {
    // The must-not-throw half: an evicted or never-written ref is a plain `false`, not an
    // error. Without this, a `has` that threw on everything would satisfy the case above.
    const store = new LocalContentStore(mkroot());
    expect(await store.has(refFor("never written"))).toBe(false);
  });

  it("get() returns null for absent content without a pre-existence check", async () => {
    // `get` used to `existsSync` and then read, so content evicted between the two
    // rejected with ENOENT instead of returning the documented null — and eviction is the
    // exact scenario this plane exists to survive. Reading first makes ENOENT the answer.
    const store = new LocalContentStore(mkroot());
    await expect(store.get(refFor("never written"))).resolves.toBeNull();
  });

  it("detects corruption on a duplicate put instead of blessing it", async () => {
    const root = mkroot();
    const store = new LocalContentStore(root);
    const ref = refFor(BYTES_A);
    await store.put(ref, new TextEncoder().encode(BYTES_A));
    const hash = sha256(BYTES_A);
    const file = join(root, hash.slice(0, 2), `${hash.slice(2)}.bin`);
    writeFileSync(file, "tampered bytes");
    await expect(store.put(ref, new TextEncoder().encode(BYTES_A))).rejects.toThrow(/corruption/i);
  });
});

describe("ContentStore conformance covers every implementation", () => {
  it("exercises each adapter that implements the port", () => {
    const covered = new Set(IMPLEMENTATIONS.map(([name]) => name));
    const found = readdirSync("adapters", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => {
        try {
          return readFileSync(join("adapters", e.name, "src/index.ts"), "utf8")
            .includes("implements ContentStore");
        } catch { return false; }
      })
      .map((e) => e.name);

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((name) => !covered.has(name))).toEqual([]);
  });
});
