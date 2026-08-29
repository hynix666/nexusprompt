import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
 * exactly the bytes a Linux checkout receives, so hashing `git show HEAD:<path>` is hashing
 * the other platform's working tree. The first test does that, and also computes what a naive
 * byte-hashing implementation would have produced — which does NOT match, and would have
 * failed on its first CI run while passing locally.
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
    // The naive implementation, computed here rather than described, so the normalisation
    // cannot be deleted as redundant. This is what raw byte-hashing gives on a CRLF checkout.
    const paths = unmodifiedArtifactPaths();

    // Raw bytes: how many unmodified artifact files differ from the other platform's checkout
    // when nothing is normalised. On a CRLF working tree this is most of them.
    const rawDiffering = paths.filter(
      (p) => readFileSync(join(repoRoot, p), "utf8") !== git("show", `HEAD:${p}`),
    );

    // If this is empty the working tree stopped being CRLF, and the test above has quietly
    // stopped proving anything — find out why before trusting the hash across machines.
    expect(rawDiffering.length).toBeGreaterThan(0);

    // And the same files agree once normalised. Raw byte-hashing would have produced a hash
    // that differs by platform: green locally, red on its first CI run.
    const normalisedDiffering = rawDiffering.filter(
      (p) => normalise(readFileSync(join(repoRoot, p), "utf8")) !== normalise(git("show", `HEAD:${p}`)),
    );
    expect(normalisedDiffering).toEqual([]);
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
