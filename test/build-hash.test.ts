import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeBuildHash,
  checkBuildHash,
  isArtifactPath,
  normalise,
} from "../scripts/build-hash.mjs";

/**
 * The artifact hash, and the one property that makes it worth having.
 *
 * Phase 7's exit gate asks that *an independent build produce an identical artifact hash*.
 * "Independent" is the load-bearing word: a hash that agrees with itself on one machine
 * establishes nothing. `core.autocrlf` is `true` in this repository and `.gitattributes` pins
 * only `sources/**` to LF, so a Windows checkout and a Linux checkout of the same commit hold
 * DIFFERENT BYTES for every artifact file.
 *
 * The cross-platform case is provable here without a second machine: git's object store holds
 * exactly the bytes a Linux checkout receives, so reading `git show HEAD:<path>` is reading the
 * other platform's working tree. The first test compares that against the working tree, file by
 * file; the second builds both line-ending forms of one file and shows raw hashing separates
 * them while normalised hashing does not.
 *
 * The second test is written that way because its first version was not. It asserted that the
 * working tree DIFFERS from git's objects — true on the CRLF machine it was written on, false
 * on Linux, where CI failed it with "expected 0 to be greater than 0". A platform-specific
 * assertion inside a test for platform independence: the same mistake the hash was designed to
 * avoid, made one layer up, and caught on the first CI run.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Artifact files with no uncommitted modification.
 *
 * The comparison below is working tree against git's object store, and a legitimately dirty
 * file differs for a reason that has nothing to do with line endings. Restricting to
 * unmodified files removes that confound — without it the test fails during ordinary work and
 * gets deleted for being flaky, taking the only cross-platform evidence with it.
 */
const unmodifiedArtifactPaths = (): string[] => {
  const modified = new Set(git("diff", "--name-only", "HEAD").split("\n").filter(Boolean));
  return git("ls-files", "-z")
    .split("\0")
    .filter(Boolean)
    .filter(isArtifactPath)
    .filter((p) => !modified.has(p))
    .sort();
};

describe("build hash — the reproducibility property", () => {
  it("agrees with the bytes another platform would check out", () => {
    const paths = unmodifiedArtifactPaths();
    expect(paths.length).toBeGreaterThan(50); // else the comparison is near-vacuous

    const differing = paths.filter(
      (p) => normalise(readFileSync(join(repoRoot, p), "utf8")) !== normalise(git("show", `HEAD:${p}`)),
    );
    // Normalised content must be identical to what another platform checks out. This is the
    // whole reproducibility claim, file by file rather than as one digest, so a failure names
    // the file instead of reporting two hex strings that differ somewhere.
    expect(differing).toEqual([]);
  });

  it("would NOT have agreed without line-ending normalisation", () => {
    /**
     * The counter-example is SYNTHESISED, not read off the working tree.
     *
     * The first version of this test asserted that raw bytes differ from git's objects — true
     * on the CRLF checkout it was written on, and false on Linux, where it failed with
     * "expected 0 to be greater than 0". A platform-specific assertion inside a test for
     * platform independence: the same mistake the hash itself was designed to avoid, made one
     * layer up. CI caught it on the first run, which is the argument for CI.
     *
     * Building both line-ending forms here proves the property on any platform, and proves
     * more than the original did — it does not depend on the checkout being anything.
     */
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

    // A real artifact file, in both the forms the two platforms check out.
    const lf = git("show", `HEAD:${unmodifiedArtifactPaths()[0]}`).replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(lf).not.toBe(crlf); // the sample must contain line breaks, or this proves nothing

    // Raw byte-hashing: the two checkouts disagree. This is what the naive implementation gives.
    expect(sha(lf)).not.toBe(sha(crlf));

    // Normalised: they agree. This is what `build-hash.json` records, on either platform.
    expect(sha(normalise(lf))).toBe(sha(normalise(crlf)));
  });

  it("is deterministic, and agrees with the committed file count", () => {
    // Direct coverage of computeBuildHash. Running it twice on one tree must give one answer:
    // if a set or a directory walk leaked into the ordering, this is where it shows.
    const a = computeBuildHash(repoRoot);
    const b = computeBuildHash(repoRoot);
    expect(a.hash).toBe(b.hash);
    expect(a.entries).toEqual(b.entries);
    expect(a.files).toBe(JSON.parse(readFileSync(join(repoRoot, "build-hash.json"), "utf8")).files);
  });

  it("normalises CRLF and strips a BOM, and nothing else", () => {
    expect(normalise("a\r\nb")).toBe("a\nb");
    expect(normalise("﻿a")).toBe("a");
    expect(normalise("a\rb")).toBe("a\rb"); // a lone CR is content, not a line ending here
    expect(normalise("a\nb")).toBe("a\nb");
  });
});

describe("build hash — what it covers", () => {
  it("covers runtime source and the dependency pins", () => {
    for (const p of [
      "contracts/index.ts",
      "core/src/gates/registry.ts",
      "application/src/orchestrator.ts",
      "adapters/storage-local/src/index.ts",
      "shells/cli/src/index.ts",
      "package.json",
      "package-lock.json",
    ]) {
      expect({ p, included: isArtifactPath(p) }).toEqual({ p, included: true });
    }
  });

  it("excludes what is checked rather than shipped", () => {
    // A comment moving in a checker must not change the artifact hash. A hash that churns is
    // a hash people stop reading, and one nobody reads is worse than none — it looks like
    // provenance while proving nothing.
    for (const p of [
      "test/checkers.test.ts",
      "core/test/eval.test.ts",
      "adapters/storage-local/test/store.test.ts",
      "shells/api/test/index.test.ts",
      "scripts/check-counts.mjs",
      "spec/manifest-shapes.json",
      "Documentation/README.md",
      "build-hash.json",
      "node_modules/typescript/lib/tsc.js",
      "shells/api/node_modules/x.json",
    ]) {
      expect({ p, included: isArtifactPath(p) }).toEqual({ p, included: false });
    }
  });

  it("does not hash itself", () => {
    // Self-inclusion would make the hash unfixable: writing it changes the input.
    expect(isArtifactPath("build-hash.json")).toBe(false);
  });
});

describe("build hash — the check", () => {
  it("passes against the committed hash", () => {
    const r = checkBuildHash(repoRoot);
    expect({ ok: r.ok, fatal: r.fatal ?? null }).toEqual({ ok: true, fatal: null });
  });

  it("fires when a runtime source changes", () => {
    // Must-fire, without touching the tree: one artifact file reads differently.
    const r = checkBuildHash(repoRoot, {
      readFile: (p: string) =>
        p === "core/src/gates/registry.ts"
          ? "// a change nobody committed\n"
          : readFileSync(join(repoRoot, p), "utf8"),
    });
    expect(r.ok).toBe(false);
    expect(r.hash).not.toBe(r.committed);
  });

  it("reports a missing hash file as fatal, not as a mismatch", () => {
    // Different states deserve different exit codes: "no claim" is not "false claim".
    const r = checkBuildHash(join(repoRoot, "core"), { listTracked: () => [] });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/missing or unreadable/);
  });
});
