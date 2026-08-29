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
