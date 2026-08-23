/**
 * The seeded corpus generator, shared by the differential oracle and the gate-recall anchor.
 *
 * Pure: a seed in, text and options out. No clock, no filesystem, no randomness the caller
 * did not supply — which is what lets both consumers regenerate any reported case exactly.
 *
 * ── Why this moved out of `scripts/differential.ts` ──────────────────────────
 *
 * It was the oracle's private generator. The anchor needs the same inputs, and two copies of
 * a corpus generator is the drift bug this repository has already found in other shapes: the
 * two would agree on the day they were forked and diverge silently afterwards, and the
 * anchor's verdicts would stop being about the same input space the oracle validates.
 *
 * The extraction is byte-identical to what the oracle used, and the oracle's output is
 * unchanged: 40 fixtures + 120 generated + 10 boundary cases, 2,720 gate verdicts, agreeing.
 * That count is the regression test for this move.
 *
 * ── Why the fragments sit where they do ─────────────────────────────────────
 *
 * On gate boundaries rather than in their middles, and the comment below records what a
 * mutation probe found when they did not: six planted defects caught and four SURVIVED, all
 * in behaviours no generated input reached. An oracle is only as good as the inputs it
 * compares, and so is an anchor.
 */

/** Options that arm the gates. Eight of sixteen do nothing until one of these is set. */
export interface CaseOptions {
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

/** Seeded so any reported failure can be regenerated exactly. */
export function rng(seed: number) {
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
export const FRAGMENTS: Array<() => string> = [
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

export function generate(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 7);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]());
  return lines.join("\n") + "\n";
}

export const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

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
export function generateOptions(rand: () => number): CaseOptions {
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
