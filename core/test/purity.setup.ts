// Purity instrumentation for the Core test suite.
//
// ADR-0005 makes Core purity an invariant rather than an aspiration: no network,
// filesystem, clock, or randomness. A rule nothing enforces is a claim in a document,
// which is the failure this project exists to correct.
//
// ## What this file catches — and what it does not
//
// This harness guards **globals**: `fetch`, `Math.random`, `Date.now`, and `new Date()`.
// Those are resolved at call time, so replacing them is enough to trap a call.
//
// It does **not** guard the filesystem, and until an audit probed it, three separate
// places — including this header — claimed it did. `readFileSync` inside a Core gate
// ran green. The gap is now covered by `scripts/check-boundaries.mjs`, which forbids
// `core/src/**` from importing `node:fs` and every other effectful builtin at all.
//
// ## Why the filesystem guard lives there and not here
//
// Patching `node:fs` at runtime does not work for this codebase, which was measured
// rather than assumed:
//
//     import { readFileSync } from "node:fs"   → NOT intercepted
//     import * as fs from "node:fs"            → NOT intercepted
//     (await import("node:fs")).readFileSync   → NOT intercepted
//     require("fs").readFileSync               → intercepted
//
// Node builds the ESM facade for a builtin by copying the CJS exports when the module
// is first evaluated, which happens while the test file's import graph loads — before
// any setup hook runs. Patching afterwards changes an object nothing reads. Only the
// CJS form, which looks the property up per call, can be trapped. Every Core module
// here uses static ESM imports, so a runtime filesystem guard would catch nothing
// while appearing to work. This note exists so the next person does not spend the
// afternoon rediscovering it.
//
// The two mechanisms fail differently, and neither subsumes the other:
//
//   - This harness traps an effect *performed during a test*, and is therefore bounded
//     by coverage — an earlier audit found a Core module it never watched because no
//     Core test imported it.
//   - The boundary check denies Core the *capability*, reading every file under
//     `core/src` whether or not a test runs it, but cannot see an effect handed in at
//     runtime.
//
// Deliberately NOT blocked: node:crypto hashing. A digest is deterministic — same
// input, same output, no ambient state — so it is pure in the sense that matters here.
//
// The guards arm per-test rather than per-file so the window is exactly the test body.
// Vitest reads source maps off disk when formatting a failure; a wider window would
// risk turning an ordinary assertion failure into a spurious purity violation.

import { beforeEach, afterEach } from "vitest";

const violation = (what: string) => () => {
  throw new Error(
    `Core purity violation: ${what} was called inside a Core test. ` +
      `Core must not perform I/O, read the clock, or use randomness. ` +
      `If this capability is genuinely needed, it belongs in the Application layer — see ADR-0005.`,
  );
};

const saved: Record<string, unknown> = {};

beforeEach(() => {
  saved.fetch = globalThis.fetch;
  saved.random = Math.random;
  saved.now = Date.now;
  saved.dateCtor = globalThis.Date;

  globalThis.fetch = violation("fetch()") as typeof fetch;
  Math.random = violation("Math.random()") as typeof Math.random;
  Date.now = violation("Date.now()") as typeof Date.now;

  // `new Date()` with no arguments reads the clock; `new Date(fixed)` does not.
  const RealDate = saved.dateCtor as DateConstructor;
  const GuardedDate = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length === 0) violation("new Date()")();
      return Reflect.construct(target, args as never);
    },
  });
  globalThis.Date = GuardedDate;
  globalThis.Date.now = violation("Date.now()") as typeof Date.now;
});

afterEach(() => {
  globalThis.fetch = saved.fetch as typeof fetch;
  Math.random = saved.random as typeof Math.random;
  globalThis.Date = saved.dateCtor as DateConstructor;
  Date.now = saved.now as typeof Date.now;
});
