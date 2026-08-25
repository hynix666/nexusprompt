/**
 * The gate registry.
 *
 * Every one of the seventeen prototypes in the AI APP collection hardcodes its
 * gate list, and not one of them grew past its author's original set. That is
 * the extensibility property (#7) failing in the most literal way available: the
 * list is the ceiling.
 *
 * Adding a gate here means writing its module and adding one line below. No
 * caller changes, no switch statement to extend, no shell that needs to learn a
 * new name. `runGates` returns whatever is registered.
 *
 * Pure. The registry holds functions, not effects — registration happens at
 * module load with no I/O.
 */

import type { GateResult } from "../../../contracts/index.js";
import { secretLeakScan, GATE_ID as SECRET_ID, GATE_VERSION as SECRET_V } from "./secret-leak-scan.js";
import { claimDiscipline, GATE_ID as CLAIM_ID, GATE_VERSION as CLAIM_V } from "./claim-discipline.js";
import {
  placeholderAudit, runtimeKeyUndeclared,
  PLACEHOLDER_GATE_ID, RUNTIME_KEY_GATE_ID, GATE_VERSION as PLACEHOLDER_V,
} from "./placeholder-audit.js";
import {
  sourceLedgerMissing, orphanClaims,
  LEDGER_GATE_ID, ORPHAN_GATE_ID, GATE_VERSION as LEDGER_V,
} from "./source-ledger.js";
import {
  guardrailGap, tokenSpam, recursionMachineryPresent, ragShieldGap,
  duplicateInstruction, delimiterEntropy,
  GUARDRAIL_GATE_ID, TOKEN_SPAM_GATE_ID, RECURSION_GATE_ID, RAG_SHIELD_GATE_ID,
  DUPLICATE_GATE_ID, DELIMITER_GATE_ID, GATE_VERSION as TEXT_V,
} from "./guardrail-gap.js";
import {
  tokenBudget, qutmCeiling, contextLimit,
  TOKEN_BUDGET_GATE_ID, QUTM_GATE_ID, CONTEXT_LIMIT_GATE_ID, GATE_VERSION as BUDGET_V,
} from "./budget.js";
import {
  adversarialResilience, GATE_ID as ADVERSARIAL_ID, GATE_VERSION as ADVERSARIAL_V,
} from "./adversarial-resilience.js";

export type { GateOptions } from "./lint-primitives.js";
import type { GateOptions } from "./lint-primitives.js";

export interface Gate {
  readonly id: string;
  readonly version: string;
  run(text: string, options: GateOptions): GateResult;
}

/**
 * The registered set. Ordered for stable output — two runs over the same input
 * must produce results in the same order, or the determinism property (#10)
 * fails on something as trivial as iteration order.
 */
const GATES: readonly Gate[] = Object.freeze([
  { id: SECRET_ID, version: SECRET_V, run: (t, o) => secretLeakScan(t, o) },
  { id: CLAIM_ID, version: CLAIM_V, run: (t, o) => claimDiscipline(t, o) },
  { id: PLACEHOLDER_GATE_ID, version: PLACEHOLDER_V, run: (t, o) => placeholderAudit(t, o) },
  { id: RUNTIME_KEY_GATE_ID, version: PLACEHOLDER_V, run: (t, o) => runtimeKeyUndeclared(t, o) },
  { id: LEDGER_GATE_ID, version: LEDGER_V, run: (t, o) => sourceLedgerMissing(t, o) },
  { id: ORPHAN_GATE_ID, version: LEDGER_V, run: (t, o) => orphanClaims(t, o) },
  { id: GUARDRAIL_GATE_ID, version: TEXT_V, run: (t, o) => guardrailGap(t, o) },
  { id: TOKEN_SPAM_GATE_ID, version: TEXT_V, run: (t, o) => tokenSpam(t, o) },
  { id: RECURSION_GATE_ID, version: TEXT_V, run: (t, o) => recursionMachineryPresent(t, o) },
  { id: RAG_SHIELD_GATE_ID, version: TEXT_V, run: (t, o) => ragShieldGap(t, o) },
  { id: DUPLICATE_GATE_ID, version: TEXT_V, run: (t, o) => duplicateInstruction(t, o) },
  { id: DELIMITER_GATE_ID, version: TEXT_V, run: (t, o) => delimiterEntropy(t, o) },
  { id: TOKEN_BUDGET_GATE_ID, version: BUDGET_V, run: (t, o) => tokenBudget(t, o) },
  { id: QUTM_GATE_ID, version: BUDGET_V, run: (t, o) => qutmCeiling(t, o) },
  { id: CONTEXT_LIMIT_GATE_ID, version: BUDGET_V, run: (t, o) => contextLimit(t, o) },
  { id: ADVERSARIAL_ID, version: ADVERSARIAL_V, run: (t, o) => adversarialResilience(t, o) },
]);

/** Every registered gate, in stable order. */
export function listGates(): readonly Gate[] {
  return GATES;
}

/** Run the full registered set over one input. */
export function runGates(text: string, options: GateOptions = {}): GateResult[] {
  return GATES.map((g) => g.run(text, options));
}

/** Run one gate by id. Throws on an unknown id rather than silently returning nothing. */
export function runGate(id: string, text: string, options: GateOptions = {}): GateResult {
  const gate = GATES.find((g) => g.id === id);
  if (!gate) {
    throw new Error(
      `Unknown gate "${id}". Registered: ${GATES.map((g) => g.id).join(", ")}.`,
    );
  }
  return gate.run(text, options);
}

/**
 * The source linter's gate count, and the number registered above — the port is complete.
 * `scripts/differential.ts` fails when the two disagree, so this cannot drift silently
 * from what the frozen linter actually emits.
 */
export const SOURCE_GATE_COUNT = 16;
