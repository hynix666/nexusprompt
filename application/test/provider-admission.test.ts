import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Sweep twelve — every path that can reach a provider passes through budget admission.
 *
 * This is the guard, not the instance. `application/src/pipeline.ts` reached a provider with
 * no admission until #40; `application/src/orchestrator.ts` did until sweep twelve found it the
 * same way — by asking which modules invoke a provider and which of those call `admitRun`.
 * Fixing the second instance without installing the question leaves the third to be found by
 * hand, which is how the first two were found.
 *
 * DERIVED, not enumerated. A hand-kept list of "modules that spend money" is the same sparse
 * matcher that let `check:hygiene` rule 6 miss `build-hash.json` — the list encodes what its
 * author imagined, and the gap is where the next defect lands. This reads the source.
 */

const SRC = join(process.cwd(), "application/src");

/** Every module under `application/src`, read once. */
const modules = (): Array<[name: string, text: string]> =>
  readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(join(SRC, f), "utf8")]);

/**
 * Comments stripped first. A module that only *mentions* `invokeWithRetry` in prose is not a
 * module that calls it — and this file's own predecessor matched a doc comment, which is the
 * mistake the CLI flag-reader made one sweep earlier.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Does this module dispatch to a provider itself?
 *
 * `.generate(` on ANY receiver, not just one spelled `provider`. The first version of this
 * predicate matched `provider.generate(` and therefore missed `this.inner.generate(` in both
 * `cache.ts` and `eval.ts` — a sparse matcher, which is precisely the defect class this file
 * exists to catch. It was caught by the stale-exemption rule below: `cache.ts` was declared a
 * delegate while the predicate insisted it did not dispatch, and one of the two had to be wrong.
 */
const dispatches = (text: string): boolean => {
  const c = code(text);
  return /\binvokeWithRetry\s*\(/.test(c) || /\.generate\s*\(/.test(c);
};

/** Does it decide admission before doing so? */
const admits = (text: string): boolean => /\badmitRun\s*\(/.test(code(text));

/**
 * Modules that dispatch on behalf of a caller that already admitted, or that wrap another
 * transport rather than reaching one. Each needs a reason, and the reason has to be about
 * WHY admission belongs elsewhere — not that it was inconvenient here.
 */
const DELEGATES: Record<string, string> = {
  "invoke.ts":
    "the shared retry loop itself — it is the thing being bounded, and every caller admits " +
    "before entering it. Admission here would be per-attempt, which is the wrong unit.",
  "cache.ts":
    "a wrapper. `CachingProvider` returns a hit without touching what it wraps, so it spends " +
    "nothing of its own; the recorder sits inside it precisely so a hit is not counted as a call.",
};

describe("every provider-reaching module admits before it spends", () => {
  it("the reader finds dispatchers — otherwise the check below is vacuous", () => {
    // Without this, a regex that silently stopped matching would make every module compliant.
    const found = modules().filter(([, t]) => dispatches(t)).map(([n]) => n).sort();
    expect(found.length).toBeGreaterThan(1);
    expect(found).toContain("pipeline.ts");
    expect(found).toContain("orchestrator.ts");
  });

  it("the reader ignores prose — a mention is not a call", () => {
    expect(dispatches("/** calls invokeWithRetry( eventually */")).toBe(false);
    expect(dispatches("// provider.generate( is called downstream")).toBe(false);
    expect(dispatches("const x = await invokeWithRetry({ provider });")).toBe(true);
    // Any receiver, because a wrapper holds its transport under whatever name it likes.
    expect(dispatches("const o = await this.inner.generate(req);")).toBe(true);
  });

  it("no module dispatches to a provider without admitting first", () => {
    const offenders = modules()
      .filter(([name, text]) => dispatches(text) && !admits(text) && !(name in DELEGATES))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("every delegation is declared with a reason, and only for modules that dispatch", () => {
    // A stale exemption is the failure mode `pending-implementation.json` guards the same way:
    // an entry that outlives its subject silently excuses the next one.
    for (const [name, reason] of Object.entries(DELEGATES)) {
      const mod = modules().find(([n]) => n === name);
      expect(mod, `${name} is exempted but does not exist`).toBeDefined();
      expect(dispatches(mod![1]), `${name} is exempted but does not dispatch`).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("catches a dispatcher that stops admitting", () => {
    // The planted defect, in the shape both real ones had: the dispatch stays, the admission
    // goes. Asserted against the predicates rather than the tree, so it cannot pass by accident.
    const planted = "const outcome = await invokeWithRetry({ provider, request });";
    expect(dispatches(planted)).toBe(true);
    expect(admits(planted)).toBe(false);
  });
});
