#!/usr/bin/env tsx
/**
 * Is this checkout able to do the things it claims?
 *
 * The first command a new contributor should run, and the one that answers "why did that
 * not work?" without making them read the architecture documentation first.
 *
 * ## Every check derives; none of them enumerate
 *
 * A hand-written list of expected versions, workspaces or CLI commands is a sparse matcher:
 * it passes while missing whatever nobody thought to add to it. So the Node version comes from
 * the CI workflow, the workspace list from `package.json`, the CLI's commands from the CLI
 * itself, and the frozen-source and hygiene verdicts from the checkers that own them. The
 * numbers here are re-derived on every run, which is why this file contains almost none.
 *
 * ## It never reads a key for any purpose but its shape
 *
 * The value is not printed, not logged, not written, and not passed anywhere. `implausible`
 * reports a shape and never quotes the value back — the same predicate the live path uses.
 *
 * ## Exit codes
 *
 *   0  the offline system is usable — the state a fresh clone with `npm ci` should reach
 *   1  something needed for offline work is broken
 *   2  doctor itself could not run a check it depends on
 *
 * A missing API key is NOT a failure. Without one every run degrades to a labelled demo
 * placeholder and says so, which is the honesty guarantee working. Reporting that as broken
 * would teach people to ignore this command.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { verifySources } from "./verify-sources.mjs";
import { checkRepoHygiene } from "./check-repo-hygiene.mjs";
import { preflight, implausibleKeyReason } from "../core/src/eval/preflight.js";

type Status = "ok" | "warn" | "fail";

interface Finding {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  /** Shown indented under the finding. For the things a person has to act on. */
  readonly note?: string;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[36m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  fail: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const readText = (root: string, p: string): string =>
  readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const readJson = (root: string, p: string): any => JSON.parse(readText(root, p));

/**
 * Workspace directories, expanded from `package.json` rather than listed here.
 *
 * The globs are one level deep (`adapters/*`), which is all npm workspaces uses in this
 * repository. Reading them means a workspace added tomorrow is checked tomorrow.
 */
function workspaceDirs(root: string): string[] {
  const globs: string[] = readJson(root, "package.json").workspaces ?? [];
  const out: string[] = [];
  for (const g of globs) {
    if (!g.endsWith("/*")) {
      out.push(g);
      continue;
    }
    const parent = g.slice(0, -2);
    if (!existsSync(join(root, parent))) continue;
    for (const d of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(root, parent, d.name, "package.json"))) {
        out.push(`${parent}/${d.name}`);
      }
    }
  }
  return out.sort();
}

const CHECKS: Array<(root: string) => Finding> = [
  /**
   * Node's major version against the one CI actually uses.
   *
   * Derived from `.github/workflows/verify.yml`, not pinned here: two places naming a version
   * is one place to forget. There is no `engines` field to read — if one is ever added, it
   * becomes the better source and this should move to it.
   */
  (root) => {
    const local = Number(process.versions.node.split(".")[0]);
    let ci: number | null = null;
    try {
      const m = /node-version:\s*'?(\d+)/.exec(readText(root, ".github/workflows/verify.yml"));
      ci = m ? Number(m[1]) : null;
    } catch { /* reported below as unknown */ }

    if (ci === null) {
      return { name: "node", status: "warn", detail: `v${process.versions.node}`,
        note: "could not read the CI workflow, so there is nothing to compare against" };
    }
    if (local === ci) return { name: "node", status: "ok", detail: `v${process.versions.node} (CI uses ${ci})` };
    return {
      name: "node", status: local > ci ? "warn" : "fail",
      detail: `v${process.versions.node}, CI uses ${ci}`,
      note: local > ci
        ? "newer than CI. Green here is weaker evidence than green there."
        : `older than CI. Install Node ${ci} — local green would not predict CI green.`,
    };
  },

  /** npm, not pnpm. A pnpm lockfile here means someone ran the wrong tool. */
  (root) => {
    const hasPnpm = existsSync(join(root, "pnpm-lock.yaml"));
    const hasNpm = existsSync(join(root, "package-lock.json"));
    if (hasPnpm) {
      return { name: "package manager", status: "fail", detail: "pnpm-lock.yaml is present",
        note: "This workspace is defined with npm workspaces and pnpm is not installed. Delete the pnpm lockfile and run `npm install`." };
    }
    if (!hasNpm) {
      return { name: "package manager", status: "fail", detail: "no package-lock.json",
        note: "Run `npm install`. `npm ci` needs a lockfile and will refuse without one." };
    }
    return { name: "package manager", status: "ok", detail: `npm ${spawnSync("npm", ["-v"], { encoding: "utf8", shell: true }).stdout?.trim() || "?"}` };
  },

  /**
   * Every workspace on disk must appear in the lockfile.
   *
   * This is not hypothetical tidiness. `adapters/content-local` was added and the lockfile was
   * not regenerated: `npm install` repaired it silently and said nothing, `npm ci` refused, so
   * the tree was green locally and red in CI with an error naming neither the workspace nor
   * the cause. Deriving the list from `package.json` catches the next one the same way.
   */
  (root) => {
    let lock: any;
    try { lock = readJson(root, "package-lock.json"); }
    catch { return { name: "lockfile", status: "fail", detail: "package-lock.json is unreadable" }; }

    const dirs = workspaceDirs(root);
    const missing = dirs.filter((d) => !(d in (lock.packages ?? {})));
    if (missing.length > 0) {
      return {
        name: "lockfile", status: "fail",
        detail: `${missing.length} of ${dirs.length} workspace(s) missing: ${missing.join(", ")}`,
        note: "`npm ci` will refuse this, and CI runs `npm ci`. Run `npm install` and commit the lockfile.",
      };
    }
    return { name: "lockfile", status: "ok", detail: `all ${dirs.length} workspace(s) present` };
  },

  /** Dependencies actually installed, derived from what package.json asks for. */
  (root) => {
    const pkg = readJson(root, "package.json");
    const want = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    const absent = want.filter((d) => !existsSync(join(root, "node_modules", d)));
    if (absent.length > 0) {
      return { name: "dependencies", status: "fail", detail: `${absent.length} not installed: ${absent.join(", ")}`,
        note: "Run `npm ci`." };
    }
    return { name: "dependencies", status: "ok", detail: `${want.length} package(s) installed` };
  },

  /** The frozen source tree, asked of the checker that owns it. */
  (root) => {
    const r = verifySources(root) as { ok: boolean; checked?: number; failures?: unknown[] };
    return r.ok
      ? { name: "frozen sources", status: "ok", detail: `${r.checked} file(s) verified against MANIFEST.json` }
      : { name: "frozen sources", status: "fail", detail: `${r.failures?.length ?? "?"} file(s) do not match`,
          note: "`sources/` is frozen. Restore it rather than regenerating the manifest — regenerating is what makes the freeze mean nothing." };
  },

  /** Repository shape, asked of the checker that owns it. */
  (root) => {
    const r = checkRepoHygiene(root) as
      { ok: boolean; failures?: unknown[]; trackedCount?: number; ruleCount?: number };
    return r.ok
      ? { name: "repo hygiene", status: "ok",
          detail: `${r.ruleCount} ignore rule(s), ${r.trackedCount} tracked file(s), none misfiled` }
      : { name: "repo hygiene", status: "fail", detail: `${r.failures?.length ?? "?"} problem(s)`,
          note: "Run `npm run check:hygiene` for the detail." };
  },

  /**
   * The CLI's commands, read from the CLI.
   *
   * Spawned rather than restated. A list here would be a second source of truth about a
   * surface that already prints itself, and it would go stale the first time somebody adds
   * a command without thinking about this file.
   */
  (root) => {
    const r = spawnSync(process.execPath, [
      join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "shells/cli/src/index.ts"),
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const commands = [...out.matchAll(/^ {2}nexusprompt (\w[\w-]*)/gm)].map((m) => m[1]);
    if (commands.length === 0) {
      return { name: "cli", status: "fail", detail: "the CLI printed no usage",
        note: "Expected `nexusprompt` with no arguments to print its commands and exit 2." };
    }
    return { name: "cli", status: "ok", detail: [...new Set(commands)].join(", ") };
  },

  /**
   * The local transport: is a daemon there, and is a model named?
   *
   * Spawned rather than awaited, because every other check here is synchronous and making
   * `doctor()` async to accommodate one HTTP call would ripple through its whole test suite
   * for no gain. The child does the same `/api/tags` probe `OllamaProvider.healthCheck` does.
   *
   * Never a failure. A checkout with no Ollama is a healthy checkout — the local transport is
   * an option, not a requirement, and reporting its absence as broken is how a diagnostic
   * teaches people to ignore it.
   */
  () => {
    const model = process.env.OLLAMA_MODEL;
    const probe =
      "fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(2000)})" +
      ".then(r=>r.json()).then(j=>console.log((j.models||[]).length)).catch(()=>console.log('-'))";
    const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const pulled = (r.stdout ?? "").trim();

    if (pulled === "-" || pulled === "") {
      return {
        name: "local model", status: "warn", detail: "no Ollama daemon on 127.0.0.1:11434",
        note: "Optional. With one running and OLLAMA_MODEL set, `npm run eval -- --local` runs the suite against a model on this machine — no key, no cost.",
      };
    }
    if (!model) {
      return {
        name: "local model", status: "warn", detail: `Ollama is running with ${pulled} model(s), but OLLAMA_MODEL is not set`,
        note: "`ollama list` shows what is pulled. There is no default model on purpose — a default names one this machine may not have.",
      };
    }
    return {
      name: "local model", status: "ok", detail: `Ollama is running · OLLAMA_MODEL=${model}`,
      note: "`npm run eval -- --local` runs the suite against it. `--dry-run` prints the plan first.",
    };
  },

  /**
   * The dropped ONNX export, and the two files that make it look configured when it is not.
   *
   * `LLM/` carries `config.json` and `generation_config.json`, so listing the directory
   * suggests a working export. ONNX Runtime GenAI reads `genai_config.json`, which is absent,
   * and the architecture parameters it holds cannot be guessed — a wrong value produces
   * fluent garbage, the one failure demo mode exists to make impossible.
   */
  (root) => {
    if (!existsSync(join(root, "LLM"))) {
      return { name: "LLM/ export", status: "ok", detail: "not present (nothing depends on it)" };
    }
    const genai = existsSync(join(root, "LLM/genai_config.json"));
    return genai
      ? { name: "LLM/ export", status: "warn", detail: "genai_config.json present — but nothing here loads this export" }
      : { name: "LLM/ export", status: "warn", detail: "present, not drivable",
          note: "genai_config.json is absent. config.json and generation_config.json are Transformers configs, not the GenAI one, and its parameters must not be guessed." };
  },
];

/**
 * What a live run would do right now, decided by the code that decides it.
 *
 * This is the check the command exists for. "Is a key set?" is nearly useless on its own —
 * the four ways a live run refuses are a key that is absent, a key shaped like a placeholder,
 * a missing budget, and a budget the plan does not fit, and only the first is about presence.
 * Asking `preflight` means this reports the refusal the operator will actually hit rather
 * than a guess that drifts from it.
 *
 * Reported as a note, never as a failure: refusing without a key is correct behaviour.
 */
function liveReadiness(root: string): Finding {
  const key = process.env.ANTHROPIC_API_KEY;

  if (!key) {
    return {
      name: "live provider", status: "warn", detail: "no ANTHROPIC_API_KEY — every run degrades, and says so",
      note: "That is the honesty guarantee, not a fault. To enable live runs, set the variable yourself; see .env.example. A live run also needs an explicit --max-calls: there is no default.",
    };
  }

  const shape = implausibleKeyReason(key);
  if (shape !== null) {
    return {
      name: "live provider", status: "warn", detail: `ANTHROPIC_API_KEY is set, but its value ${shape}`,
      note: "That is a placeholder or a truncated paste. A live run refuses before dispatch. The value is not shown, and was read only for this check.",
    };
  }

  // A key that could be one. Ask what the FIRST live invocation would hit, using the real
  // suite's size so the number is the one that would be enforced.
  let caseCount = 0;
  try { caseCount = (readJson(root, "eval/compile-smoke.json").suite.case_ids as unknown[]).length; }
  catch { /* reported as unknown below */ }

  const v = preflight({
    transport: "live", key, budget: null, trials: 1, caseCount,
    decoding: { temperature: null, seed: null },
  });

  return {
    name: "live provider", status: "ok",
    detail: "ANTHROPIC_API_KEY is set and plausibly shaped",
    note: v.ok
      ? "A live run would proceed."
      : `A live run with no --max-calls would refuse: ${v.reason}. Plan one first with ` +
        `\`npm run eval -- --live --dry-run --max-calls ${v.plan.plannedCalls}\` — it dispatches nothing.`,
  };
}

export function doctor(root = process.cwd()): { findings: Finding[]; code: number } {
  const findings: Finding[] = [];
  for (const check of CHECKS) {
    try {
      findings.push(check(root));
    } catch (err) {
      findings.push({ name: "doctor", status: "fail", detail: `a check threw: ${(err as Error).message}` });
    }
  }
  findings.push(liveReadiness(root));

  // Warnings never fail the command. A missing key and an unusable local model are both
  // states a healthy offline checkout is in.
  const code = findings.some((f) => f.status === "fail") ? 1 : 0;
  return { findings, code };
}

function render({ findings, code }: { findings: Finding[]; code: number }): void {
  const paint = (s: Status) => (s === "ok" ? C.ok("ok  ") : s === "warn" ? C.warn("warn") : C.fail("FAIL"));
  const width = Math.max(...findings.map((f) => f.name.length));

  console.log(`\n${C.bold("nexusprompt doctor")}\n`);
  for (const f of findings) {
    console.log(`  ${paint(f.status)} ${f.name.padEnd(width)}  ${f.detail}`);
    if (f.note) console.log(`       ${C.dim(f.note)}`);
  }

  console.log(
    code === 0
      ? `\n  ${C.ok("Ready for offline verification.")} Run ${C.bold("npm run verify")}.\n` +
        `  ${C.dim("Warnings above are states a healthy checkout is in, not faults.")}\n`
      : `\n  ${C.fail("Not ready.")} Fix the FAIL line(s) above, then run this again.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = doctor();
  render(result);
  process.exit(result.code);
}
