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
import { runGates, listGates, SOURCE_GATE_COUNT } from "../core/src/gates/registry.js";
import type { GateResult, Verdict } from "../contracts/index.js";

const LINTER = "sources/v5/prompt_lint.py";
const FIXTURES = "sources/v5/fixtures.json";
const PORTED = "scripts/ported-gates.json";
const ALLOWLIST = "scripts/divergence-allowlist.json";

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

/**
 * The intersection rule has a cost, found by mutation: unregister a gate and the
 * comparison silently shrinks while the oracle still exits 0. "Compared nothing is
 * not agreement" was guarded; "compared half as much as yesterday" was not.
 *
 * So the ported set is pinned in a committed file and checked before any comparison
 * runs. Refuses (exit 2) rather than failing (exit 1) — a mismatch means the harness
 * does not know what it is supposed to be comparing, which is a different situation
 * from the two implementations disagreeing.
 */
const manifest = JSON.parse(readFileSync(PORTED, "utf8")) as {
  source_gate_count: number;
  ported: string[];
};

const registered = [...SHARED].sort();
const declared = [...manifest.ported].sort();

if (registered.join(",") !== declared.join(",")) {
  const missing = declared.filter((g) => !SHARED.has(g));
  const extra = registered.filter((g) => !manifest.ported.includes(g));
  console.error(`differential: the registry and ${PORTED} disagree about what is ported.`);
  if (missing.length) console.error(`  declared but not registered: ${missing.join(", ")}`);
  if (extra.length) console.error(`  registered but not declared:  ${extra.join(", ")}`);
  console.error(`  Refusing to compare a gate set nobody declared.`);
  process.exit(2);
}

/**
 * The source gate count is a claim about a frozen artifact, so it is checked against
 * that artifact rather than trusted. `SOURCE_VERIFICATION.md` exists because a
 * documented gate count was wrong for months; a constant in code is no safer than a
 * number in a document unless something re-derives it.
 */
const emittedGateIds = new Set(
  [...readFileSync(LINTER, "utf8").matchAll(/"gate":\s*"([A-Z_]+)"/g)].map((m) => m[1]),
);

if (emittedGateIds.size !== manifest.source_gate_count || SOURCE_GATE_COUNT !== manifest.source_gate_count) {
  console.error(`differential: gate-count claims disagree with the frozen linter.`);
  console.error(`  ${LINTER} emits ${emittedGateIds.size} distinct gate ids`);
  console.error(`  ${PORTED} declares source_gate_count=${manifest.source_gate_count}`);
  console.error(`  core/src/gates/registry.ts declares SOURCE_GATE_COUNT=${SOURCE_GATE_COUNT}`);
  process.exit(2);
}

const unported = [...emittedGateIds].filter((g) => !SHARED.has(g)).sort();

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
  adversarial?: boolean;
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
  if (o.adversarial) a.push("--adversarial");
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
  // The WHOLE option set, not just includeFences. This narrowed the comparison for as long
  // as the TS side only understood one option: every option-gated gate was handed defaults
  // and compared against a Python run that had the flag, so the harness looked like it was
  // testing armed behaviour and never was. The R9 pattern — a guard whose scope is quieter
  // than its name — found here by porting gates that actually read the other options.
  for (const r of runGates(text, o) as GateResult[]) {
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

  /* ── boundaries for the thirteen gates ported in Phase 2 ────────────────────
     Added after a mutation probe: six planted defects were caught and FOUR
     SURVIVED, all in behaviours no generated input reached. The gates agreed with
     Python because both were correct, not because the corpus tested them — an
     oracle is only as good as the inputs it compares, which is R9 one level up. */

  // TOKEN_SPAM — the threshold is "more than 8", so 8 and 9 must both appear.
  () => "[ACK] ".repeat(8),
  () => "[ACK] ".repeat(9),
  () => "[EXEC] ".repeat(9),
  () => "[CLI] ".repeat(8),
  () => "[MEM_STATE] ".repeat(9),

  // DELIMITER_ENTROPY — on and either side of the 32-hex minimum.
  () => `[INPUT_START_${"a".repeat(31)}]`,
  () => `[INPUT_START_${"a".repeat(32)}]`,
  () => `[INPUT_START_${"f".repeat(33)}]`,
  () => "[INPUT_START_ab12cd]",
  () => `[INPUT_END_${"9".repeat(16)}]`,

  // PLACEHOLDER_AUDIT / RUNTIME_KEY_UNDECLARED
  () => "<<ROLE>>",
  () => "<<>>",
  () => "<<a<<b>>",
  () => "[[API_HOST]]",
  () => "# Runtime Variables\n[[API_HOST]]",
  () => "[[not a key!]]",

  // The citation pair, including the self-declaring case that silenced both.
  () => "As shown [S1].",
  () => "As shown [S1,S2].",
  () => "As shown [S1, S2,S3].",
  () => "As shown [S1, p. 42].",
  () => "# Source ledger\n\n| [S1] | a source |",
  () => "# Source ledger\n\nSee [S1] for details.",

  // GUARDRAIL_GAP — the word-boundary cases, and the stem that misses its inflection.
  () => "The estimator is unbiased.",
  () => "We check for biases.",
  () => "a telescope",
  () => "sanitization",
  () => "sanitisation",
  () => "recursion conflict",

  // RECURSION_MACHINERY_PRESENT / RAG_SHIELD_GAP — armed only by their options.
  () => "[ACTIVE_MEM_STATE]",
  () => "compilation depth",
  () => "{{COMPILATION_DEPTH}} {{STAKES_LEVEL}}",
  () => "meta-compiler",
  () => "insufficient_retrieval",
  () => "rejected_context",

  // DUPLICATE_INSTRUCTION — the 60-character floor, either side of it.
  () => "This instruction block is definitely longer than sixty characters in total.",
  () => "Short block under the floor, only fifty-nine chars long.",

  // An empty fragment, so `estimateTokens`'s floor of 1 is reachable: a one-character
  // input estimates 0 without it, which changes TOKEN_BUDGET at a budget of 0.
  () => "",
];

function generate(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 7);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]());
  return lines.join("\n") + "\n";
}

const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

/**
 * Options are generated, not fixed at `includeFences`.
 *
 * Eight of the fifteen ported gates do nothing until an option arms them, so a corpus
 * that only ever varied one flag left them comparing their not-armed branch forever.
 * `0` appears deliberately for both `tokenBudget` and `naiveTokens`: an explicit zero is
 * a real value on both, and the truthiness bug that treats it as absent shipped once on
 * each. `200` is there because est=1 over baseline 200 is the .005 boundary where
 * banker's rounding and half-up disagree — the divergence no parity test can see.
 */
function generateOptions(rand: () => number): CaseOptions {
  const o: CaseOptions = {};
  if (rand() < 0.2) o.includeFences = true;
  if (rand() < 0.25) o.safetyTier = true;
  if (rand() < 0.2) o.recursiveTarget = true;
  if (rand() < 0.2) o.ragTarget = true;
  if (rand() < 0.25) o.tokenBudget = pick(rand, [0, 1, 5, 50, 1000]);
  if (rand() < 0.25) {
    o.stakes = pick(rand, ["safety-critical", "high", "guarded", "medium", "low"]);
    if (rand() < 0.6) o.naiveTokens = pick(rand, [0, 1, 200, 400]);
  }
  if (rand() < 0.2) o.provider = pick(rand, ["anthropic", "openai", "google", "ollama"]);
  // Armed, both sides report "cannot score" — the frozen linter because it cannot locate
  // its scorer, the port because no corpus is injected here. That branch IS comparable and
  // is the only one that is: no reachable configuration makes the frozen linter score.
  if (rand() < 0.2) o.adversarial = true;
  return o;
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

/**
 * A deliberate difference from the source (ADR-0007 action item 2).
 *
 * Without this, a port that fixes a source defect can only get a green build by
 * un-fixing itself or by deleting the oracle. The ADR names that as the most likely
 * reason the oracle gets abandoned.
 *
 * Both verdicts are pinned, not just the fact of a difference: an entry saying only
 * "these may differ" would keep covering the case if the port later drifted to a third
 * verdict. Pinning both makes a change of shape a new decision.
 */
interface AllowedDivergence {
  gate: string;
  demonstration: { text: string; options?: CaseOptions };
  source_verdict: Verdict;
  port_verdict: Verdict;
  also_matches?: string;
  reason?: string;
  adr?: string;
}

const allowlist: AllowedDivergence[] = (() => {
  try {
    return JSON.parse(readFileSync(ALLOWLIST, "utf8")).entries ?? [];
  } catch (err) {
    console.error(`differential: cannot read ${ALLOWLIST} — ${(err as Error).message}`);
    console.error(`  Refusing to compare without knowing which differences are deliberate.`);
    process.exit(2);
  }
})();

/** Structural checks. These run before any comparison, so a malformed entry cannot excuse anything. */
const allowlistProblems: string[] = [];
for (const [i, e] of allowlist.entries()) {
  const at = `entry ${i} (${e.gate ?? "no gate"})`;
  if (!e.gate) allowlistProblems.push(`${at}: no gate named`);
  else if (!SHARED.has(e.gate)) {
    allowlistProblems.push(`${at}: ${e.gate} is not in the shared gate set — excusing a gate that is never compared`);
  }
  if (!e.reason?.trim()) allowlistProblems.push(`${at}: no reason. A difference without a stated reason is a defect.`);
  if (!e.adr?.trim()) allowlistProblems.push(`${at}: no ADR. Deliberate divergence is a decision and needs one.`);
  if (!e.demonstration?.text) allowlistProblems.push(`${at}: no demonstration input`);
  if (e.source_verdict === e.port_verdict) {
    allowlistProblems.push(`${at}: source_verdict equals port_verdict — that is agreement, not a divergence`);
  }
  if (e.also_matches) {
    try { new RegExp(e.also_matches); }
    catch { allowlistProblems.push(`${at}: also_matches is not a valid regex`); }
  }
}

const covers = (e: AllowedDivergence, d: Disagreement): boolean =>
  d.gate === e.gate &&
  d.python === e.source_verdict &&
  d.typescript === e.port_verdict &&
  (d.text === e.demonstration?.text || (!!e.also_matches && new RegExp(e.also_matches).test(d.text)));

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

console.log(
  `differential — ${[...SHARED].join(", ")} ` +
    `(${SHARED.size} of ${emittedGateIds.size} gates ported, verified against ${LINTER})`,
);
console.log(`  not yet ported: ${unported.join(", ")}\n`);

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
  const options: CaseOptions = generateOptions(rand);
  compare(`generated:${SEED}:${i}`, text, options);
}
console.log(`  generated  ${N} cases (seed ${SEED})`);

/**
 * Deterministic boundary cases, always run.
 *
 * Random generation cannot reliably hit a CONJUNCTION of a specific input and a specific
 * option — a one-character text AND `tokenBudget: 0` is roughly a 1-in-800 draw, so the
 * corpus was passing on luck. A mutation probe found three behaviours where a planted
 * defect survived for exactly that reason. These are the conjunctions written down.
 */
const BOUNDARY_CASES: Array<{ name: string; text: string; options: CaseOptions }> = [
  // estimateTokens' floor of 1: a 1-char input estimates 0 without it, which flips
  // TOKEN_BUDGET at a budget of 0 from FAIL to PASS.
  { name: "token-floor-empty", text: "\n", options: { tokenBudget: 0 } },
  { name: "token-floor-tiny", text: "ab", options: { tokenBudget: 0 } },
  { name: "token-floor-four", text: "abcd", options: { tokenBudget: 0 } },
  // The .005 rounding boundary: est 1 over baseline 200.
  { name: "qutm-half-boundary", text: "abcd", options: { stakes: "low", naiveTokens: 200 } },
  { name: "qutm-half-boundary-guarded", text: "abcd", options: { stakes: "guarded", naiveTokens: 200 } },
  { name: "qutm-baseline-zero", text: "abcd", options: { stakes: "low", naiveTokens: 0 } },
  /**
   * The rounding boundary that actually changes a verdict.
   *
   * A ratio of 0.005 rounds differently but lands nowhere near a ceiling, so the verdict
   * is PASS either way and the case proves nothing — a mutation to truncation survived it.
   * The value has to CROSS a ceiling: 1932 chars is 483 tokens, over a 400 baseline that
   * is 1.2075. Half-up gives 1.21 and fails the 1.2 ceiling for `low`; truncation gives
   * 1.20 and passes. That is the only shape in which rounding is observable.
   */
  { name: "qutm-ceiling-crossing", text: "a".repeat(1932), options: { stakes: "low", naiveTokens: 400 } },
  // DUPLICATE_INSTRUCTION needs BLANK-LINE-separated blocks; the generator joins with a
  // single newline, so its output is one paragraph and the gate was never really armed.
  {
    name: "duplicate-over-floor",
    text: "This instruction block is definitely longer than sixty characters.\n\nThis instruction block is definitely longer than sixty characters.\n",
    options: {},
  },
  {
    name: "duplicate-under-floor",
    text: "Only fifty-nine characters in this repeated little block.\n\nOnly fifty-nine characters in this repeated little block.\n",
    options: {},
  },
  {
    name: "duplicate-reflowed",
    text: "This instruction block is definitely longer than sixty characters.\n\nThis instruction block is\ndefinitely longer than sixty characters.\n",
    options: {},
  },
];
for (const c of BOUNDARY_CASES) compare(`boundary:${c.name}`, c.text, c.options);
console.log(`  boundary   ${BOUNDARY_CASES.length} conjunction cases`);

// 3. Each allowlist entry's own demonstration, run as a case.
//
// This is what makes staleness deterministic. A frozen fixture cannot be added — the
// corpus is hash-verified — and a generated case id moves with --n and --seed, so
// neither can anchor an entry's liveness. The entry carries its input instead, and an
// entry whose demonstration no longer produces the declared disagreement fails.
const demonstrationsBefore = disagreements.length;
for (const [i, e] of allowlist.entries()) {
  if (e.demonstration?.text) compare(`allowlist:${i}:${e.gate}`, e.demonstration.text, e.demonstration.options ?? {});
}
const demonstrated = disagreements.slice(demonstrationsBefore);
if (allowlist.length) console.log(`  allowlist  ${allowlist.length} declared divergence(s)`);
console.log(`  compared   ${compared} gate verdicts\n`);

for (const [i, e] of allowlist.entries()) {
  const proved = demonstrated.some((d) => d.source === `allowlist:${i}:${e.gate}` && covers(e, d));
  if (!proved) {
    allowlistProblems.push(
      `entry ${i} (${e.gate}): its demonstration no longer produces ` +
      `${e.source_verdict}/${e.port_verdict}. Either the divergence is gone — delete the entry — ` +
      `or it changed shape, which is a new decision.`,
    );
  }
}

if (allowlistProblems.length) {
  console.error(`differential: ${ALLOWLIST} is not usable:\n`);
  for (const p of allowlistProblems) console.error(`  ${p}`);
  console.error(`\nAn allowlist that is not checked is a place disagreements go to be forgotten.`);
  process.exit(2);
}

if (compared === 0) {
  console.error("differential: compared nothing. That is not agreement.");
  process.exit(2);
}

// Excuse only what a valid entry covers. Everything else is a live disagreement.
const excused = disagreements.filter((d) => allowlist.some((e) => covers(e, d)));
const live = disagreements.filter((d) => !allowlist.some((e) => covers(e, d)));

if (live.length === 0) {
  console.log(`✓ the two implementations agree on every shared gate.`);
  if (excused.length) {
    console.log(`  ${excused.length} verdict(s) differ deliberately, each declared in ${ALLOWLIST}`);
    console.log(`  with a reason and an ADR. The oracle is not being silenced — it is being told.`);
  }
  process.exit(0);
}

console.error(`✗ ${live.length} disagreement(s):\n`);
for (const d of live.slice(0, 12)) {
  console.error(`  ${d.source} — ${d.gate}`);
  console.error(`    python=${d.python}  typescript=${d.typescript}  options=${JSON.stringify(d.options)}`);
  console.error(`    input: ${JSON.stringify(d.text.length > 200 ? d.text.slice(0, 200) + "…" : d.text)}`);
  if (VERBOSE) console.error();
}
if (live.length > 12) console.error(`  … and ${live.length - 12} more`);
console.error(`\nOne of the two is wrong. Neither can hide behind the other.`);
console.error(`If the port is deliberately right and the source wrong, that is an entry in`);
console.error(`${ALLOWLIST} with a reason and an ADR — not a change to make this go quiet.`);
process.exit(1);
