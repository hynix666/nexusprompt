import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { KNOWN_FLAGS, flagError, callsPhrase } from "../scripts/run-eval.js";

/**
 * A flag this script does not have must REFUSE, not be ignored.
 *
 * The hole was found in the wild rather than by reading: every `npm run eval` command in
 * `proposals/external-analysis-2026-08/LOCAL_LLM_INTEGRATION_STUDY.md` passes
 * `--provider ollama-local`, a flag that has never existed here. Run as written, one of them
 * exits 0 at `score 1.000` — against pinned stubs, because transport is chosen by `--live` or
 * `--local` and neither was present.
 *
 * The output was never dishonest: it says "14 pinned provider call(s), no network" and the
 * run records `provenance.provider: pinned-stub`. That distinction is worth keeping straight,
 * because it decides what these tests are for. They do not protect the report. They protect
 * the operator from getting a correct answer to a question they did not ask.
 *
 * Most cases here call `flagError` directly. Two spawn the script, because "the decision is
 * right" and "the decision is wired to the exit code" are different failures, and this
 * repository keeps finding the second one.
 */

const SCRIPT = join(process.cwd(), "scripts/run-eval.ts");
const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");

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

/** argv as the script sees it — node, script path, then the operator's tokens. */
const argv = (...tokens: string[]): string[] => [process.execPath, SCRIPT, ...tokens];

describe("eval flags — must fire", () => {
  it("refuses the command the study actually recommends", () => {
    const { code, out } = run(["--provider", "ollama-local", "--model", "llama3.1:8b", "--max-calls", "100"]);
    expect(code).toBe(2);
    expect(out).toContain("unrecognised flag --provider");
    // The refusal has to say what to do instead, or it just moves the confusion.
    expect(out).toContain("--live or --local");
    // And nothing may have run: no score, no case tally.
    expect(out).not.toContain("score");
  });

  it("refuses --model when no transport can use it", () => {
    const { code, out } = run(["--model", "llama3.1:8b"]);
    expect(code).toBe(2);
    expect(out).toContain("--local was not given");
  });

  it("refuses the --flag=value form rather than silently ignoring it", () => {
    // `flagValue` matches an exact token, so `--trials=5` never set trials and ran one.
    expect(flagError(argv("--trials=5"))).toContain("unrecognised flag --trials=5");
  });

  it("names every unrecognised flag, not just the first", () => {
    const msg = flagError(argv("--provider", "x", "--verbose"));
    expect(msg).toContain("--provider");
    expect(msg).toContain("--verbose");
  });

  it("refuses --model under --live too, where it is equally inert", () => {
    expect(flagError(argv("--live", "--model", "claude-opus-5"))).toContain("--local was not given");
  });
});

describe("eval flags — must NOT fire", () => {
  // The half that matters more. A validator that rejects everything passes every test above.

  it("accepts the offline default, which takes no flags at all", () => {
    expect(flagError(argv())).toBeNull();
  });

  it.each([
    ["--live", "--dry-run", "--max-calls", "14"],
    ["--local", "--model", "llama3.1:8b"],
    ["--suite", "eval/compile-smoke.json"],
    ["--compare", "--json"],
    ["--trials", "10", "--max-calls", "140"],
  ])("accepts %s", (...tokens: string[]) => {
    expect(flagError(argv(...tokens))).toBeNull();
  });

  it("does not refuse a plain run because the shell exports OLLAMA_MODEL", () => {
    // Keyed on the flag, never the resolved model. `OLLAMA_MODEL` is a legitimate fallback,
    // and refusing the offline default on a machine that has one set would be a fine way to
    // make everyone pass --no-verify.
    expect(flagError(argv())).toBeNull();
    const { code } = run([], { OLLAMA_MODEL: "llama3.1:8b" });
    expect(code).toBe(0);
  });

  it("leaves a value that begins with a dash to the flag that consumes it", () => {
    // `--suite` takes the next token whatever it is; only tokens this script would have to
    // interpret as flags are checked.
    expect(flagError(argv("--suite", "eval/compile-smoke.json"))).toBeNull();
  });
});

describe("the accepted set is derived from the script, not maintained beside it", () => {
  /**
   * The check that keeps this from rotting.
   *
   * A hand-kept table is a sparse matcher: someone adds `process.argv.includes("--fast")` the
   * way the other nine were added, the table does not grow, and `--fast` starts being refused
   * — or worse, a value flag added the old way makes every use of it an error. So the names
   * are re-derived from the source that reads them.
   */
  const SOURCE = readFileSync(SCRIPT, "utf8");

  const literals = (): string[] => {
    const found = new Set<string>();
    for (const m of SOURCE.matchAll(/process\.argv\.(?:includes|indexOf)\("--([a-z-]+)"\)/g)) {
      found.add(m[1]!);
    }
    for (const m of SOURCE.matchAll(/(?:flagValue|intFlag)\("([a-z-]+)"\)/g)) found.add(m[1]!);
    return [...found].sort();
  };

  it("finds the flag reads it is supposed to find", () => {
    // The derivation is itself a matcher, and a matcher that silently matches nothing would
    // make the assertion below vacuously true. Pin the floor, not the exact set.
    const found = literals();
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found).toContain("live");
    expect(found).toContain("max-calls");
  });

  it("declares every flag the script reads", () => {
    const undeclared = literals().filter((n) => !(n in KNOWN_FLAGS));
    expect(undeclared, `read from argv but missing from KNOWN_FLAGS: ${undeclared.join(", ")}`)
      .toEqual([]);
  });

  it("declares nothing the script never reads", () => {
    // The other direction. A stale entry is how a removed flag goes on being accepted.
    const read = new Set(literals());
    const unread = Object.keys(KNOWN_FLAGS).filter((n) => !read.has(n));
    expect(unread, `declared in KNOWN_FLAGS but never read: ${unread.join(", ")}`).toEqual([]);
  });
});

describe("a run says which transport answered — all three of them", () => {
  /**
   * `LIVE ? "live" : "pinned"` was a two-way branch on a three-way choice, so `--local`
   * fell into the else. Measured: `--local --model phi4-mini:latest` took 69 seconds,
   * reached the daemon fourteen times, and reported `14 pinned provider call(s), no
   * network`. `provenance.provider` said `ollama-local` the whole time, so the artifact was
   * right and only the sentence a person reads was wrong — which is the exact gap between
   * evidence about a model and evidence about this accounting.
   *
   * Asserted on the pure phrase, so all three are covered with no daemon, no key and no
   * money. That is the point of extracting it.
   */
  it("does not call a local run pinned, or an offline one live", () => {
    expect(callsPhrase("stub", 14)).toBe("14 pinned provider call(s), no network");
    expect(callsPhrase("local", 14)).toBe("14 local provider call(s), loopback only");
    expect(callsPhrase("live", 14)).toBe("14 live provider call(s)");
  });

  it("never claims a run reached no network when it reached a model", () => {
    // The property, stated independently of the wording above: only the stub transport may
    // describe itself as pinned or as having touched no network.
    for (const t of ["local", "live"] as const) {
      expect(callsPhrase(t, 1)).not.toContain("pinned");
      expect(callsPhrase(t, 1)).not.toContain("no network");
    }
  });

  it("carries the call count through unchanged", () => {
    // A phrase that dropped the number would still satisfy every assertion above.
    expect(callsPhrase("local", 0)).toContain("0 ");
    expect(callsPhrase("local", 137)).toContain("137 ");
  });
});
