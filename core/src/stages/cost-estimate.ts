/**
 * The `cost_estimate` stage — pure. Frozen s10, "Cost Estimate", role `cost`.
 *
 * Like `lint`, no `decide`: the frozen template is empty and commented "deterministic —
 * local token/pricing calc, no API call, not editable". A stage that performs no effect
 * does not need the decide/invoke/reduce split ADR-0005 exists to enforce.
 *
 * **The rates are representative, not a live feed, and the report says so on every run.**
 * That sentence is ported verbatim from the source and is the honest part of this stage:
 * a number formatted to four decimal places reads as precision it does not have. Cost is a
 * correctness constraint here rather than an economic footnote — cost-driven degradation
 * (truncation, fallback to a weaker model, aggressive caching) degrades output without
 * tripping any alert — so an estimate that overstated its own authority would be worse
 * than none.
 */

import { estimateTokens } from "../gates/lint-primitives.js";

export const STAGE_ID = "cost_estimate" as const;

/**
 * Empty, and asserted to be empty — see the note in `lint.ts`. `check:stages` compares this
 * against the frozen s10 template, so a future drop that gives this stage a prompt fails
 * the build instead of being skipped.
 */
export const TEMPLATE = ``;

/**
 * Representative mid-tier rates in USD per million tokens, ported verbatim.
 *
 * Not fetched, not current, and not resolved from a user-typed model name. The zeroes for
 * self-hosted providers mean "no per-token charge", never "free" — compute is still spent.
 */
export const PRICING: Record<string, { label: string; in: number; out: number; note: string }> = {
  mock:      { label: "Mock · Offline", in: 0,    out: 0,     note: "offline demo — no network call" },
  anthropic: { label: "Anthropic",      in: 3.00, out: 15.00, note: "representative mid-tier rate" },
  openai:    { label: "OpenAI",         in: 2.50, out: 10.00, note: "representative mid-tier rate" },
  gemini:    { label: "Gemini",         in: 1.25, out: 5.00,  note: "representative mid-tier rate" },
  ollama:    { label: "Ollama",         in: 0,    out: 0,     note: "self-hosted — compute cost only" },
  lmstudio:  { label: "LM Studio",      in: 0,    out: 0,     note: "self-hosted — compute cost only" },
};

/** The reply length assumed for a per-call figure. An assumption, named as one. */
export const ASSUMED_REPLY_TOKENS = 500;

export const NO_PROMPT = "⚠ No compiled prompt to cost yet — run the build stages first.";

export interface CostRow {
  id: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  total: number;
  note: string;
}

export interface CostInput {
  prompt?: string;
  /** Marked with an arrow in the report. Absent marks nothing rather than guessing. */
  provider?: string;
}

export interface CostState {
  rows: CostRow[];
  report: string;
  /** The selected provider's total, formatted. Null when no known provider was named. */
  selected_total: string | null;
}

/**
 * `<$0.01` rather than `$0.0000` for a small non-zero cost.
 *
 * Ported verbatim, and the distinction is deliberate: `$0.0000` reads as free, and a cost
 * that rounds to nothing per call does not round to nothing per million calls.
 */
export const fmtUSD = (n: number): string =>
  n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function estimateCost(promptText: string): CostRow[] {
  const inputTokens = estimateTokens(promptText);
  const outputTokens = ASSUMED_REPLY_TOKENS;
  return Object.entries(PRICING).map(([id, rate]) => {
    const inputCost = (inputTokens / 1_000_000) * rate.in;
    const outputCost = (outputTokens / 1_000_000) * rate.out;
    return {
      id, label: rate.label, inputTokens, outputTokens,
      inputCost, outputCost, total: inputCost + outputCost, note: rate.note,
    };
  });
}

export function formatCost(rows: readonly CostRow[], provider?: string): string {
  const nameW = Math.max(...rows.map((r) => r.label.length)) + 1;
  const active = provider && PRICING[provider] ? PRICING[provider].label : "";
  return [
    `PROMPT SIZE — ~${rows[0].inputTokens} tok (est., 1 tok ≈ 4 chars) · assumed reply ≈ ${rows[0].outputTokens} tok`,
    ``,
    `EST. COST PER CALL, BY PROVIDER (system prompt once + one typical reply):`,
    ...rows.map((r) =>
      `${r.id === provider ? "→ " : "  "}${r.label.padEnd(nameW)} in ${fmtUSD(r.inputCost).padStart(7)}  out ${fmtUSD(r.outputCost).padStart(7)}  = ${fmtUSD(r.total).padStart(7)}   (${r.note})`,
    ),
    ``,
    `Representative rates only, not fetched live — verify against each provider's current pricing page before budgeting production usage. "${active}" is marked → as the active provider.`,
  ].join("\n");
}

export function run(input: CostInput): CostState {
  if (!input.prompt) {
    return { rows: [], report: NO_PROMPT, selected_total: null };
  }
  const rows = estimateCost(input.prompt);
  const selected = rows.find((r) => r.id === input.provider);
  return {
    rows,
    report: formatCost(rows, input.provider),
    // Null, not "$0.0000", when no known provider was named. A zero here would be a real
    // figure for a self-hosted provider and a fiction for an unnamed one.
    selected_total: selected ? fmtUSD(selected.total) : null,
  };
}
