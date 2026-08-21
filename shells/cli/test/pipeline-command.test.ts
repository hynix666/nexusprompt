import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
 * temp directory so each gets its own `.promptnexus` bundle store — so npx found no tsx
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
  const dir = join(cwd, ".promptnexus", "runs");
  const file = readdirSync(dir)[0];
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as Array<Record<string, string>>;
};

describe("promptnexus pipeline", () => {
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
    expect(out).toContain("promptnexus pipeline <file>");
    expect(out).toContain("--stakes");
  }, 120_000);
});
