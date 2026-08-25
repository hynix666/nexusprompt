// Ported from sources/v5/prompt_lint.py — "Gate 6", "Gate 10", and the provider advisory.
//
// The three arithmetic gates, kept together because they share the hazard the
// implementation plan names: cross-language numeric divergence that NO amount of parity
// testing can surface, because each side is internally consistent. Only the differential
// oracle sees it. Two rules carry the whole risk:
//
//   1. Token estimation is `max(1, len // 4)` with NO tokenizer. An ambient tiktoken
//      import made these three gates depend on what happened to be installed.
//   2. Rounding is `floor(x*100 + 0.5)/100`, never `Math.round` and never Python's
//      `round` — the latter is banker's rounding and the two disagree at .005.
//
// Both live in lint-primitives.ts so all three gates cannot drift apart from each other.

import {
  type GateOptions, sha256, result, estimateTokens, halfUp2,
  QUTM_CEILINGS, QUTM_MIN_BASELINE_TOKENS, PROVIDER_CONTEXT_LIMITS,
} from "./lint-primitives.js";
import type { GateResult } from "../../../contracts/index.js";

export const GATE_VERSION = "1.0.0";
export const TOKEN_BUDGET_GATE_ID = "TOKEN_BUDGET";
export const QUTM_GATE_ID = "QUTM_CEILING";
export const CONTEXT_LIMIT_GATE_ID = "CONTEXT_LIMIT";

/**
 * Estimated tokens must fit the declared budget.
 *
 * The armed test is `!== undefined`, NOT truthiness. A caller-supplied budget of 0 is an
 * explicit budget and must still run the check; the truthiness form silently skipped it,
 * which is a defect the source's changelog records fixing.
 */
export function tokenBudget(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  if (options.tokenBudget === undefined) {
    return result(TOKEN_BUDGET_GATE_ID, GATE_VERSION, "PASS",
      "No token budget declared; check not armed.", "TOKEN_BUDGET.not_armed", hash);
  }
  const est = estimateTokens(text);
  if (est <= options.tokenBudget) {
    return result(TOKEN_BUDGET_GATE_ID, GATE_VERSION, "PASS",
      `Estimated ${est} within budget ${options.tokenBudget}.`, "TOKEN_BUDGET.within", hash);
  }
  return result(TOKEN_BUDGET_GATE_ID, GATE_VERSION, "FAIL",
    `Estimated ${est} > budget ${options.tokenBudget}.`, "TOKEN_BUDGET.exceeded", hash);
}

/**
 * Cost ratio against a naive baseline must stay under the tier ceiling.
 *
 * `naiveTokens` repeats the same `undefined`-not-falsy discipline: an explicit 0 is a
 * baseline, and the truthiness form silently substituted 400 for it — the identical defect
 * fixed on TOKEN_BUDGET and left standing on its sibling parameter. `max(1, baseline)`
 * keeps the division safe, so an explicit 0 yields est/1.
 */
export function qutmCeiling(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  if (!options.stakes) {
    return result(QUTM_GATE_ID, GATE_VERSION, "PASS",
      "No stakes tier declared; check not armed.", "QUTM_CEILING.not_armed", hash);
  }
  const ceiling = QUTM_CEILINGS[options.stakes];
  if (ceiling === undefined) {
    // An unknown tier raises KeyError in the source rather than passing quietly. A gate
    // that silently passes on a misspelled tier is worse than one that refuses.
    return result(QUTM_GATE_ID, GATE_VERSION, "FAIL",
      `Unknown stakes tier "${options.stakes}". Expected one of: ${Object.keys(QUTM_CEILINGS).join(", ")}.`,
      "QUTM_CEILING.unknown_tier", hash);
  }
  const baseline = options.naiveTokens !== undefined ? options.naiveTokens : 400;

  // The baseline floor is checked AFTER the unknown-tier refusal, not before. A misspelled
  // tier is a configuration error and must be reported whatever the baseline is; letting a
  // short brief suppress it would hide the typo until someone supplied a long one.
  if (baseline < QUTM_MIN_BASELINE_TOKENS) {
    return result(QUTM_GATE_ID, GATE_VERSION, "PASS",
      `Baseline ${baseline} token(s) below the ${QUTM_MIN_BASELINE_TOKENS}-token floor; ` +
      `a cost ratio against a brief this short measures the brief, not the prompt. Check not armed.`,
      "QUTM_CEILING.baseline_too_small", hash);
  }

  const costRatio = halfUp2(estimateTokens(text) / Math.max(1, baseline));

  if (costRatio <= ceiling) {
    return result(QUTM_GATE_ID, GATE_VERSION, "PASS",
      `Cost ratio ${costRatio} within the ${ceiling}× ceiling for ${options.stakes}.`,
      "QUTM_CEILING.within", hash);
  }
  return result(QUTM_GATE_ID, GATE_VERSION, "FAIL",
    `Cost ratio ${costRatio} > ${ceiling} ceiling for ${options.stakes}.`,
    "QUTM_CEILING.exceeded", hash);
}

/** Provider context-limit advisory. WARN only — the estimate is heuristic. */
export function contextLimit(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const limit = options.provider ? PROVIDER_CONTEXT_LIMITS[options.provider] : undefined;
  if (limit === undefined) {
    // An unrecognised provider is not armed, matching the source's `provider in CONFIGS`.
    return result(CONTEXT_LIMIT_GATE_ID, GATE_VERSION, "PASS",
      "No known provider declared; check not armed.", "CONTEXT_LIMIT.not_armed", hash);
  }
  const est = estimateTokens(text);
  if (est <= limit) {
    return result(CONTEXT_LIMIT_GATE_ID, GATE_VERSION, "PASS",
      `Estimated ${est} within the ${options.provider} context limit.`, "CONTEXT_LIMIT.within", hash);
  }
  return result(CONTEXT_LIMIT_GATE_ID, GATE_VERSION, "WARN",
    `Estimated ${est} > ${options.provider} context limit ${limit}.`, "CONTEXT_LIMIT.exceeded", hash);
}
