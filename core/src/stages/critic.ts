/**
 * The `critic` stage — pure. Frozen s8, "Critic", role `critic`.
 *
 * Distinct from `critique` (s5), which is a different stage with a different id. s5 is the
 * strict reviewer running hard gates and benchmarks; s8 is the verification call at the end
 * of a Drafter → Lint → Critic chain, and it is told explicitly NOT to redo the
 * deterministic work: "Deterministic string checks already ran — do NOT count tokens or
 * hunt placeholders. Run reasoning checks only."
 *
 * **The frozen template is empty and the prompt is assembled at the call site.** Both the
 * system prompt and the user turn are ported verbatim from that call site rather than from
 * a template field, which is why `TEMPLATE` here is empty and `check:stages` compares it
 * against the frozen empty.
 *
 * It also carries a skip rule: the stage runs only at HIGH and SAFETY-CRITICAL stakes.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { buildRequest, failurePlaceholder, MAX_TOKENS, refuseForgedMarker } from "./stage-kit.js";

export const STAGE_ID = "critic" as const;

/** Empty, and asserted to be empty — the prompt is built below, not filled from a template. */
export const TEMPLATE = ``;

/** Ported verbatim. The critic gets its own identity, not the shared compiler one. */
export const CRITIC_SYSTEM = `You are the Critic in a Drafter → Lint → Critic verification chain (unified compiler v1.0). Deterministic string checks already ran — do NOT count tokens or hunt placeholders. Run reasoning checks only:
(a) guardrails and fallback are domain-specific, not boilerplate;
(b) no overclaiming — nothing stated as settled that the prompt's own body treats as uncertain;
(c) the compiled identity matches the brief and does not claim compiler/architect powers unless the brief asked for them;
(d) instructions are executable — a model reading this prompt would not have to guess at any material behavior.
Output EXACTLY this format — first line one of:
VERDICT: PASS
VERDICT: DEGRADED
VERDICT: GATE_FAIL
then up to 5 numbered findings, one line each, most material first. PASS may have zero findings. GATE_FAIL only for material scope/safety defects.`;

export type CriticVerdict = "PASS" | "DEGRADED" | "GATE_FAIL";

/** The stakes tiers at which the critic runs at all. */
export const CRITIC_STAKES = ["HIGH", "SAFETY-CRITICAL"] as const;

/** Ported verbatim, including the assumption tag it leaves behind. */
export const SKIPPED_MESSAGE =
  `[SKIPPED] Critic runs only at HIGH / SAFETY-CRITICAL stakes.\n` +
  `Degraded mode: the Lint verdict stands. [ASSUMPTION:self_verified_no_critic]`;

export interface CriticInput {
  prompt: string;
  /** The deterministic lint report. Absent is stated, not hidden. */
  lint?: string;
  stakes?: string;
}

export interface CriticState {
  verdict: CriticVerdict | "SKIPPED";
  report: string;
  demo_mode: boolean;
}

/**
 * Below HIGH stakes this stage does not run.
 *
 * Core decides; the Application acts on the decision. Hoisted out of the call site so the
 * skip is a recorded, testable choice rather than a branch buried in an effect handler.
 */
export const shouldSkip = (input: CriticInput): boolean =>
  !CRITIC_STAKES.includes((input.stakes ?? "") as (typeof CRITIC_STAKES)[number]);

/**
 * Parse the verdict line.
 *
 * **Defaults to DEGRADED, never PASS**, and that asymmetry is the whole point: an
 * unparseable critic reply is a review that did not happen, and treating it as a pass would
 * let a malformed response certify a prompt. Ported from the source's `parseVerdict`.
 */
export function parseVerdict(text: string): CriticVerdict {
  const m = text.match(/VERDICT:\s*(PASS|DEGRADED|GATE_FAIL)/i);
  return m ? (m[1].toUpperCase() as CriticVerdict) : "DEGRADED";
}

/** The user turn, assembled at the call site in the source rather than from a template. */
export function buildPrompt(input: CriticInput): string {
  return `COMPILED SYSTEM PROMPT:\n\n${input.prompt}\n\n` +
         `LINT REPORT (already run, deterministic):\n${input.lint || "(not run)"}`;
}

export function decide(input: CriticInput, run_id: string): GenerationRequest {
  // Temperature is fixed at 0 in the source. `effort: "low"` is the nearest expression
  // available here — the contract has no temperature field, and inventing one to carry a
  // value no adapter reads would be worse than recording the gap.
  return buildRequest(run_id, STAGE_ID, buildPrompt(input), {
    system: CRITIC_SYSTEM,
    max_tokens: MAX_TOKENS.critic,
    effort: "low",
  });
}

export function reduce(
  input: CriticInput,
  outcome: GenerationResult | ProviderFailure,
): CriticState {
  // A forged marker is a provider failure, decided before the branch so every stage
  // inherits it through the placeholder path it already has.
  const settled = refuseForgedMarker(outcome);
  const isFailure = "category" in settled;
  if (isFailure) {
    const report = failurePlaceholder(STAGE_ID, input.prompt, settled as ProviderFailure);
    // DEGRADED, not PASS: a critic that never ran has certified nothing.
    return { verdict: "DEGRADED", report, demo_mode: true };
  }
  const report = (settled as GenerationResult).content;
  return { verdict: parseVerdict(report), report, demo_mode: false };
}

/** The skip path: no request was made, so nothing degraded and nothing was verified. */
export function reduceSkipped(): CriticState {
  return { verdict: "SKIPPED", report: SKIPPED_MESSAGE, demo_mode: false };
}
