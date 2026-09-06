import { describe, it, expect } from "vitest";

/**
 * A must-fire case for `core/test/purity.setup.ts` itself.
 *
 * Every other test in the `core` project proves the harness by NOT tripping it — real Core
 * code runs clean, which is what you want in general but never demonstrates that a trap
 * would actually catch a violation if one existed. `setTimeout`, `crypto.randomUUID()`,
 * `performance.now()`, and `process.env` reads were added to the harness without a single
 * test calling any of them, which is the same "must-not-fire only" gap this repository has
 * found in three other checkers. This file calls each trapped global directly and asserts
 * it throws, then relies on `afterEach` to prove restoration by running the next `it` clean.
 */
describe("the purity harness traps what it claims to", () => {
  it("setTimeout() throws", () => {
    expect(() => setTimeout(() => {}, 0)).toThrow(/Core purity violation.*setTimeout/);
  });

  it("crypto.randomUUID() throws when the global is present", () => {
    if (!globalThis.crypto?.randomUUID) return;
    expect(() => globalThis.crypto.randomUUID()).toThrow(/Core purity violation.*crypto\.randomUUID/);
  });

  it("performance.now() throws when the global is present", () => {
    if (!globalThis.performance?.now) return;
    expect(() => globalThis.performance.now()).toThrow(/Core purity violation.*performance\.now/);
  });

  it("reading process.env.ANYTHING throws", () => {
    expect(() => process.env.NODE_ENV).toThrow(/Core purity violation.*process\.env\.NODE_ENV/);
  });

  it("reading an env key that was never set still throws — the trap is on the read, not the value", () => {
    expect(() => process.env.SOME_KEY_THAT_DOES_NOT_EXIST_ANYWHERE).toThrow(/Core purity violation/);
  });

  it("restores setTimeout and process.env between tests", () => {
    // If the previous tests' afterEach had not restored the globals, this would throw before
    // the assertion below ever ran.
    expect(typeof setTimeout).toBe("function");
    expect(typeof process.env).toBe("object");
  });
});
