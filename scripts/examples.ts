#!/usr/bin/env tsx
/**
 * Worked examples, and a check that they still do what they say.
 *
 *   npm run example:lint        gates firing, and not firing, on four real prompts
 *   npm run example:pipeline    an eleven-stage run with no provider — it DEGRADES
 *   npm run example:refuse      a live run with no key — it REFUSES
 *   npm run check:examples      fails when any of the three drifts from its expected output
 *   npm run docs:examples       regenerates the expected outputs
 *
 * ## Why the third one exists
 *
 * `example:pipeline` and `example:refuse` are the two halves of the distinction this
 * repository is built around, and reading them side by side is the fastest way to understand
 * it. A pipeline run with no provider DEGRADES: it produces an artifact, labels every stage
 * that never reached a model, and exits 3. A live run with no key REFUSES: it produces
 * nothing, spends nothing, and exits 2. "We could not have seen anything" and "we looked and
 * saw nothing" are different answers, and a system that collapsed them would be lying in the
 * cheaper direction.
 *
 * ## Expected outputs are compared, not just stored
 *
 * `check:examples` regenerates and diffs, in the same generate-then-compare shape as
 * `check:matrix`, `check:truth` and `check:anchor`. There is no update flag on the check, so
 * accepting a change means running `docs:examples` and committing a diff somebody reads.
 *
 * ## Nothing here reads the developer's environment
 *
 * Every subprocess runs with `ANTHROPIC_API_KEY` deleted. An example whose output depended on
 * whether the person running it happened to have a key would be useless as an example and
 * undiffable as a check — and `example:refuse` would stop demonstrating a refusal on exactly
 * the machines that can afford a live run.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_DIR = "examples/expected";
const PROMPTS_DIR = "examples/prompts";
const BRIEF = "examples/briefs/support-bot.md";

const TSX = "node_modules/tsx/dist/cli.mjs";
const CLI = "shells/cli/src/index.ts";
const EVAL = "scripts/run-eval.ts";

/**
 * Everything that makes one run differ from the next, removed.
 *
 * A run id, a revision id and a wall-clock duration are all real output and none of them are
 * the behaviour under test. Leaving them in would make the check fail on every run, which is
 * the fastest way to get a check deleted.
 */
function normalise(raw: string, root: string): string {
  return raw
    // ANSI colour. The CLI paints unconditionally, so this is present even when piped.
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    // Absolute paths, so the expected file is the same on every machine.
    .split(root).join(".")
    .replace(/\\/g, "/")
    .replace(/\brun [0-9a-f]{16}\b/g, "run <RUN_ID>")
    .replace(/\brevision [0-9a-f]{8}\b/g, "revision <REVISION>")
    .replace(/\bunder run [0-9a-f]{16}\b/g, "under run <RUN_ID>")
    .replace(/\b\d+(\.\d+)?ms\b/g, "<MS>")
    .replace(/[ \t]+$/gm, "")
    .trimEnd() + "\n";
}

interface Example {
  readonly id: string;
  readonly title: string;
  /** argv for the spawned process, relative to the repository root. */
  readonly argv: (root: string) => string[];
  /** The exit code this example is DEMONSTRATING. Not always 0. */
  readonly expectedCode: number;
}

const EXAMPLES: readonly Example[] = [
  {
    id: "lint",
    title: "gates firing, and not firing, on four real prompts — WARNs, exit 3",
    // Every prompt in the directory, discovered rather than listed: adding one and forgetting
    // to name it here would leave it silently unexercised.
    argv: () => [],
    // 3, not 0. Two of the four prompts trip a gate, which is the point of having them —
    // an examples directory where everything passes demonstrates nothing about the gates.
    expectedCode: 3,
  },
  {
    id: "pipeline",
    title: "eleven stages with no provider — DEGRADES, exit 3",
    argv: () => [TSX, CLI, "pipeline", BRIEF, "--stakes", "MEDIUM"],
    expectedCode: 3,
  },
  {
    id: "refuse",
    title: "a live run with no key — REFUSES, exit 2, nothing spent",
    argv: () => [TSX, EVAL, "--live", "--dry-run", "--max-calls", "14"],
    expectedCode: 2,
  },
];

function runProcess(root: string, argv: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, argv.map((a) => (a.includes("/") ? join(root, a) : a)), {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    // Deleted, never merely blank: the examples must read the same on a machine that has one.
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * The CLI's exit codes are not ordered by severity, so they cannot be aggregated with `max`.
 *
 * `0` is clean, `1` is a gate FAIL, `3` is a WARN or a degraded run. `Math.max` therefore
 * ranks a WARN above a FAIL and would report 3 for a set containing a hard failure — the
 * example would go on claiming everything merely warned. Found by the expected-code check
 * disagreeing on the first run, which is the check earning its place before it shipped.
 */
const SEVERITY: Record<number, number> = { 0: 0, 3: 1, 1: 2 };
const worseOf = (a: number, b: number): number =>
  (SEVERITY[b] ?? 99) > (SEVERITY[a] ?? 99) ? b : a;

/** The lint example runs every prompt in the directory and concatenates, in sorted order. */
function runLint(root: string): { code: number; out: string } {
  const files = readdirSync(join(root, PROMPTS_DIR)).filter((f) => f.endsWith(".md")).sort();
  let out = "";
  let worst = 0;
  for (const f of files) {
    const r = runProcess(root, [TSX, CLI, "lint", `${PROMPTS_DIR}/${f}`]);
    out += `${r.out}\n  exit ${r.code}\n\n${"─".repeat(72)}\n\n`;
    worst = worseOf(worst, r.code);
  }
  return { code: worst, out };
}

export function runExample(id: string, root = process.cwd()): { code: number; text: string } {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(`no example "${id}"`);
  const r = ex.id === "lint" ? runLint(root) : runProcess(root, ex.argv(root));
  const header =
    `# ${ex.id} — ${ex.title}\n` +
    `# regenerate: npm run docs:examples · check: npm run check:examples\n\n`;
  return { code: r.code, text: header + normalise(r.out, root) };
}

const expectedPath = (root: string, id: string) => join(root, EXPECTED_DIR, `${id}.txt`);

export function checkExamples(root = process.cwd()): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const ex of EXAMPLES) {
    const { code, text } = runExample(ex.id, root);

    if (code !== ex.expectedCode) {
      failures.push(
        `${ex.id}: exited ${code}, expected ${ex.expectedCode}. ` +
        `The exit code IS the demonstration here — ${ex.title}.`,
      );
    }

    const path = expectedPath(root, ex.id);
    if (!existsSync(path)) {
      failures.push(`${ex.id}: no expected output at ${EXPECTED_DIR}/${ex.id}.txt. Run \`npm run docs:examples\`.`);
      continue;
    }
    const want = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    if (want !== text) {
      const wl = want.split("\n");
      const gl = text.split("\n");
      const at = wl.findIndex((l, i) => l !== gl[i]);
      failures.push(
        `${ex.id}: output differs from ${EXPECTED_DIR}/${ex.id}.txt at line ${at + 1}.\n` +
        `      expected: ${JSON.stringify(wl[at] ?? "<end of file>")}\n` +
        `      actual:   ${JSON.stringify(gl[at] ?? "<end of file>")}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

function write(root: string): void {
  mkdirSync(join(root, EXPECTED_DIR), { recursive: true });
  for (const ex of EXAMPLES) {
    const { text } = runExample(ex.id, root);
    writeFileSync(expectedPath(root, ex.id), text);
    console.log(`docs:examples — wrote ${EXPECTED_DIR}/${ex.id}.txt`);
  }
}

function main(): number {
  const root = process.cwd();
  const argv = process.argv.slice(2);

  if (argv.includes("--write")) {
    write(root);
    return 0;
  }

  if (argv.includes("--check")) {
    const r = checkExamples(root);
    if (r.ok) {
      console.log(`check:examples — OK. ${EXAMPLES.length} example(s) still do what they say.`);
      return 0;
    }
    console.error(`check:examples — ${r.failures.length} example(s) drifted:\n`);
    for (const f of r.failures) console.error(`  ${f}\n`);
    console.error(
      "  An example is documentation that runs. If the new behaviour is correct, regenerate\n" +
      "  with `npm run docs:examples` and commit the diff — there is no update flag on the\n" +
      "  check, because accepting a change should be something somebody reads.",
    );
    return 1;
  }

  const id = EXAMPLES.map((e) => e.id).find((e) => argv.includes(`--${e}`));
  if (!id) {
    console.log(
      "usage: examples --lint | --pipeline | --refuse | --check | --write\n\n" +
      EXAMPLES.map((e) => `  --${e.id.padEnd(9)} ${e.title}`).join("\n"),
    );
    return 2;
  }

  const { code, text } = runExample(id, root);
  console.log(text);
  console.log(
    `  ${id} exited ${code}. That is the demonstration, not a fault — see the header above.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
