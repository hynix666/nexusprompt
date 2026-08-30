import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * `--dry-run`, driven the way a person drives it.
 *
 * `core/test/preflight.test.ts` covers the DECISION. This covers the WIRING, which is a
 * different failure and the one this repository keeps finding: a mechanism that reads as
 * enforced and is not. The specific risks here are that `--dry-run` is parsed but never
 * consulted, or that it prints a plan and then dispatches anyway — and neither is visible
 * from a unit test of `preflight`.
 *
 * Every case runs with a KEY-SHAPED value that is not a key. That is safe precisely because
 * the property under test is that nothing is dispatched; if this suite ever starts making
 * network calls, these are the tests that should fail first.
 */

const SCRIPT = join(process.cwd(), "scripts/run-eval.ts");
const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

/** Key-shaped, obviously not a key, long enough to clear `implausibleKeyReason`'s floor. */
const FAKE_KEY = `sk-ant-api03-NOT-A-REAL-KEY-used-only-to-prove-nothing-dispatches-${"x".repeat(40)}`;

function run(args: string[], env: Record<string, string | undefined> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [TSX, SCRIPT, ...args], {
      cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, OLLAMA_MODEL: undefined, ...env },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("eval --dry-run", () => {
  it("refuses without a real transport, rather than approving a plan that means nothing", () => {
    // A stubbed run reads no key, applies no budget and spends nothing. Printing a cheerful
    // free plan would leave the operator believing they had validated the run they meant.
    const { code, out } = run(["--dry-run"]);
    expect(code).toBe(2);
    expect(out).toContain("names neither --live nor --local");
  });

  it("plans a LOCAL run too, and says which transport it is for", () => {
    // `--dry-run` was written when there were two transports. A third arrived, and a dry run
    // that only understood the hosted one would send anyone planning a local run back to
    // finding out by starting it — which is the thing this flag exists to avoid.
    const { code, out } = run(
      ["--local", "--dry-run"],
      { OLLAMA_MODEL: "some-model" },
    );
    expect(code).toBe(0);
    expect(out).toContain("transport   local");
    expect(out).toContain("no cost");
    // No key and no budget are demanded of a transport that needs neither.
    expect(out).not.toContain("ANTHROPIC_API_KEY");
  });

  it("refuses a local run with no model named", () => {
    const { code, out } = run(["--local", "--dry-run"], { OLLAMA_MODEL: "" });
    expect(code).toBe(2);
    expect(out).toContain("no model named");
  });

  it("refuses --live and --local together", () => {
    // Accepting both would leave the composition root picking one silently, and the run would
    // record a `provenance.provider` the operator did not choose.
    const { code, out } = run(["--live", "--local"], { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(code).toBe(2);
    expect(out).toContain("two different transports");
  });

  it("approves a well-formed live plan and exits 0", () => {
    const { code, out } = run(
      ["--live", "--dry-run", "--trials", "3", "--max-calls", "42"],
      { ANTHROPIC_API_KEY: FAKE_KEY },
    );
    expect(code).toBe(0);
    expect(out).toContain("DRY RUN — nothing will be dispatched");
    expect(out).toContain("42 provider call(s)");
  });

  it("reports no cost block, because nothing ran", () => {
    // The live path prints `provider calls` / `tokens` / `usd` AFTER runSuite. Seeing any of
    // it here would mean the dry run dispatched and then claimed it had not.
    //
    // Stated rather than implied: this assertion's MUST-FIRE case is unproven. Making it fire
    // requires a run that actually dispatches, and the only mutation that produces one sends
    // fourteen requests to api.anthropic.com. The two tests above carry the proof instead —
    // removing `if (DRY_RUN) return 0;` fails both, caught at the wiring line before any
    // provider is constructed. This one is a cheap second net, not the evidence.
    const { out } = run(
      ["--live", "--dry-run", "--max-calls", "14"],
      { ANTHROPIC_API_KEY: FAKE_KEY },
    );
    expect(out).not.toContain("provider calls");
    expect(out).not.toContain("cache hits");
    expect(out).not.toContain("live provider —");
  });

  it("never prints the key, on any path", () => {
    // Four invocations, one per refusal, plus the approval. The value is key-shaped and
    // unique, so a leak anywhere in stdout or stderr is detectable by substring.
    const invocations: Array<[string[], Record<string, string>]> = [
      [["--live", "--dry-run"], { ANTHROPIC_API_KEY: FAKE_KEY }],
      [["--live", "--dry-run", "--max-calls", "1", "--trials", "9"], { ANTHROPIC_API_KEY: FAKE_KEY }],
      [["--live", "--dry-run", "--max-calls", "14"], { ANTHROPIC_API_KEY: FAKE_KEY }],
    ];
    for (const [args, env] of invocations) {
      const { out } = run(args, env);
      expect(out, args.join(" ")).not.toContain(FAKE_KEY);
      expect(out, args.join(" ")).not.toContain("NOT-A-REAL-KEY");
    }
  });

  describe("every refusal exits 2 — the code TRUTH_BOUNDARY.md pins", () => {
    // Not 3, which already means "degraded or gates warned" on every command here, and not a
    // new taxonomy: a refusal predicted by the dry run and a refusal enforced by the live run
    // are one decision, and they must not report different numbers for it.
    const cases: Array<[string, string[], Record<string, string>, string]> = [
      ["no key", ["--live", "--dry-run", "--max-calls", "14"], {}, "is not set"],
      ["implausible key", ["--live", "--dry-run", "--max-calls", "14"],
        { ANTHROPIC_API_KEY: "<your key>" }, "contains a bracket"],
      ["no budget", ["--live", "--dry-run"],
        { ANTHROPIC_API_KEY: FAKE_KEY }, "no budget declared"],
      ["budget too small", ["--live", "--dry-run", "--trials", "9", "--max-calls", "2"],
        { ANTHROPIC_API_KEY: FAKE_KEY }, "exceeds max_provider_calls"],
    ];
    for (const [name, args, env, needle] of cases) {
      it(name, () => {
        const { code, out } = run(args, env);
        expect(code, name).toBe(2);
        expect(out, name).toContain(needle);
      });
    }
  });

  it("suggests a budget equal to what it would actually plan", () => {
    // The suggested figure and the enforced figure come from one `plannedCalls` call, so the
    // command in the message is one a person can paste and have admitted. Copying it back is
    // the cheapest possible check that the two agree.
    const { out } = run(["--live", "--dry-run", "--trials", "3"], { ANTHROPIC_API_KEY: FAKE_KEY });
    const suggested = /--max-calls (\d+)/.exec(out)?.[1];
    expect(suggested).toBeDefined();

    const second = run(
      ["--live", "--dry-run", "--trials", "3", "--max-calls", suggested!],
      { ANTHROPIC_API_KEY: FAKE_KEY },
    );
    expect(second.code, `--max-calls ${suggested} was suggested but not admitted`).toBe(0);
  });
});
