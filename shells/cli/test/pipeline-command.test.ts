import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The `pipeline` command, driven the way a person drives it.
 *
 * Everything below this point had tests; the Shell had none, and the Shell is where wiring
 * bugs live — a composition root that names the wrong adapter, a flag that never reaches
 * the runner, an exit code that says the opposite of what happened. None of that is visible
 * from the Application layer down.
 *
 * These run the real CLI in a subprocess against a real `LocalRevisionStore`, with no API
 * key, so the run degrades. That is not a limitation of the test — it is the honesty
 * guarantee exercised end to end, through every layer, which is the one thing a unit test
 * of `runPipeline` cannot do.
 */

const CLI = join(process.cwd(), "shells/cli/src/index.ts");
/**
 * tsx by absolute path, run through this process's own node.
 *
 * `npx tsx` resolves from the working directory, and these tests deliberately run in a
 * temp directory so each gets its own `.nexusprompt` bundle store — so npx found no tsx
 * and every case failed with an empty stdout and a null exit status.
 */
const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

function runCli(args: string[]): { code: number; out: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "pnx-cli-"));
  temps.push(cwd);
  writeFileSync(join(cwd, "brief.txt"), "A support assistant for a SaaS billing team.\n");
  try {
    const out = execFileSync(process.execPath, [TSX, CLI, ...args.map((a) => (a === "BRIEF" ? join(cwd, "brief.txt") : a))], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      // No key: the run degrades, which is the path worth exercising through the Shell.
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });
    return { code: 0, out, cwd };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, cwd };
  }
}

const bundleOf = (cwd: string) => {
  const dir = join(cwd, ".nexusprompt", "runs");
  const file = readdirSync(dir)[0];
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as Array<Record<string, string>>;
};

describe("nexusprompt pipeline", () => {
  it("runs six stages at LOW stakes and eleven at SAFETY-CRITICAL", () => {
    // Depth derived from stakes, through the Shell. This binding existed in Core and was
    // never called until the pipeline was wired up here.
    const low = runCli(["pipeline", "BRIEF", "--stakes", "LOW"]);
    expect(low.out).toContain("6 stage(s)");
    expect(bundleOf(low.cwd)).toHaveLength(6);

    const critical = runCli(["pipeline", "BRIEF", "--stakes", "SAFETY-CRITICAL"]);
    expect(critical.out).toContain("11 stage(s)");
    expect(bundleOf(critical.cwd)).toHaveLength(11);
  }, 120_000);

  it("persists one bundle to real storage that reloads in stage order", () => {
    // The exit gate's "persists and reloads intact" rested entirely on an in-memory store
    // until this. LocalRevisionStore appends without sorting, so order survives the swap.
    const { cwd } = runCli(["pipeline", "BRIEF", "--stakes", "LOW"]);
    const entries = bundleOf(cwd);
    expect(entries.map((e) => e.stage_id)).toEqual([
      "deconstruct", "calibrate", "compile", "lint", "preview", "cost_estimate",
    ]);
    expect(new Set(entries.map((e) => e.run_id)).size).toBe(1);
    // Skips are in the bundle, so a short run records why it was short.
    expect(entries.find((e) => e.stage_id === "preview")!.status).toBe("SKIPPED");
  }, 120_000);

  it("says plainly that a degraded run is not model output, and exits 3", () => {
    const { code, out } = runCli(["pipeline", "BRIEF", "--stakes", "LOW"]);
    expect(code).toBe(3);
    expect(out).toContain("⟦WORKFLOW DEMO — no model⟧");
    expect(out).toContain("This run degraded");
    expect(out).toContain("not model output");
    // The reason is named, not just the symptom.
    expect(out).toContain("ANTHROPIC_API_KEY is not set");
  }, 120_000);

  it("does not spend a request on a placeholder", () => {
    // Every prompt-consuming stage declines once the build degrades. Found by running this
    // command: `critique` was the last one still calling out.
    const { out } = runCli(["pipeline", "BRIEF", "--stakes", "SAFETY-CRITICAL"]);
    for (const stage of ["harden", "critique", "refine", "critic", "preview", "tone_check"]) {
      expect(out, stage).toMatch(new RegExp(`skip\\s*\\x1b\\[0m ${stage}|skip.*${stage}`));
    }
  }, 120_000);

  it("prints usage and exits 2 when given no command", () => {
    const { code, out } = runCli([]);
    expect(code).toBe(2);
    expect(out).toContain("nexusprompt pipeline <file>");
    expect(out).toContain("--stakes");
  }, 120_000);
});

/**
 * `--max-calls`, driven the way a person drives it.
 *
 * The budget reaches the runner through the composition root, and a flag that never reaches
 * the runner is exactly the class of wiring bug this file exists for. Asserted through the
 * Shell for that reason: `runPipeline` accepting a `budget` proves nothing about whether the
 * CLI supplies one.
 */
describe("nexusprompt pipeline --max-calls", () => {
  it("refuses a run the cap cannot cover, and exits non-zero", () => {
    const r = runCli(["pipeline", "BRIEF", "--stakes", "SAFETY-CRITICAL", "--max-calls", "1"]);
    // 3 is the degraded-run code and 1 is a gate FAIL; a refusal is neither. It throws, so
    // the CLI dies with an uncaught error rather than reaching any of its own exit codes.
    expect([0, 1, 3]).not.toContain(r.code);
    expect(r.out).toMatch(/refused before dispatch/);
    // Nothing was persisted: a refused run is not a run, so the bundle store is never created.
    expect(existsSync(join(r.cwd, ".nexusprompt", "runs"))).toBe(false);
  });

  it("admits a run the cap covers — the must-not-refuse half", () => {
    // Without this, `--max-calls` could refuse unconditionally and still pass the case above.
    // 3, not 0: there is no API key here, so the run degrades — which is the honest outcome
    // and the same code the un-budgeted run above returns. What matters is that it RAN.
    const r = runCli(["pipeline", "BRIEF", "--stakes", "SAFETY-CRITICAL", "--max-calls", "999"]);
    expect(r.code).toBe(3);
    expect(r.out).not.toMatch(/refused before dispatch/);
    expect(existsSync(join(r.cwd, ".nexusprompt", "runs"))).toBe(true);
  });

  it("rejects a malformed cap instead of running unbounded", () => {
    // The dangerous failure is the quiet one: a flag that does not parse becoming a run with
    // no budget, while the operator believes a cap is in force.
    for (const bad of ["0", "-5", "abc", "2.5"]) {
      const r = runCli(["pipeline", "BRIEF", "--max-calls", bad]);
      expect(r.code, `--max-calls ${bad}`).toBe(2);
      expect(r.out, `--max-calls ${bad}`).toMatch(/must be a positive integer/);
    }
  });

  it("runs unbounded when the flag is absent, and says nothing about a budget", () => {
    const r = runCli(["pipeline", "BRIEF", "--stakes", "LOW"]);
    expect(r.code).toBe(3);
    expect(r.out).not.toMatch(/refused before dispatch|budget NOT enforced/);
  });
});

/**
 * `run` and `lint`, driven the way a person drives them.
 *
 * Neither had a single test. The whole CLI suite was `pipeline`, so the argument handling for
 * the other two commands was covered by nothing: reverting the file-argument fix entirely left
 * 1,315 of 1,316 tests passing, and the one failure was the artifact-hash CHECKSUM noticing the
 * bytes had changed — not a behavioural assertion. A repository whose discipline is that every
 * claim needs a checker had a shipped command with none.
 */
describe("nexusprompt run", () => {
  it("runs a stage against a brief", () => {
    // 3, not 0: no API key here, so the run degrades and says so. It RAN, which is the point.
    const r = runCli(["run", "--stage", "compile", "BRIEF"]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/compile/);
  });

  it("accepts the file before the flags too", () => {
    const r = runCli(["run", "BRIEF", "--stage", "compile"]);
    expect(r.code).toBe(3);
  });

  it("prints usage when the only argument is a flag's value", () => {
    // The bug the file-argument fix was written for: `argv[length-1]` resolved the file as
    // "compile" and died on ENOENT against a path named after the stage.
    const r = runCli(["run", "--stage", "compile"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/nexusprompt — usage/);
    expect(r.out).not.toMatch(/ENOENT/);
  });

  it("refuses a stage it cannot actually run, rather than running compile anyway", () => {
    // `run --stage harden BRIEF` used to print `Stage "compile" did not run against a model.`
    // The Orchestrator imports decide/reduce straight from compile.js and uses stage_id only
    // to LABEL the revision, so honouring the flag would record `harden` over compile's output.
    const r = runCli(["run", "--stage", "harden", "BRIEF"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--stage harden is not available/);
    // And it must not have run anything: no compile output.
    expect(r.out).not.toMatch(/did not run against a model/);
  });
});

describe("nexusprompt lint", () => {
  it("lints a file", () => {
    const r = runCli(["lint", "BRIEF"]);
    expect([0, 1, 3]).toContain(r.code);
    expect(r.out).toMatch(/gates ported/);
  });

  it("prints usage for a flag instead of reading a file named after it", () => {
    // `lint --foo` used to reach readFile and die on `ENOENT ... open '<cwd>/--foo'` — exactly
    // the confusing failure the file-argument fix exists to remove, one line above it.
    const r = runCli(["lint", "--foo"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/nexusprompt — usage/);
    expect(r.out).not.toMatch(/ENOENT/);
  });
});

describe("nexusprompt pipeline — flags before the file", () => {
  it("runs when a flag comes first", () => {
    // `pipeline --stakes HIGH BRIEF` exited 2 with the usage block: the guard required argv[1]
    // to be a non-flag. Same defect class as the two above, on the command with five
    // value-taking flags, so the most likely of the three to be hit.
    const r = runCli(["pipeline", "--stakes", "HIGH", "BRIEF"]);
    expect(r.code).toBe(3);
    expect(r.out).not.toMatch(/nexusprompt — usage/);
  });

  it("still prints usage when there is no file at all", () => {
    const r = runCli(["pipeline", "--stakes", "HIGH"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/nexusprompt — usage/);
  });
});

/**
 * The checker that watches for model swaps must read the directory the CLI writes.
 *
 * It did not. `check-fingerprint.mjs` had `const RUNS = ".promptnexus/runs"` — the
 * pre-ADR-0009 name — while `composePipeline` writes `.nexusprompt/runs`. So the watch read
 * a directory the product stopped using, counted one stale bundle left over from before the
 * rename, and reported "not armed" no matter how many runs happened. Its own remedy said to
 * "run the pipeline once to write a bundle to .promptnexus/runs", naming a command that
 * writes somewhere else.
 *
 * Nothing caught it because both halves were hard-coded and neither was asked about the
 * other — `bundleOf` above has read the right directory the whole time, in this same file.
 *
 * Driven end to end and DEGRADED on purpose: a keyless run persists revisions with null
 * fingerprints, which is enough to prove the two agree about where bundles live without
 * needing a model, a daemon or a key.
 */
describe("check:fingerprint reads what the CLI writes", () => {
  it("observes a bundle the CLI just persisted", async () => {
    const { code, cwd } = runCli(["pipeline", "BRIEF", "--stakes", "LOW"]);
    expect(code).toBe(3);  // degraded, which is the honest outcome with no provider

    const { observe } = await import("../../../scripts/check-fingerprint.mjs");
    const seen = observe(cwd);

    // Entries found — the directories agree. This is the assertion the bug broke: before
    // the fix `observe` looked under `.promptnexus/` and found nothing here at all.
    expect(seen.entries).toBeGreaterThan(0);

    // And every one is UNAVAILABLE rather than an observation, because no model answered.
    // A null fingerprint must never be counted as agreement about which model is live.
    expect(seen.unavailable).toBe(seen.entries);
    expect(seen.observations).toEqual([]);
  });
});

/**
 * `--timeout`, driven the way a person drives it.
 *
 * `composition-transport.test.ts` proves the number reaches the adapter. This proves the
 * flag reaches the composition root and that its refusals are wired to an exit code — the
 * two halves fail differently, and the Shell is where the second one breaks.
 */
describe("pipeline --timeout", () => {
  it("refuses without --model rather than silently doing nothing", () => {
    // The hosted proxy has its own timeout and this flag does not reach it. Accepting it
    // there is the shape of defect `--provider ollama-local` had in the eval runner:
    // a flag taken, ignored, and reported as success.
    const { code, out } = runCli(["pipeline", "BRIEF", "--stakes", "LOW", "--timeout", "300"]);
    expect(code).toBe(2);
    expect(out).toContain("--model was not given");
  });

  it.each([["0"], ["-5"], ["abc"], ["1.5"]])("refuses %s as a number of seconds", (bad) => {
    const { code, out } = runCli(["pipeline", "BRIEF", "--model", "m", "--timeout", bad]);
    expect(code).toBe(2);
    expect(out).toContain("positive whole number of seconds");
  });

  it("does not eat the filename — the value is consumed as a value", () => {
    // `--timeout` is in VALUE_FLAGS, so `fileArg` skips its argument. Without that the brief
    // would resolve to "300" and the run would die on ENOENT, which is the confusing failure
    // the flag-set test exists to prevent. Reaching a REFUSAL about the model proves the
    // filename was found and parsing got past it.
    const { code, out } = runCli(["pipeline", "--timeout", "300", "BRIEF"]);
    expect(code).toBe(2);
    expect(out).toContain("--model was not given");
    expect(out).not.toContain("ENOENT");
  });
});
