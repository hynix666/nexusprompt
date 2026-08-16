// Purity instrumentation for the Core test suite.
//
// ADR-0005 makes Core purity an invariant rather than an aspiration: no network,
// filesystem, clock, or randomness. A rule nothing enforces is a claim in a document,
// which is the failure this project exists to correct. This harness makes a violation
// a test failure.
//
// Deliberately NOT blocked: node:crypto hashing. A digest is deterministic — same
// input, same output, no ambient state — so it is pure in the sense that matters here.

import { beforeAll, afterAll } from "vitest";

const violation = (what: string) => () => {
  throw new Error(
    `Core purity violation: ${what} was called inside a Core test. ` +
      `Core must not perform I/O, read the clock, or use randomness. ` +
      `If this capability is genuinely needed, it belongs in the Application layer — see ADR-0005.`,
  );
};

const saved: Record<string, unknown> = {};

beforeAll(() => {
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

afterAll(() => {
  globalThis.fetch = saved.fetch as typeof fetch;
  Math.random = saved.random as typeof Math.random;
  globalThis.Date = saved.dateCtor as DateConstructor;
  Date.now = saved.now as typeof Date.now;
});
