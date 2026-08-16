#!/usr/bin/env tsx
/**
 * Differential oracle — the ported TypeScript gates against the frozen Python linter.
 *
 * ## Why this is not the parity suite
 *
 * Parity compares two implementations of one design and catches drift between
 * them. It is structurally blind to a defect they *share*: when both are wrong
 * the same way, they agree and the harness reports green. The frozen fixture
 * corpus documents three shipped bugs that were invisible for exactly that
 * reason — a default substituted for a caller-supplied zero, a citation that
 * declared itself inside an empty ledger, and a multi-citation regex that
 * dropped every id after the first.
 *
 * `core/gates/*.ts` is a port of `sources/v5/prompt_lint.py`. Every defect in
 * that linter will be reproduced faithfully by the port, and no test written
 * against the port can see it. So the port is checked against the thing it came
 * from — not as a migration step, but standing, because the moment there is only
 * one implementation this class of defect becomes invisible again.
 *
 *   npm run differential              # 40 fixtures + 120 generated cases
 *   npm run differential -- --n 800   # longer run
 *   npm run differential -- --seed 7  # a different corpus, reproducibly
 *
 * Exit 0 only when the two implementations agree on every shared gate.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runGates, listGates } from "../core/src/gates/registry.js";
import type { GateResult, Verdict } from "../contracts/index.js";

const LINTER = "sources/v5/prompt_lint.py";
const FIXTURES = "sources/v5/fixtures.json";

/* ── arguments ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const N = num("n", 120);
const SEED = num("seed", 1);
const VERBOSE = argv.includes("-v");

// Zero cases is not a pass. A bare or malformed --n once made a fuzzer run the
// loop zero times and exit 0 reporting agreement — a green build that compared
// nothing, which is worse than a red one.
if (!Number.isFinite(N) || N < 0 || !Number.isFinite(SEED)) {
  console.error(`differential: invalid arguments — n=${N}, seed=${SEED}`);
  console.error("  refusing to report agreement over an unusable corpus.");
  process.exit(2);
}

/* ── the shared gate set ─────────────────────────────────────────────────── */

// Only gates both implementations have can be compared. The Python linter emits
// 16; the port currently registers 2. Comparing outside the intersection would
// report a disagreement that is really just an unported gate.
const SHARED = new Set(listGates().map((g) => g.id));

/* ── options ─────────────────────────────────────────────────────────────── */

interface CaseOptions {
  safetyTier?: boolean;
  recursiveTarget?: boolean;
  ragTarget?: boolean;
  includeFences?: boolean;
  tokenBudget?: number;
  stakes?: string;
  naiveTokens?: number;
  provider?: string;
}

function toCliArgs(o: CaseOptions): string[] {
  const a: string[] = [];
  if (o.safetyTier) a.push("--safety-tier");
  if (o.recursiveTarget) a.push("--recursive-target");
  if (o.ragTarget) a.push("--rag-target");
  if (o.includeFences) a.push("--include-fences");
  if (o.tokenBudget !== undefined) a.push("--token-budget", String(o.tokenBudget));
  if (o.stakes) a.push("--stakes", o.stakes);
  if (o.naiveTokens !== undefined) a.push("--naive-tokens", String(o.naiveTokens));
  if (o.provider) a.push("--provider", o.provider);
  return a;
}

/* ── the two implementations ─────────────────────────────────────────────── */

/**
 * Python emits a finding only when a gate fires; absence means PASS.
 *
 * The linter signals status through its exit code — 0 PASS, 1 GATE_FAIL,
 * 3 DEGRADED, 2 usage error — so a non-zero exit is normal output here and only
 * exit 2 is a real failure. `execFileSync` throws on any of them, so the JSON is
 * read from the thrown error's stdout.
 */
function pythonVerdicts(text: string, o: CaseOptions): Map<string, Verdict> {
  let out: string;
  try {
    out = execFileSync("python", [LINTER, "-", "--json", ...toCliArgs(o)], {
      input: text,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 2 || typeof e.stdout !== "string" || !e.stdout.trim()) {
      throw new Error(`linter failed (exit ${e.status}): ${e.stderr ?? "no stderr"}`);
    }
    out = e.stdout; // 1 or 3 — a verdict, not an error
  }
  const parsed = JSON.parse(out) as { findings: Array<{ gate: string; severity: Verdict }> };
  const m = new Map<string, Verdict>();
  for (const id of SHARED) m.set(id, "PASS");
  for (const f of parsed.findings) if (SHARED.has(f.gate)) m.set(f.gate, f.severity);
  return m;
}

function tsVerdicts(text: string, o: CaseOptions): Map<string, Verdict> {
  const m = new Map<string, Verdict>();
  for (const r of runGates(text, { includeFences: o.includeFences }) as GateResult[]) {
    if (SHARED.has(r.gate_id)) m.set(r.gate_id, r.verdict);
  }
  return m;
}

/* ── generator ───────────────────────────────────────────────────────────── */

/** Seeded so any reported failure can be regenerated exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fragments sit on gate boundaries rather than in their middles — a 19-character
 * key beside a 20-character one, `100% accurate` beside `100%accurate`, a fence
 * that closes beside one that does not. Defects live on edges, and hand-written
 * cases only cover what their author already thought of.
 */
const FRAGMENTS: Array<() => string> = [
  () => "anti-override scope fact-grounding",
  () => "# SYSTEM PROMPT: Assistant",
  () => "Answer billing questions only.",

  // SECRET_LEAK_SCAN — on and just under each bound
  () => `sk-ant-${"a".repeat(20)}`,
  () => `sk-ant-${"a".repeat(19)}`,
  () => `sk-${"b".repeat(20)}`,
  () => `sk-${"b".repeat(19)}`,
  () => `AKIA${"C".repeat(16)}`,
  () => `AKIA${"C".repeat(15)}`,
  () => `ghp_${"d".repeat(30)}`,
  () => `ghp_${"d".repeat(29)}`,
  () => "xoxb-1234567890ab",
  () => "ops@corp.example.com",
  () => "+1 (415) 555-0100",
  () => "+1 415",

  // CLAIM_DISCIPLINE — inflections and the space that was once required
  () => "We guarantee it.",
  () => "guarantees",
  () => "guaranteed",
  () => "guaranteeing",
  () => "100% accurate",
  () => "100%accurate",
  () => "100%  safe",
  () => "100% deterministic",
  () => "100% wrong",
  () => "a guarantee-free zone",

  // fence structures — the CommonMark length rule and the unclosed case
  () => "```",
  () => "````",
  () => "```markdown",
  () => "`inline`",
  () => "`sk-ant-aaaaaaaaaaaaaaaaaaaa`",
  () => "``",
  () => "text after",
];

function generate(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 7);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]());
  return lines.join("\n") + "\n";
}

/* ── run ─────────────────────────────────────────────────────────────────── */

interface Disagreement {
  source: string;
  gate: string;
  python: Verdict;
  typescript: Verdict;
  text: string;
  options: CaseOptions;
}

const disagreements: Disagreement[] = [];
let compared = 0;

function compare(source: string, text: string, options: CaseOptions): void {
  const py = pythonVerdicts(text, options);
  const ts = tsVerdicts(text, options);
  for (const gate of SHARED) {
    compared++;
    const p = py.get(gate)!;
    const t = ts.get(gate)!;
    if (p !== t) disagreements.push({ source, gate, python: p, typescript: t, text, options });
  }
}

console.log(`differential — ${[...SHARED].join(", ")} (${SHARED.size} of 16 gates ported)\n`);

// 1. The frozen corpus. Eleven of these pin a defect that actually shipped.
const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as {
  cases: Array<{ name: string; text: string; options: CaseOptions; pad_to_chars?: number }>;
};

for (const c of fixtures.cases) {
  let text = c.text;
  if (c.pad_to_chars) text = text + "PAD".repeat(Math.ceil(c.pad_to_chars / 3));
  compare(`fixture:${c.name}`, text, c.options ?? {});
}
console.log(`  fixtures   ${fixtures.cases.length} cases`);

// 2. Generated cases on gate boundaries.
const rand = rng(SEED);
for (let i = 0; i < N; i++) {
  const text = generate(rand);
  const options: CaseOptions = rand() < 0.2 ? { includeFences: true } : {};
  compare(`generated:${SEED}:${i}`, text, options);
}
console.log(`  generated  ${N} cases (seed ${SEED})`);
console.log(`  compared   ${compared} gate verdicts\n`);

if (compared === 0) {
  console.error("differential: compared nothing. That is not agreement.");
  process.exit(2);
}

if (disagreements.length === 0) {
  console.log(`✓ the two implementations agree on every shared gate.`);
  process.exit(0);
}

console.error(`✗ ${disagreements.length} disagreement(s):\n`);
for (const d of disagreements.slice(0, 12)) {
  console.error(`  ${d.source} — ${d.gate}`);
  console.error(`    python=${d.python}  typescript=${d.typescript}  options=${JSON.stringify(d.options)}`);
  console.error(`    input: ${JSON.stringify(d.text.length > 200 ? d.text.slice(0, 200) + "…" : d.text)}`);
  if (VERBOSE) console.error();
}
if (disagreements.length > 12) console.error(`  … and ${disagreements.length - 12} more`);
console.error(`\nOne of the two is wrong. Neither can hide behind the other.`);
process.exit(1);
